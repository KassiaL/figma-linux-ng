// Standalone WebGPU probe for Electron. Usage:
//   electron scripts/diag/webgpu-probe -- [--probe-flags="a|b=c,d"] [--probe-out=file.json] [--probe-sandbox]
// Applies the given Chromium switches before app ready, renders a WebGPU triangle,
// reads back pixels to prove it rendered, and dumps app.getGPUInfo('complete').
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const flags = (arg("probe-flags") || "").split("|").filter(Boolean);
for (const f of flags) {
  const [k, ...v] = f.split("=");
  v.length ? app.commandLine.appendSwitch(k, v.join("=")) : app.commandLine.appendSwitch(k);
}
const out = arg("probe-out");
app.setPath("userData", path.join(app.getPath("temp"), "webgpu-probe-profile"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420, height: 420, show: !process.argv.includes("--probe-hidden"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  const timer = setTimeout(() => finish({ error: "timeout" }), 20000);
  ipcMain.once("result", async (_e, r) => { clearTimeout(timer); finish(r); });
  async function finish(r) {
    let gpu = {};
    try { gpu = await app.getGPUInfo("complete"); } catch (e) { gpu = { error: String(e) }; }
    // Linux sandbox evidence per child process: seccomp mode + PID namespace differs from browser.
    const selfNs = (() => { try { return fs.readlinkSync("/proc/self/ns/pid"); } catch { return ""; } })();
    const procs = app.getAppMetrics().map((m) => {
      let seccomp, ns;
      try { seccomp = /Seccomp:\s+(\d)/.exec(fs.readFileSync(`/proc/${m.pid}/status`, "utf8"))?.[1]; } catch {}
      try { ns = fs.readlinkSync(`/proc/${m.pid}/ns/pid`) !== selfNs; } catch { ns = "unreadable(sandboxed)"; }
      return { type: m.type, pid: m.pid, seccomp, ownPidNamespace: ns };
    });
    let basic = {};
    try { basic = await app.getGPUInfo("basic"); } catch {}
    const res = { procs, glRenderer: basic.auxAttributes?.glRenderer, glImpl: basic.auxAttributes?.glImplementationParts, electron: process.versions.electron, chrome: process.versions.chrome, flags,
      featureStatus: app.getGPUFeatureStatus(), page: r,
      gl: { renderer: gpu.auxAttributes?.glRenderer, vendor: gpu.auxAttributes?.glVendor,
            version: gpu.auxAttributes?.glVersion, glImpl: gpu.auxAttributes?.glImplementationParts,
            vulkan: !!gpu.vulkanInfo || undefined,
            devices: gpu.gpuDevice?.map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active, driver: d.driverVersion })) } };
    const s = JSON.stringify(res, null, 2);
    out ? fs.writeFileSync(out, s) : console.log(s);
    app.quit();
  }
  win.loadFile(path.join(__dirname, "index.html"));
});
