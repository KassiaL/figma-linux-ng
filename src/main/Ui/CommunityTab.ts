import { app, Rectangle, WebContentsView, HandlerDetails } from "electron";

import { FIGMA_WEB_PREFERENCES } from "Const";
import { preloadScriptPathDev, preloadScriptPathProd, toggleDetachedDevTools } from "Utils/Main";
import { isDev, isValidProjectLink, isPrototypeUrl, isRecentFilesLink, isFigmaUrl, isValidFigjamLink } from "Utils/Common";
import { storage } from "Main/Storage";
import { openExternalSafe } from "Main/Session";

export default class CommunityTab {
  public userId: string;
  public id: number;
  public view: WebContentsView;

  constructor(private windowId: number) {
    this.userId = storage.settings.userId;

    this.initTab();
    this.registerEvents();
  }

  public loadUrl(url: string) {
    this.view.webContents.loadURL(url);
  }
  public getUrl() {
    return this.view.webContents.getURL();
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
    this.view = new WebContentsView({
      webPreferences: {
        ...FIGMA_WEB_PREFERENCES,
        preload: isDev ? preloadScriptPathDev : preloadScriptPathProd,
      },
    });
    this.id = this.view.webContents.id;

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

  private onWillNavigate(event: Electron.Event, url: string) {
    if (isFigmaUrl(url) && !isRecentFilesLink(url)) {
      return;
    }

    event.preventDefault();

    if (isRecentFilesLink(url)) {
      app.emit("openFileBrowser");
      return;
    }

    openExternalSafe(url);
  }
  private windowOpenHandler(details: HandlerDetails) {
    const url = details.url;

    if (isPrototypeUrl(url) || isValidProjectLink(url) || isValidFigjamLink(url)) {
      app.emit("openUrlFromCommunity", url);
      return { action: "deny" as const };
    }

    openExternalSafe(url);

    return { action: "deny" as const };
  }

  private registerEvents() {
    const wc = this.view.webContents;

    wc.setWindowOpenHandler(this.windowOpenHandler.bind(this));
    wc.on("will-navigate", this.onWillNavigate.bind(this));
    wc.on("dom-ready", () => this.reloadCurrentTheme());
  }
}
