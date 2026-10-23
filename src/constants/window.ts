import type { BrowserWindowConstructorOptions, WebPreferences } from "electron";

// Window that hosts the local tab panel (trusted local file only; tabs are separate views).
// nodeIntegration stays on for the Svelte panel, which talks to ipcRenderer directly;
// the panel never loads remote content (navigation is locked in Main/Session).
export const WINDOW_DEFAULT_OPTIONS: BrowserWindowConstructorOptions = {
  width: 1200,
  height: 900,
  frame: false,
  resizable: true,
  show: false,
  backgroundColor: "#2c2c2c",
  webPreferences: {
    sandbox: false,
    zoomFactor: 1,
    nodeIntegration: true,
    nodeIntegrationInWorker: false,
    webviewTag: false,
    contextIsolation: false,
    spellcheck: false,
  },
};

// Remote Figma content: isolated, sandboxed, no Node.js. The preload only bridges
// Figma's desktop API (window.__figmaDesktop) over a MessagePort + ipcRenderer.
export const FIGMA_WEB_PREFERENCES: WebPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  zoomFactor: 1,
  backgroundThrottling: true,
};

export const DEFAULT_WIN_OPTIONS: Types.WindowState = {
  x: -1,
  y: -1,
  width: 1200,
  height: 900,
  isMaximized: false,
  lastActiveTabPath: "",
  hasOpenedCommunityTab: false,
  userId: "",
  tabs: [],
};
