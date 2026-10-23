/**
 * Preload for Figma web content (sandboxed, context-isolated).
 *
 * Figma's web app looks for `window.__figmaDesktop` and talks to it through a
 * MessagePort. The object is created in the page's main world with
 * contextBridge.executeInMainWorld (synchronous, before page scripts run); the
 * port's other end stays here, in the isolated world, and forwards to ipcRenderer.
 * No Node.js APIs are available here (Electron 45 sandboxed preload).
 */
import type { IpcRendererEvent } from "electron";
import * as E from "electron";

import { sendMsgToMain, registerCallbackWithMainProcess } from "Utils/Render";
import { themes } from "./ThemesApplier";
import { installWebGpuInstrumentation } from "./webgpuInstrumentation";
import { isPrototypeUrl, isValidFigjamLink, isValidProjectLink } from "Utils/Common";

const GPU_STATS_EVENT = "__flng_gpu_stats";

interface IntiApiOptions {
  version: number;
  appVersion: string;
  fileBrowser: boolean;
}

const API_VERSION = 111;
const APP_VERSION = '999.0.0';
let webPort: MessagePort;
const mainProcessCancelCallbacks: Map<number, () => void> = new Map();

const onWebMessage = (event: MessageEvent) => {
  const msg = event.data;

  if (!msg) return;

  if (msg.callbackID != null) {
    const cancel = registerCallbackWithMainProcess(msg.name, msg.args, (args: any) => {
      webPort.postMessage({ args, callbackID: msg.callbackID });
    });
    mainProcessCancelCallbacks.set(msg.callbackID, cancel);
    return;
  }
  if (msg.cancelCallbackID != null) {
    mainProcessCancelCallbacks.get(msg.cancelCallbackID)();
    mainProcessCancelCallbacks.delete(msg.cancelCallbackID);
    return;
  }
  if (!msg.name || !(msg.name in publicAPI)) {
    sendMsgToMain("logWarn", "[desktop] Unhandled message", msg.name);
    return;
  }

  let resultPromise = undefined;

  try {
    resultPromise = msg.name && publicAPI && publicAPI[msg.name](msg.args);
  } catch (e) {
    sendMsgToMain("logError", "[desktop] handler failed:", msg.name, String(e));
  } finally {
    if (msg.promiseID != null) {
      if (resultPromise instanceof Promise) {
        resultPromise
          .then((result) => {
            webPort.postMessage(
              { result: result?.data, promiseID: msg.promiseID },
              result?.transferList ?? [],
            );
          })
          .catch((error) => {
            const errorString = (error && error.name) || "Promise error";
            webPort.postMessage({ error: errorString, promiseID: msg.promiseID });
          });
      } else {
        webPort.postMessage({ error: "No result" + resultPromise, promiseID: msg.promiseID });
      }
    }
  }
};

const initWebApi = (props: IntiApiOptions) => {
  const channel = new MessageChannel();
  const pendingPromises = new Map();
  const registeredCallbacks = new Map();

  let messageHandler: (name: string, args: any) => void;
  let nextPromiseID = 0;
  let nextCallbackID = 0;

  window.__figmaContent = false;

  if (/file\/.+/.test(location.href)) {
    props.fileBrowser = false;
  }

  window.__figmaDesktop = {
    version: props.version,
    appVersion: props.appVersion,
    fileBrowser: props.fileBrowser,
    postMessage: function (name, args, transferList): void {
      channel.port1.postMessage({ name, args }, transferList);
    },
    registerCallback: function (name, args, callback) {
      const id = nextCallbackID++;
      registeredCallbacks.set(id, callback);
      channel.port1.postMessage({ name, args, callbackID: id });
      return (): void => {
        channel.port1.postMessage({ cancelCallbackID: id });
      };
    },
    promiseMessage: function (name, args, transferList) {
      return new Promise((resolve, reject) => {
        const id = nextPromiseID++;
        pendingPromises.set(id, { resolve, reject });
        channel.port1.postMessage({ name, args, promiseID: id });
      });
    },
    setMessageHandler: function (handler: () => void): void {
      messageHandler = handler;
    },
  };

  channel.port1.onmessage = (event: MessageEvent): void => {
    const msg = event.data;

    if (!msg) return;

    if (msg.promiseID != null) {
      const pendingPromise = pendingPromises.get(msg.promiseID);

      if (pendingPromise) {
        pendingPromises.delete(msg.promiseID);
        if ("result" in msg) {
          pendingPromise.resolve(msg.result);
        } else {
          pendingPromise.reject(msg.error);
        }
      }
    } else if (msg.callbackID != null) {
      const registeredCallback = registeredCallbacks.get(msg.callbackID);
      if (registeredCallback) {
        registeredCallback(msg.args);
      }
    } else if (msg.name != null) {
      messageHandler(msg.name, msg.args);
    }
  };

  window.postMessage("init", location.origin, [channel.port2]);
};

