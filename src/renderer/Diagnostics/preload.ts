import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("diag", {
  snapshot: () => ipcRenderer.invoke("diag:snapshot"),
  saveReport: () => ipcRenderer.invoke("diag:saveReport"),
  recordTrace: (seconds: number) => ipcRenderer.invoke("diag:recordTrace", seconds),
});
