// pan-bench.mjs <url-substring> <seconds>: continuous wheel-panning of the Figma canvas via CDP,
// counts frames the page produced (rAF) and Figma's WebGL/WebGPU work if instrumented.
const [match, secs = "6"] = process.argv.slice(2);
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const t = list.find((p) => p.type === "page" && p.url.includes(match));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.result.value;
await send("Page.bringToFront");
const { w, h } = await ev("({ w: innerWidth, h: innerHeight })");
await ev("window.__frames = 0; (function f(){ window.__frames++; requestAnimationFrame(f) })(); 1");
const f0 = await ev("window.__frames");
const end = Date.now() + Number(secs) * 1000;
let i = 0, sent = 0;
while (Date.now() < end) {
  const dy = (Math.floor(i / 30) % 2 ? -1 : 1) * 60; // 30 events one way, 30 back
  send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(w / 2), y: Math.round(h / 2), deltaX: dy / 2, deltaY: dy });
  i++; sent++;
  await new Promise((r) => setTimeout(r, 16));
}
const f1 = await ev("window.__frames");
console.log(JSON.stringify({ fps: Math.round(((f1 - f0) / Number(secs)) * 10) / 10, wheelEvents: sent, viewport: `${w}x${h}` }));
ws.close();
