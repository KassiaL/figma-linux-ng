/**
 * Runtime diagnostics for the shell: process memory/CPU, GPU state, WebGPU usage
 * reported by the (opt-in) page instrumentation, project load timings and
 * network errors. Nothing here changes how Figma renders.
 *
 * Entry points: Help menu ("Diagnostics...", "Save Diagnostics Report",
 * "Record GPU Trace"), and CLI flags for unattended checks:
 *   --diag-report=<file.json>  write a report after --diag-delay=<s> (default 60)
 *   --diag-exit                quit after writing that report
 *   --diag-trace=<file>        record a Chromium GPU trace (Perfetto) during the delay
 *   --webgpu-diag              enable the WebGPU/WebGL call counters for this run
 *   --diag-no-desktop-bridge   test-only: no window.__figmaDesktop (anonymous viewing of public files)
 */
import { app, BrowserWindow, contentTracing, dialog, ipcMain, session, webContents, WebContents } from "electron";
import type { IpcMainEvent } from "electron";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { cliArg, cliFlag, paths } from "./bootstrap";
import { appliedGpuPlan } from "./Gpu";
import { logger } from "./Logger";
import { storage } from "./Storage";
import { isFigmaOrigin } from "Utils/Common";
import { isLocalAppSender } from "Utils/Main";

interface LoadTiming {
  url: string;
  navigationStart: number;
  domReady?: number;
  didFinishLoad?: number;
  figmaLoaded?: number; // Figma's own setLoading(false) for a file
  failed?: string;
}

interface NetError {
  at: number;
  url: string;
  error?: string;
  status?: number;
  resourceType?: string;
}

const MAX_SAMPLES = 120;
const MAX_NET_ERRORS = 300;

const run = (cmd: string, args: string[], timeout = 3000) =>
  new Promise<string | null>((resolve) => {
    execFile(cmd, args, { timeout }, (error, stdout) => resolve(error ? null : stdout));
  });

const mb = (kb: number) => Math.round((kb / 1024) * 10) / 10;

export default class Diagnostics {
  private webgpuStats = new Map<number, any>();
  private loads = new Map<number, LoadTiming[]>();
  private netErrors: NetError[] = [];
  private netErrorCounts = new Map<string, number>();
  private crashes: Array<{ at: number; type: string; reason: string; exitCode?: number; url?: string }> = [];
  private unresponsive = new Map<number, number>();
  private samples: any[] = [];
  private sampler: NodeJS.Timeout | undefined;
  private window: BrowserWindow | undefined;
  private readonly startedAt = Date.now();
  private firstWindowShownAt: number | undefined;
  readonly instrumentation = storage.settings.app.webgpuInstrumentation || cliFlag("webgpu-diag");

  constructor() {
    ipcMain.on("getPreloadConfig", (event: IpcMainEvent) => {
      // --diag-no-desktop-bridge: test-only, makes tabs behave like a plain browser
      // (Figma's desktop mode refuses to open files without a signed-in user).
      event.returnValue = { webgpuInstrumentation: this.instrumentation, desktopBridge: !cliFlag("diag-no-desktop-bridge") };
    });
    ipcMain.on("diag:webgpuStats", (event: IpcMainEvent, json: string) => {
      try {
        this.webgpuStats.set(event.sender.id, JSON.parse(json));
      } catch {
        /* ignore malformed */
      }
    });
    ipcMain.on("diag:setLoading", (event: IpcMainEvent, args: { loading: boolean }) => {
      const timing = this.currentLoad(event.sender.id);
      if (timing && !args?.loading && timing.figmaLoaded === undefined) {
        timing.figmaLoaded = Date.now() - timing.navigationStart;
        logger.info(`[diag] project loaded in ${timing.figmaLoaded} ms: ${timing.url}`);
      }
    });
    ipcMain.handle("diag:snapshot", (event) => (isLocalAppSender(event) ? this.snapshot() : null));
    ipcMain.handle("diag:saveReport", (event) => (isLocalAppSender(event) ? this.saveReport() : null));
    ipcMain.handle("diag:recordTrace", (event, seconds: number) =>
      isLocalAppSender(event) ? this.recordTrace(Math.min(Math.max(seconds || 10, 2), 60)) : null,
    );

    app.on("web-contents-created", (_, contents) => this.track(contents));
    app.on("child-process-gone", (_, details) => {
      this.crashes.push({ at: Date.now(), type: details.type, reason: details.reason, exitCode: details.exitCode });
      logger.error(`[diag] child process gone: ${details.type} ${details.reason} (${details.exitCode})`);
    });
    app.on("browser-window-created", (_, win) => {
      win.once("show", () => {
        this.firstWindowShownAt ??= Date.now() - this.startedAt;
      });
    });
    app.on("openDiagnostics", () => this.openWindow());
    app.on("saveDiagnosticsReport", () => this.saveReport(true));
    app.on("recordGpuTrace", () => this.recordTrace(10, true));
  }

