import { app, Rectangle, WebContentsView, HandlerDetails, WindowOpenHandlerResponse } from "electron";

import { FIGMA_WEB_PREFERENCES, LOGIN_PAGE, RECENT_FILES } from "Const";
import { preloadMainScriptPathDev, preloadMainScriptPathProd, toggleDetachedDevTools } from "Utils/Main";
import {
  isDev,
  isValidProjectLink,
  isPrototypeUrl,
  isAppAuthRedeem,
  isFigmaDocLink,
  isFigmaBoardLink,
  isFigmaDesignLink,
  parseURL,
} from "Utils/Common";
import { storage } from "Main/Storage";
import { openExternalSafe } from "Main/Session";
import { figmaWindowOpenHandler, isEditorLikeUrl } from "./Tab";

/** The always-present "file browser" (recent files) tab of a window. */
export default class MainTab {
  private _userId: string;

  public id: number;
  public view: WebContentsView;

  constructor(private windowId: number) {
    this.initTab();
    this.registerEvents();
  }

  public setUserId(id: string) {
    if (this._userId !== id) {
      const url = `${RECENT_FILES}/?fuid=${id}`;
      this.loadUrl(url);
    }

    this._userId = id;
  }
  public loadUrl(url: string) {
    this.view.webContents.loadURL(url);
  }
  public getUrl() {
    return this.view.webContents.getURL();
  }
  public loadLoginPage() {
    this.view.webContents.loadURL(LOGIN_PAGE);
  }
  public redeemAppAuth(secret: string) {
    this.view.webContents.send("redeemAppAuth", secret);
  }
  public handleUrl(path: string) {
    this.view.webContents.send("handleUrl", path);
  }
  public setBounds(bounds: Rectangle) {
    this.view.setBounds(bounds);
  }
  public setVisible(visible: boolean) {
    this.view.setVisible(visible);
  }
  public destroy() {
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
  }

  private initTab() {
    this._userId = storage.settings.userId;
    const url = `${RECENT_FILES}/?fuid=${this._userId}`;

    this.view = new WebContentsView({
      webPreferences: {
        ...FIGMA_WEB_PREFERENCES,
        preload: isDev ? preloadMainScriptPathDev : preloadMainScriptPathProd,
      },
    });
    this.id = this.view.webContents.id;

    this.loadUrl(url);

    isDev && toggleDetachedDevTools(this.view.webContents);

    app.emit("requestBoundsForTabView", this.windowId);
  }

  public updateScale(scale: number) {
    this.view.webContents.setZoomFactor(scale);
  }
  public reloadCurrentTheme() {
    app.emit("reloadCurrentTheme");
  }
  public loadTheme(theme: Themes.Theme) {
    this.view.webContents.send("loadCurrentTheme", theme);
  }

  private onDomReady() {
    this.reloadCurrentTheme();
  }
  private onWillNavigate(event: Electron.Event, url: string) {
    // Files, prototypes and boards open in their own tab, the file browser stays.
    if (isValidProjectLink(url) || isPrototypeUrl(url) || isFigmaBoardLink(url) || isFigmaDesignLink(url)) {
      app.emit("openUrlInNewTab", url);
      event.preventDefault();
      return;
    }

    const currentUrl = this.view.webContents.getURL();
    if (isAppAuthRedeem(url)) {
      return;
    }
    if (url === currentUrl) {
      event.preventDefault();
      return;
    }

    const from = parseURL(currentUrl);
    const to = parseURL(url);

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
    if (isFigmaDocLink(url)) {
      openExternalSafe(url);
      event.preventDefault();
    }
  }

  private windowOpenHandler(details: HandlerDetails): WindowOpenHandlerResponse {
    if (isEditorLikeUrl(details.url)) {
      app.emit("openUrlInNewTab", details.url);
      return { action: "deny" };
    }

    return figmaWindowOpenHandler(details);
  }

  private registerEvents() {
    const wc = this.view.webContents;

    wc.setWindowOpenHandler(this.windowOpenHandler.bind(this));
    wc.on("will-navigate", this.onWillNavigate.bind(this));
    wc.on("dom-ready", this.onDomReady.bind(this));
  }
}
