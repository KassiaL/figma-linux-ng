#!/usr/bin/env node
// Minimal Chrome DevTools Protocol client for checking a running Figma Linux NG
// started with --remote-debugging-port=<port> (default 9333). No dependencies.
//
//   node scripts/diag/cdp.mjs list
//   node scripts/diag/cdp.mjs eval  <url-substring> "<js expression>"
//   node scripts/diag/cdp.mjs shot  <url-substring> out.png
//   node scripts/diag/cdp.mjs nav   <url-substring> <url>
const port = process.env.CDP_PORT || 9333;
const [cmd, match, arg] = process.argv.slice(2);

const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

async function session(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const listeners = [];
  const prev = ws.onmessage;
  ws.onmessage = (m) => {
    prev(m);
    const msg = JSON.parse(m.data);
    if (msg.method) listeners.forEach((l) => l(msg));
  };
  return { send, on: (l) => listeners.push(l), close: () => ws.close() };
}

const pick = async () => {
  const list = (await targets()).filter((t) => t.type === "page" && t.url.includes(match ?? ""));
  if (!list.length) throw new Error(`no page target matching "${match}"`);
  return list[0];
};

if (cmd === "list") {
  for (const t of await targets()) console.log(t.type.padEnd(8), t.id.slice(0, 8), t.url.slice(0, 140));
} else if (cmd === "eval") {
  const s = await session(await pick());
  const r = await s.send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2));
  s.close();
} else if (cmd === "shot") {
  const s = await session(await pick());
  const r = await s.send("Page.captureScreenshot", { format: "png" });
  const fs = await import("node:fs");
  fs.writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log("saved", arg);
  s.close();
} else if (cmd === "console") {
  // Reload the page and print console errors/warnings and exceptions for N seconds.
  const seconds = Number(process.argv[5] || 20);
  const s = await session(await pick());
  s.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      console.log("EXCEPTION", d.exception?.description?.slice(0, 400) ?? d.text, d.url ?? "");
    } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning", ...(arg === "all" ? ["log", "info"] : [])].includes(msg.params.type)) {
      console.log(msg.params.type.toUpperCase(), msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400));
    } else if (msg.method === "Log.entryAdded" && ["error", "warning"].includes(msg.params.entry.level)) {
      console.log("LOG", msg.params.entry.level, msg.params.entry.text.slice(0, 300), msg.params.entry.url ?? "");
    }
  });
  await s.send("Runtime.enable");
  await s.send("Log.enable");
  await s.send("Page.reload", { ignoreCache: false });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  s.close();
} else if (cmd === "nav") {
  const s = await session(await pick());
  await s.send("Page.navigate", { url: arg });
  s.close();
} else {
  console.log("usage: list | eval <match> <expr> | shot <match> <file> | nav <match> <url>");
}