  public handleAppReady() {
    const ses = session.defaultSession;

    ses.webRequest.onErrorOccurred((d) => {
      // cancelled requests and only-if-cached probes are not failures
      if (d.error === "net::ERR_ABORTED" || d.error === "net::ERR_CACHE_MISS") return;
      this.pushNetError({ at: Date.now(), url: d.url, error: d.error, resourceType: d.resourceType });
    });
    ses.webRequest.onCompleted((d) => {
      if (d.statusCode >= 400) {
        this.pushNetError({ at: Date.now(), url: d.url, status: d.statusCode, resourceType: d.resourceType });
      }
    });

    this.sampler = setInterval(() => this.sample(), 5000);
    this.sampler.unref?.();

    const reportPath = cliArg("diag-report");
    const tracePath = cliArg("diag-trace");
    const delay = Number(cliArg("diag-delay") ?? 60) * 1000;
    if (tracePath) {
      contentTracing
        .startRecording(this.traceConfig())
        .then(() => setTimeout(() => this.stopTrace(tracePath), delay))
        .catch((e) => logger.error("[diag] trace failed:", e));
    }
    if (reportPath) {
      setTimeout(async () => {
        await this.saveReport(false, reportPath);
        if (cliFlag("diag-exit")) app.emit("quitApp");
      }, delay + (tracePath ? 3000 : 0));
    }
  }

  private pushNetError(e: NetError) {
    let host = "";
    try {
      host = new URL(e.url).host;
    } catch {
      /* ignore */
    }
    const key = `${host} ${e.error ?? e.status}`;
    this.netErrorCounts.set(key, (this.netErrorCounts.get(key) ?? 0) + 1);
    this.netErrors.push(e);
    if (this.netErrors.length > MAX_NET_ERRORS) this.netErrors.shift();
  }

  private currentLoad(id: number) {
    const list = this.loads.get(id);
    return list?.[list.length - 1];
  }