const initWebBindings = (): void => {
  E.ipcRenderer.on("newFile", () => {
    webPort.postMessage({ name: "newFile", args: {} });
  });
  E.ipcRenderer.on("handleAction", (_: IpcRendererEvent, action: string, source: string) => {
    webPort.postMessage({ name: "handleAction", args: { action, source } });
  });
  E.ipcRenderer.on("handleUrl", (_: IpcRendererEvent, path: string, params: string) => {
    webPort.postMessage({ name: "handleUrl", args: { path, params } });
  });
  E.ipcRenderer.on("handleSetFullScreen", (event: IpcRendererEvent, fullscreen: boolean) => {
    webPort.postMessage({ name: "handleSetFullScreen", args: { fullscreen } });
  });
  E.ipcRenderer.on("showFlashMessage", (event: IpcRendererEvent, flashErrorMessage: string) => {
    webPort.postMessage({
      name: "showFlashMessage",
      args: { flashErrorMessage },
    });
  });
  E.ipcRenderer.on("handlePageCommand", (_: IpcRendererEvent, command: string) => {
    webPort.postMessage({
      name: "handlePageCommand",
      args: { pageCommand: command, source: "os-menu" },
    });
  });

  E.ipcRenderer.on("redeemAppAuth", (event: IpcRendererEvent, gSecret: string) => {
    webPort.postMessage({ name: "redeemAppAuth", args: { gSecret } });
  });

  E.ipcRenderer.on("handlePluginMenuAction", (event: IpcRendererEvent, pluginMenuAction: any) => {
    webPort.postMessage({ name: "handlePluginMenuAction", args: { pluginMenuAction } });
  });
};

function keydownHandler(event: KeyboardEvent) {
  const url = location.href;
  if (
    event.code === "F11" &&
    (isValidProjectLink(url) || isValidFigjamLink(url) || isPrototypeUrl(url))
  ) {
    E.ipcRenderer.send("toggleCurrentWindowFullscreen");
  }
}

