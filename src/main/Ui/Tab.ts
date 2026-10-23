import {
  app,
  Rectangle,
  WebContentsView,
  HandlerDetails,
  WindowOpenHandlerResponse,
} from "electron";

import { FIGMA_WEB_PREFERENCES } from "Const";
import { preloadScriptPathDev, preloadScriptPathProd } from "Utils/Main";
import {
  isDev,
  isValidProjectLink,
  isPrototypeUrl,
  isAppAuthRedeem,
  isFigmaDocLink,
  isFigmaBoardLink,
  isFigmaDesignLink,
  isValidFigjamLink,
  parseURL,
} from "Utils/Common";
import { openExternalSafe } from "Main/Session";

export const isEditorLikeUrl = (url: string) =>
  isPrototypeUrl(url) ||
  isValidProjectLink(url) ||
  isValidFigjamLink(url) ||
  isFigmaBoardLink(url) ||
  isFigmaDesignLink(url);

// Google SSO popups must stay in-app (they post the result back to the opener).
const isSsoPopup = (url: string) => /start_google_sso/.test(url) || /^https:\/\/accounts\.google\.com\//.test(url);

export const figmaWindowOpenHandler = (details: HandlerDetails): WindowOpenHandlerResponse => {
  const { url } = details;

  if (isEditorLikeUrl(url)) {
    app.emit("openUrlInNewTab", url);
    return { action: "deny" };
  }
  if (isSsoPopup(url)) {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: { ...FIGMA_WEB_PREFERENCES, preload: undefined },
      },
    };
  }

  openExternalSafe(url);
  return { action: "deny" };
};

/**
 * A Figma file / prototype tab. Hosted in a WebContentsView (BrowserView is
 * deprecated since Electron 30). Inactive tabs are hidden with setVisible(false),
 * so Chromium marks them hidden and throttles their rendering and timers.
 */
export default class Tab {
  public id: number;
  public title?: string;
  public url?: string;
  public moves?: boolean;
  public fileKey?: string;
  public isUsingMicrophone?: boolean;
  public isInVoiceCall?: boolean;
  public view: WebContentsView;
  // Restored tabs are created without loading; the page loads on first focus.
  private pendingUrl?: string;

  constructor(private windowId: number) {
    this.initTab();
    this.registerEvents();
  }

  public get isLoaded() {
    return !this.pendingUrl;
  }

  public loadUrl(url: string) {
    this.url = url;
    this.pendingUrl = undefined;
    this.view.webContents.loadURL(url);
  }
  public deferUrl(url: string) {
    this.url = url;
    this.pendingUrl = url;
  }
  public ensureLoaded() {
    if (this.pendingUrl) {
      this.loadUrl(this.pendingUrl);
    }
  }
  public getUrl() {
    return this.pendingUrl ?? this.view.webContents.getURL();
  }
  public setBounds(bounds: Rectangle) {
    this.view.setBounds(bounds);
  }
  public setVisible(visible: boolean) {
    this.view.setVisible(visible);
  }
  public destroy() {
    const wc = this.view.webContents;

    if (!wc.isDestroyed()) {
      wc.close();
    }
  }

  private initTab() {
    this.view = new WebContentsView({
      webPreferences: {
        ...FIGMA_WEB_PREFERENCES,
        preload: isDev ? preloadScriptPathDev : preloadScriptPathProd,
      },
    });
    this.view.setVisible(false);
    this.id = this.view.webContents.id;

    app.emit("requestBoundsForTabView", this.windowId);
  }

  public updateScale(scale: number) {
    this.view.webContents.setZoomFactor(scale);
  }
  public reloadCurrentTheme() {
    app.emit("reloadCurrentTheme");
  }

  private onDomReady() {
    this.reloadCurrentTheme();
  }
  private onWillNavigate(event: Electron.Event, newUrl: string) {
    const currentUrl = this.view.webContents.getURL();

    if (isAppAuthRedeem(newUrl)) {
      return;
    }

    if (newUrl === currentUrl) {
      event.preventDefault();
      return;
    }

    if (isFigmaDocLink(newUrl)) {
      openExternalSafe(newUrl);

      event.preventDefault();
      return;
    }

    const from = parseURL(currentUrl);
    const to = parseURL(newUrl);

    if (from?.pathname === "/login") {
      event.preventDefault();
      return;
    }

    if (to?.pathname === "/logout") {
      app.emit("signOut");
    }

    if (to?.search && /[?&]redirected=1/.test(to.search)) {
      event.preventDefault();
      return;
    }
  }

  private registerEvents() {
    const wc = this.view.webContents;

    wc.setWindowOpenHandler(figmaWindowOpenHandler);
    wc.on("will-navigate", this.onWillNavigate.bind(this));
    wc.on("dom-ready", this.onDomReady.bind(this));
  }
}
