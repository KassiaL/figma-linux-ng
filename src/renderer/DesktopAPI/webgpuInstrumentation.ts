/**
 * Opt-in (settings.app.webgpuInstrumentation or --webgpu-diag) passive counters
 * that show which graphics API the Figma editor actually renders with.
 *
 * Injected into the page's main world before any page script runs. It only
 * counts calls and forwards them unchanged: it never alters arguments, return
 * values or the backend Figma picks. Having navigator.gpu or a GPUAdapter is not
 * treated as proof of use: the evidence is GPUQueue.submit / getCurrentTexture
 * activity on a canvas versus WebGL draw calls.
 *
 * Must stay self-contained: it is serialized with Function.prototype.toString().
 */
export function installWebGpuInstrumentation(eventName: string) {
  const w = window as any;
  if (w.__flngGpuInstrumented) return;
  w.__flngGpuInstrumented = true;

  const now = () => Math.round(performance.now());
  const S: any = {
    url: location.href,
    navigatorGpu: "gpu" in navigator,
    requestAdapterCalls: 0,
    adapterNull: 0,
    adapters: [] as any[],
    requestDeviceCalls: 0,
    devicesCreated: 0,
    deviceLost: [] as string[],
    uncapturedErrors: 0,
    contexts: {} as Record<string, number>,
    canvases: [] as any[],
    webgpuConfigure: 0,
    webgpuGetCurrentTexture: 0,
    webgpuSubmits: 0,
    webgpuCommandBuffers: 0,
    webgpuPipelines: 0,
    webglDrawCalls: 0,
    transferControlToOffscreen: 0,
    firstWebgpuSubmitAt: null as number | null,
    lastWebgpuSubmitAt: null as number | null,
    firstWebglDrawAt: null as number | null,
    lastWebglDrawAt: null as number | null,
  };

  const wrap = (proto: any, name: string, make: (orig: any) => any) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== "function") return;
    const orig = desc.value;
    const wrapped = make(orig);
    // Keep the native-looking name/length for code that inspects functions.
    Object.defineProperty(wrapped, "name", { value: orig.name });
    Object.defineProperty(wrapped, "length", { value: orig.length });
    Object.defineProperty(proto, name, { ...desc, value: wrapped });
  };

  const G = w.GPU?.prototype;
  wrap(G, "requestAdapter", (orig: any) =>
    function (this: any, ...args: any[]) {
      S.requestAdapterCalls++;
      const opts = args[0] || {};
      return orig.apply(this, args).then((adapter: any) => {
        if (!adapter) S.adapterNull++;
        else {
          const info = adapter.info || {};
          S.adapters.push({
            at: now(),
            powerPreference: opts.powerPreference,
            forceFallbackAdapter: !!opts.forceFallbackAdapter,
            vendor: info.vendor,
            architecture: info.architecture,
            description: info.description,
            isFallbackAdapter: info.isFallbackAdapter,
            features: adapter.features ? adapter.features.size : undefined,
          });
        }
        return adapter;
      });
    },
  );
  wrap(w.GPUAdapter?.prototype, "requestDevice", (orig: any) =>
    function (this: any, ...args: any[]) {
      S.requestDeviceCalls++;
      return orig.apply(this, args).then((device: any) => {
        S.devicesCreated++;
        try {
          device.lost.then((info: any) => S.deviceLost.push(`${info.reason}: ${info.message}`));
          device.addEventListener("uncapturederror", () => S.uncapturedErrors++);
        } catch (_) {
          /* ignore */
        }
        return device;
      });
    },
  );
  wrap(w.GPUQueue?.prototype, "submit", (orig: any) =>
    function (this: any, buffers: any) {
      S.webgpuSubmits++;
      S.webgpuCommandBuffers += buffers?.length || 0;
      const t = now();
      if (S.firstWebgpuSubmitAt === null) S.firstWebgpuSubmitAt = t;
      S.lastWebgpuSubmitAt = t;
      return orig.call(this, buffers);
    },
  );
  wrap(w.GPUCanvasContext?.prototype, "configure", (orig: any) =>
    function (this: any, cfg: any) {
      S.webgpuConfigure++;
      return orig.call(this, cfg);
    },
  );
  wrap(w.GPUCanvasContext?.prototype, "getCurrentTexture", (orig: any) =>
    function (this: any) {
      S.webgpuGetCurrentTexture++;
      return orig.call(this);
    },
  );
  wrap(w.GPUDevice?.prototype, "createRenderPipeline", (orig: any) =>
    function (this: any, d: any) {
      S.webgpuPipelines++;
      return orig.call(this, d);
    },
  );

  const countContext = (canvas: any, type: string, ctx: any) => {
    if (!ctx) return;
    S.contexts[type] = (S.contexts[type] || 0) + 1;
    if (S.canvases.length < 20 && type !== "2d") {
      S.canvases.push({ type, width: canvas.width, height: canvas.height, offscreen: !canvas.isConnected, at: now() });
    }
  };
  for (const C of [w.HTMLCanvasElement, w.OffscreenCanvas]) {
    wrap(C?.prototype, "getContext", (orig: any) =>
      function (this: any, type: string, ...rest: any[]) {
        const ctx = orig.call(this, type, ...rest);
        countContext(this, type === "experimental-webgl" ? "webgl" : type, ctx);
        return ctx;
      },
    );
  }
  wrap(w.HTMLCanvasElement?.prototype, "transferControlToOffscreen", (orig: any) =>
    function (this: any) {
      S.transferControlToOffscreen++;
      return orig.call(this);
    },
  );

  const drawNames = ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"];
  for (const C of [w.WebGLRenderingContext, w.WebGL2RenderingContext]) {
    for (const name of drawNames) {
      wrap(C?.prototype, name, (orig: any) =>
        function (this: any, ...args: any[]) {
          S.webglDrawCalls++;
          const t = now();
          if (S.firstWebglDrawAt === null) S.firstWebglDrawAt = t;
          S.lastWebglDrawAt = t;
          return orig.apply(this, args);
        },
      );
    }
  }

  // Hand a JSON snapshot to the isolated preload world every 2 s (strings cross worlds),
  // or immediately on `${eventName}:request` (used by scripts/diag tools).
  let last = "";
  document.addEventListener(`${eventName}:request`, () => {
    S.url = location.href;
    document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(S) }));
  });
  setInterval(() => {
    S.url = location.href;
    const json = JSON.stringify(S);
    if (json !== last) {
      last = json;
      document.dispatchEvent(new CustomEvent(eventName, { detail: json }));
    }
  }, 2000);
}
