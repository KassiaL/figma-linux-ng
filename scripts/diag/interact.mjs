#!/usr/bin/env node
// Reads the WebGPU/WebGL counters of a Figma tab (app started with --webgpu-diag),
// then zooms the canvas with Ctrl+wheel and reads them again: a renderer that is
// really in use must produce new frames for the zoom.
//   node scripts/diag/interact.mjs <url-substring>
const port = process.env.CDP_PORT || 9333;
const match = process.argv[2] || "figma.com/design";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const t = list.find((x) => x.type === "page" && x.url.includes(match));
if (!t) throw new Error("no tab " + match);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) pending.get(msg.id)?.(msg);
};
const send = (method, params = {}) =>
  new Promise((r) => {
    pending.set(++id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.result.value;
const stats = () =>
  evaluate(`new Promise(r => { document.addEventListener('__flng_gpu_stats', e => r(JSON.parse(e.detail)), {once:true}); document.dispatchEvent(new Event('__flng_gpu_stats:request')); setTimeout(() => r(null), 3000); })`);

const before = await stats();
const { w, h } = await evaluate(`({ w: innerWidth, h: innerHeight })`);
for (let i = 0; i < 12; i++) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: i < 6 ? -120 : 120, modifiers: 2,
  });
  await new Promise((r) => setTimeout(r, 120));
}
await new Promise((r) => setTimeout(r, 1500));
const after = await stats();
const ua = await evaluate("navigator.userAgent");
console.log(JSON.stringify({ ua, before, after }, null, 1));
ws.close();