  private track(contents: WebContents) {
    const id = contents.id;

    contents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument || !isFigmaOrigin(details.url)) return;
      const list = this.loads.get(id) ?? [];
      list.push({ url: details.url, navigationStart: Date.now() });
      if (list.length > 20) list.shift();
      this.loads.set(id, list);
      this.webgpuStats.delete(id);
    });
    contents.on("dom-ready", () => {
      const t = this.currentLoad(id);
      if (t && t.domReady === undefined) t.domReady = Date.now() - t.navigationStart;
    });
    contents.on("did-finish-load", () => {
      const t = this.currentLoad(id);
      if (t && t.didFinishLoad === undefined) t.didFinishLoad = Date.now() - t.navigationStart;
    });
    contents.on("did-fail-load", (_, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted
      const t = this.currentLoad(id);
      if (t) t.failed = `${code} ${description}`;
      this.pushNetError({ at: Date.now(), url, error: `${code} ${description}`, resourceType: "mainFrame" });
    });
    contents.on("render-process-gone", (_, details) => {
      this.crashes.push({
        at: Date.now(),
        type: "renderer",
        reason: details.reason,
        exitCode: details.exitCode,
        url: contents.isDestroyed() ? "" : contents.getURL(),
      });
    });
    contents.on("unresponsive", () => this.unresponsive.set(id, (this.unresponsive.get(id) ?? 0) + 1));
    contents.once("destroyed", () => {
      this.webgpuStats.delete(id);
      this.loads.delete(id);
      this.unresponsive.delete(id);
    });
  }

  private processes() {
    const owners = new Map<number, { id: number; url: string; title: string }[]>();

    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      const pid = wc.getOSProcessId();
      const list = owners.get(pid) ?? [];
      list.push({ id: wc.id, url: wc.getURL().slice(0, 160), title: wc.getTitle().slice(0, 80) });
      owners.set(pid, list);
    }

    return app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      serviceName: m.serviceName,
      cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
      idleWakeupsPerSecond: m.cpu.idleWakeupsPerSecond,
      workingSetMB: mb(m.memory.workingSetSize),
      peakWorkingSetMB: mb(m.memory.peakWorkingSetSize),
      privateMB: m.memory.privateBytes !== undefined ? mb(m.memory.privateBytes) : undefined,
      // ProcessMetric.sandboxed is macOS/Windows only; on Linux use the seccomp mode.
      sandboxed: m.sandboxed ?? this.seccomp(m.pid),
      webContents: owners.get(m.pid) ?? [],
    }));
  }

  private seccomp(pid: number): boolean | undefined {
    try {
      const mode = /Seccomp:\s+(\d)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
      return mode === undefined ? undefined : mode === "2";
    } catch {
      return undefined;
    }
  }

  private async nvidia() {
    const gpu = await run("nvidia-smi", [
      "--query-gpu=name,driver_version,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr",
      "--format=csv,noheader,nounits",
    ]);
    if (!gpu) return null;

    const [name, driver, util, memUtil, memUsed, memTotal, temp, power, clock] = gpu.trim().split(/,\s*/);
    const ourPids = new Set(app.getAppMetrics().map((m) => m.pid));
    // The plain table also lists graphics ("G") clients with their VRAM.
    const table = (await run("nvidia-smi", [])) ?? "";
    const perProcess = [...table.matchAll(/^\|\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(C|G|C\+G)\s+(.+?)\s+(\d+)MiB\s+\|$/gm)]
      .map((m) => ({ pid: Number(m[1]), type: m[2], name: m[3].trim().slice(-60), vramMB: Number(m[4]) }))
      .filter((p) => ourPids.has(p.pid));

    return {
      name,
      driver,
      utilizationGpuPercent: Number(util),
      utilizationMemoryPercent: Number(memUtil),
      memoryUsedMB: Number(memUsed),
      memoryTotalMB: Number(memTotal),
      temperatureC: Number(temp),
      powerW: Number(power),
      graphicsClockMHz: Number(clock),
      thisAppProcesses: perProcess,
    };
  }

  private async sample() {
    const procs = app.getAppMetrics();
    const byType: Record<string, { count: number; workingSetMB: number; cpuPercent: number }> = {};
    for (const m of procs) {
      const t = (byType[m.type] ??= { count: 0, workingSetMB: 0, cpuPercent: 0 });
      t.count++;
      t.workingSetMB += mb(m.memory.workingSetSize);
      t.cpuPercent += m.cpu.percentCPUUsage;
    }
    const total = procs.reduce((s, m) => s + m.memory.workingSetSize, 0);

    this.samples.push({ t: Date.now(), totalWorkingSetMB: mb(total), byType });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  public async snapshot() {
    let gpuBasic: any = {};
    try {
      gpuBasic = await app.getGPUInfo("basic");
    } catch (e) {
      gpuBasic = { error: String(e) };
    }

    const tabs = webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && isFigmaOrigin(wc.getURL()))
      .map((wc) => ({
        id: wc.id,
        pid: wc.getOSProcessId(),
        url: wc.getURL().slice(0, 200),
        title: wc.getTitle().slice(0, 100),
        backgroundThrottling: wc.getBackgroundThrottling(),
        loads: this.loads.get(wc.id) ?? [],
        unresponsiveEvents: this.unresponsive.get(wc.id) ?? 0,
        webgpu: this.webgpuStats.get(wc.id) ?? null,
        verdict: this.verdict(this.webgpuStats.get(wc.id)),
      }));

    return {
      generatedAt: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      app: {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        session: process.env.XDG_SESSION_TYPE,
        userData: paths.userData,
        cacheDir: paths.cacheDir,
        firstWindowShownMs: this.firstWindowShownAt,
        commandLine: process.argv.slice(1).filter((a) => a.startsWith("--")),
      },
      gpu: {
        plan: appliedGpuPlan,
        featureStatus: app.getGPUFeatureStatus(),
        // From the kernel (seccomp mode of the GPU process). getGPUInfo("basic").sandboxed is
        // collected before the GPU sandbox starts and stays false; chrome://gpu shows the real value.
        gpuProcessSandboxed: this.seccomp(app.getAppMetrics().find((m) => m.type === "GPU")?.pid ?? -1),
        hardwareSupportsVulkan: gpuBasic?.auxAttributes?.hardwareSupportsVulkan,
        devices: gpuBasic?.gpuDevice,
        nvidia: await this.nvidia(),
      },
      webgpuInstrumentation: this.instrumentation,
      processes: this.processes(),
      memoryHistory: this.samples,
      tabs,
      network: {
        errorCounts: Object.fromEntries([...this.netErrorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50)),
        recentErrors: this.netErrors.slice(-50),
      },
      crashes: this.crashes,
    };
  }

  /** What the counters actually show; "unknown" without instrumentation data. */
  private verdict(s: any): string {
    if (!s) return this.instrumentation ? "no data yet" : "instrumentation disabled";
    // Figma's WebGPU compatibility probe draws a few frames into tiny offscreen canvases;
    // that is not editor rendering. Editor rendering = a large on-page canvas + many submits.
    const editorWebgpuCanvas = (s.canvases ?? []).some((c: any) => c.type === "webgpu" && !c.offscreen && c.width >= 300);
    const webgpuActive = editorWebgpuCanvas && s.webgpuSubmits > 10 && s.webgpuGetCurrentTexture > 0;
    const webglActive = s.webglDrawCalls > 50;
    if (webgpuActive && !webglActive) return "WebGPU (submits + canvas frames, no WebGL draws)";
    if (webglActive && !webgpuActive) {
      return s.adapters?.length ? "WebGL (Figma only probed WebGPU, draws with WebGL)" : "WebGL";
    }
    if (webgpuActive && webglActive) return "mixed (both WebGPU frames and WebGL draws)";
    if (s.transferControlToOffscreen > 0) return "rendering moved to a worker (OffscreenCanvas): not visible to main-thread counters";
    return "no rendering observed yet";
  }

  public async saveReport(interactive = false, target?: string) {
    const dir = path.join(paths.userData, "diagnostics");
    const file = target ?? path.join(dir, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(await this.snapshot(), null, 2));
    logger.info("[diag] report written:", file);

    if (interactive) {
      dialog.showMessageBox({ type: "info", title: "Diagnostics", message: "Diagnostics report saved", detail: file });
    }
    return file;
  }

  private traceConfig() {
    return {
      included_categories: ["gpu", "gpu.dawn", "webgpu", "viz", "cc", "blink", "disabled-by-default-gpu.dawn"],
      excluded_categories: ["*"],
    };
  }

  private async stopTrace(file?: string) {
    const out = await contentTracing.stopRecording(file);
    logger.info("[diag] GPU trace written:", out);
    return out;
  }

  public async recordTrace(seconds: number, interactive = false) {
    const file = path.join(paths.userData, "diagnostics", `gpu-trace-${Date.now()}.pftrace`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await contentTracing.startRecording(this.traceConfig());
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const out = await this.stopTrace(file);

    if (interactive) {
      dialog.showMessageBox({
        type: "info",
        title: "GPU trace",
        message: "GPU trace recorded",
        detail: `${out}\n\nOpen it in https://ui.perfetto.dev (look for WebGPU/Dawn slices in the GPU process).`,
      });
    }
    return out;
  }

  private openWindow() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return;
    }

    this.window = new BrowserWindow({
      width: 1100,
      height: 800,
      title: "Figma Linux NG — Diagnostics",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "..", "renderer", "diagnosticsPreload.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.loadFile(path.join(__dirname, "..", "diagnostics.html"));
  }
}