const publicAPI: any = {
  setTitle(args: WebApi.SetTitleArgs) {
    sendMsgToMain("setTitle", args.title);
  },

  setUser(args: WebApi.SetUser) {
    sendMsgToMain("setUser", args.id);
  },
  setUsingMicrophone(args: WebApi.SetUsingMic) {
    sendMsgToMain("setUsingMicrophone", args.isUsingMicrophone);
  },
  setIsInVoiceCall(args: WebApi.SetIsInVoiceCall) {
    sendMsgToMain("setIsInVoiceCall", args.isInVoiceCall);
  },

  addTabAnalyticsMetadata() {
    // not implemented
  },
  async requestMicrophonePermission() {
    let granted = false;

    try {
      await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      granted = true;
    } catch (_) {
      granted = false;
    }

    return { data: granted };
  },
  async setMediaEnabled(args: any) {
    return true;
  },

  newFile(args: any) {
    sendMsgToMain("newFile", args.info);
  },
  // TODO: need update
  openFile(args: any) {
    sendMsgToMain("openFile", "/file/" + args.fileKey, args.title, undefined, args.target);
  },
  openCommunity(args: WebApi.OpenCommunity) {
    sendMsgToMain("openCommunity", args);
  },
  openPrototype(args: any) {
    sendMsgToMain(
      "openFile",
      "/proto/" + args.fileKey,
      args.title,
      "?node-id=" + args.pageId,
      args.target,
    );
  },
  // TODO:
  // async isTabOpen(args: any) {
  //   console.log("isTabOpen, args: ", args);
  //   //   {
  //   //     "url": "https://www.figma.com/file/new?editor_type=design&localFileKey=LOCAL_e8ed2b31-ac61-435c-999c-84d85395e349&fuid=525661429846675544",
  //   //     "newFileInfo": {
  //   //         "folder_id": null,
  //   //         "org_id": null,
  //   //         "openNewFileIn": "new_tab",
  //   //         "trackingInfo": {
  //   //             "from": "desktop_new_tab_button",
  //   //             "selectedView": {
  //   //                 "view": "desktopNewTab"
  //   //             }
  //   //         },
  //   //         "editorType": "design",
  //   //         "localFileKey": "LOCAL_e8ed2b31-ac61-435c-999c-84d85395e349"
  //   //     },
  //   //     "editorType": "design",
  //   //     "isFromNewTabPage": true
  //   // }
  //   // return { data: await n.sendAsync("isTabOpen", e.getString("url")) };
  // },
  // openFileFromNewTab(args: any) {
  //   console.log("openFileFromNewTab, args: ", args);
  //   // n.send(
  //   //   "openFileFromNewTab",
  //   //   e.getString("url"),
  //   //   e.getString("editorType", "") || void 0,
  //   //   e.getString("title", "") || void 0,
  //   //   e.getBoolean("isBranch", !1),
  //   //   e.getBoolean("isLibrary", !1),
  //   //   e.getBoolean("isTeamTemplate", !1),
  //   // );
  // },
  async createFile(args: WebApi.CreateFile) {
    const result = await E.ipcRenderer.invoke("createFile", args);

    return { data: result };
  },
  close(args: any) {
    sendMsgToMain("closeTab", args.suppressReopening);
  },
  setLoading(args: WebApi.SetLoading) {
    sendMsgToMain("setLoading", args);
    // Figma reports when a file finished loading: used for project load timing.
    sendMsgToMain("diag:setLoading", { loading: !!args?.loading, url: location.href, t: performance.now() });
  },
  setSaved(args: any) {
    sendMsgToMain("updateSaveStatus", args.saved);
  },
  updateFullscreenMenuState(args: any) {
    sendMsgToMain("updateFullscreenMenuState", args.state);
  },
  showFileBrowser() {
    sendMsgToMain("showFileBrowser");
  },
  setIsPreloaded() {
    sendMsgToMain("setIsPreloaded");
  },
  // TODO:
  // setEditorType(args: any) {
  //   console.log("setEditorType, args: ", args);
  //   // n.send("updateEditorType", e.getString("editorType"));
  // },
  // setRealtimeToken(args: any) {
  //   console.log("setRealtimeToken, args: ", args);
  //   // n.send("setRealtimeToken", e.getString("realtimeToken"), e.getString("fileKey"));
  // },
  setInitialOptions(args: WebApi.SetInitOptions) {
    sendMsgToMain("setInitialOptions", args);
  },
  // setTheme(args: any) {
  //   console.log("isTabOpen, args: ", args);
  //   // n.send("setTheme", e.getString("theme", "dark"));
  // },

  setFeatureFlags(args: any) {
    sendMsgToMain("setFeatureFlags", args);
  },
  startAppAuth(args: any) {
    sendMsgToMain("startAppAuth", args);
  },
  finishAppAuth(args: any) {
    sendMsgToMain("finishAppAuth", args);
  },
  openDevTools(args: { mode: string }) {
    sendMsgToMain("openDevTools", args.mode);
  },

  setAuthedUsers(args: WebApi.SetAuthedUsers) {
    sendMsgToMain("setAuthedUsers", args.userIDs);
  },
  setWorkspaceName(args: WebApi.SetWorkspaceName) {
    sendMsgToMain("setWorkspaceName", args.name);
  },
  setFigjamEnabled(args: WebApi.SetFigjamEnabled) {
    sendMsgToMain("setFigjamEnabled", args.figjamEnabled);
  },
  getZoomFactor() {
    return Promise.resolve({ data: E.webFrame.getZoomFactor() });
  },

  async writeNewExtensionDirectoryToDisk(args: WebApi.WriteNewExtensionDirectoryToDisk) {
    const data = await E.ipcRenderer.invoke("writeNewExtensionDirectoryToDisk", args);

    return { data };
  },
  async getLocalManifestFileExtensionIdsToCachedMetadataMap() {
    const data = await E.ipcRenderer.invoke("getLocalManifestFileExtensionIdsToCachedMetadataMap");

    return { data };
  },

  async createMultipleNewLocalFileExtensions(args: WebApi.CreateMultipleExtension) {
    const result = await E.ipcRenderer.invoke("createMultipleNewLocalFileExtensions", args);

    return { data: result };
  },
  async getAllLocalManifestFileExtensionIds() {
    const result = await E.ipcRenderer.invoke("getAllLocalFileExtensionIds");
    return { data: result };
  },
  async getLocalFileExtensionManifest(args: WebApi.ExtensionId) {
    const manifest = await E.ipcRenderer.invoke("getLocalFileExtensionManifest", args);
    return { data: manifest };
  },
  async getLocalFileExtensionSource(args: WebApi.ExtensionId) {
    const source = await E.ipcRenderer.invoke("getLocalFileExtensionSource", args);
    return { data: source };
  },
  removeLocalFileExtension(args: WebApi.ExtensionId) {
    E.ipcRenderer.send("removeLocalFileExtension", args);
  },
  openExtensionDirectory(args: WebApi.ExtensionId) {
    E.ipcRenderer.send("openExtensionDirectory", args);
  },
  openExtensionManifest(args: WebApi.ExtensionId) {
    E.ipcRenderer.send("openExtensionDirectory", args);
  },
  async writeNewExtensionToDisk(args: WebApi.WriteNewExtensionToDiskArgs) {
    const extId = await E.ipcRenderer.invoke("writeNewExtensionToDisk", args);
    return { data: extId };
  },

  async isDevToolsOpened() {
    const isOpened = await E.ipcRenderer.invoke("isDevToolsOpened");

    return { data: isOpened };
  },

  async getFonts(args: WebApi.GetFonts) {
    const fonts = await E.ipcRenderer.invoke("getFonts");
    return { data: fonts };
  },

  // Same answers the Figma Font Agent gives (null = no incremental update). They used
  // to return the whole font list, which Figma treated as a timestamp/diff.
  async getModifiedFonts() {
    return { data: null as null };
  },

  async getFontsModifiedAt() {
    return { data: null as null };
  },

  async getFontFile(args: WebApi.GetFontFile) {
    const bytes: Uint8Array | null = await E.ipcRenderer.invoke("getFontFile", args);

    if (!bytes) {
      return { data: null as ArrayBuffer | null };
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    return { data: buffer, transferList: [buffer] };
  },

  // Electron 44+ has no clipboard module in renderers: the main process reads it.
  async getClipboardData(args: any) {
    const formats: string[] = Array.isArray(args?.formats) ? args.formats : [];
    const result = await E.ipcRenderer.invoke("getClipboardData", formats);

    if (!result) {
      throw new Error("Formats not found");
    }

    return { data: result, transferList: [result.data] };
  },

  setClipboardData(args: WebApi.SetClipboardData) {
    E.ipcRenderer.invoke("setClipboardData", args);
  },

  async writeFiles(args: WebApi.WriteFiles) {
    await E.ipcRenderer.invoke("writeFiles", args);
  },
};

const init = (fileBrowser: boolean): void => {
  // The first "init" from the page itself carries the port. The old `{ once: true }`
  // dropped the listener on any earlier unrelated message and lost the bridge.
  const onInit = (event: MessageEvent) => {
    if (event.source !== window || event.data !== "init" || !event.ports || !event.ports.length) {
      return;
    }

    window.removeEventListener("message", onInit);
    webPort = event.ports[0];
    webPort.onmessage = onWebMessage;
  };
  window.addEventListener("message", onInit);

  const initWebOptions: IntiApiOptions = {
    version: API_VERSION,
    appVersion: APP_VERSION,
    fileBrowser: fileBrowser,
  };

  initWebBindings();

  const config = E.ipcRenderer.sendSync("getPreloadConfig") ?? {};

  if (config.webgpuInstrumentation) {
    document.addEventListener(GPU_STATS_EVENT, (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (typeof detail === "string") sendMsgToMain("diag:webgpuStats", detail);
    });
    E.contextBridge.executeInMainWorld({ func: installWebGpuInstrumentation, args: [GPU_STATS_EVENT] });
  }

  if (config.desktopBridge !== false) {
    E.contextBridge.executeInMainWorld({ func: initWebApi, args: [initWebOptions] });
  }

  document.addEventListener("keydown", keydownHandler);
  document.addEventListener("DOMContentLoaded", () => {
    E.ipcRenderer.invoke("themesIsDisabled").then((disabled) => {
      if (!disabled) {
        setTimeout(() => {
          themes.init();
        }, 10);
      }
    });
  });
};

export default init;
