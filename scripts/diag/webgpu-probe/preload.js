const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("probe", { done: (r) => ipcRenderer.send("result", r) });
