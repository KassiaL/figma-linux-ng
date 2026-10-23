import { app, BrowserWindow, IpcMainEvent, Rectangle, Menu, View } from "electron";
import { storage } from "Main/Storage";
import SettingsView from "./SettingsView";
import TabManager from "./TabManager";

import {
  HOMEPAGE,
  WINDOW_DEFAULT_OPTIONS,
  TOPPANELHEIGHT,
  NEW_PROJECT_TAB_URL,
  NEW_FILE_TAB_TITLE,
} from "Const";
import { isDev, isCommunityUrl, isAppAuthRedeem, normalizeUrl, parseURL, urlPath } from "Utils/Common";
import { panelUrlDev, panelUrlProd, toggleDetachedDevTools } from "Utils/Main";
import Tab from "./Tab";

let quitting = false;
app.on("before-quit", () => (quitting = true));

export default class Window {
  private window: BrowserWindow;
  private tabManager: TabManager;
  private settingsView: SettingsView;
  private state: Types.WindowState;
  private activeView: View | undefined;
  private boundsTimer: NodeJS.Timeout | undefined;

  private _userId: string;

  constructor(state: Types.WindowState) {
    this.window = new BrowserWindow(WINDOW_DEFAULT_OPTIONS);
    this.tabManager = new TabManager(this.window.id);
    this.settingsView = new SettingsView();
    this.state = state;

    this.attachView(this.tabManager.mainTab.view);
    this.showView(this.tabManager.mainTab.view);

    this.registerEvents();

    this.window.loadURL(isDev ? panelUrlDev : panelUrlProd);
    isDev && toggleDetachedDevTools(this.window.webContents);
    this.applyState();
  }

  public get id() {
    return this.window.id;
  }
  public get webContentId() {
    return this.window.webContents.id;
  }
  public get settingsViewId() {
    return this.settingsView.view.webContents.id;
  }
  public get mainTabInfo() {
    return {
      id: this.tabManager.mainTab.id,
      url: this.tabManager.mainTab.view.webContents.getURL(),
    };
  }
  public get communityTabInfo() {
    return {
      id: this.tabManager.communityTab ? this.tabManager.communityTab.id : -1,
      url: this.tabManager.communityTab ? this.tabManager.communityTab.view.webContents.getURL() : "",
    };
  }
  public get tabs() {
    return this.tabManager.getAll();
  }
  public get win() {
    return this.window;
  }
  public get allWebContentsIds() {
    const ids = new Set<number>([
      this.webContentId,
      this.settingsViewId,
      this.tabManager.mainTabWebContentId,
      ...this.tabs.keys(),
    ]);

    if (this.tabManager.communityTabWebContentId) {
      ids.add(this.tabManager.communityTabWebContentId);
    }

    return [...ids];
  }
  /** webContents of every Figma view in this window, for diagnostics. */
  public get figmaWebContents() {
    return this.tabManager.allViews().map((v) => v.webContents);
  }

  // --- view management (WebContentsView) ---------------------------------
  // All tab views stay attached to the window; only the active one is visible.
  // A hidden WebContentsView reports document.visibilityState === "hidden", so
  // Chromium throttles rAF/timers and Figma stops drawing background tabs.
  private attachView(view: View) {
    if (!this.window.contentView.children.includes(view)) {
      view.setVisible(false);
      this.window.contentView.addChildView(view);
    }
  }
  private detachView(view: View) {
    if (this.activeView === view) this.activeView = undefined;
    if (this.window.contentView.children.includes(view)) {
      this.window.contentView.removeChildView(view);
    }
  }
  private showView(view: View) {
    this.attachView(view);
    view.setBounds(this.calcBoundsForTabView());

    if (this.activeView && this.activeView !== view) {
      this.activeView.setVisible(false);
    }
    view.setVisible(true);
    this.activeView = view;
  }

  public setUserId(id: string) {
    this._userId = id;
    this.tabManager.setUserId(id);
  }
  public sortTabs(tabs: Types.TabFront[]) {
    this.tabManager.sortTabs(tabs);
  }
  public getState(): Types.WindowState & { windowId: number } {
    const tabs: Types.SavedTab[] = [];

    for (const [_, tab] of this.tabs) {
      tabs.push({
        title: tab.title,
        url: tab.url,
      });
    }

    const bounds = this.window.getNormalBounds();

    return {
      ...bounds,
      isMaximized: this.window.isMaximized(),
      lastActiveTabPath: this.tabManager.getActiveTabPath(),
      hasOpenedCommunityTab: this.tabManager.hasOpenedCommunityTab,
      windowId: this.id,
      userId: this._userId,
      tabs,
    };
  }
  /**
   * Restores saved tabs. With lazyRestoreTabs (default) only the previously active
   * tab loads immediately; the others load when first focused. Opening a dozen
   * heavy Figma files at once was the main cause of slow startup and RAM spikes.
   */
  public restoreTabs(list?: Types.SavedTab[]) {
    const tabs =
      list ??
      (
        storage.settings.app.lastOpenedTabs as {
          [key: string]: Types.SavedTab[];
        }
      )[this.id];

    if (!tabs || !tabs.length) {
      return;
    }

    const lazy = storage.settings.app.lazyRestoreTabs !== false;
    const activePath = this.state.lastActiveTabPath;

    for (const saved of tabs) {
      const isActive = !!activePath && urlPath(saved.url).startsWith(activePath);
      this.addTab(saved.url, saved.title, lazy && !isActive);
    }

    if (activePath) {
      this.setTabFocusByPath(activePath);
    }
  }
  public calcBoundsForTabView(): Rectangle {
    const panelHeight = storage.settings.app.panelHeight;
    const { width, height } = this.window.getContentBounds();

    return {
      x: 0,
      y: panelHeight,
      width,
      height: Math.max(0, height - panelHeight),
    };
  }

  public handleUrl(path: string) {
    this.tabManager.handleUrl(path);
    this.setFocusToMainTab();
  }
  public handlePluginManageAction(type: string) {
    this.tabManager.mainTab.view.webContents.send("handlePluginMenuAction", { type });
    this.setFocusToMainTab();
  }
  public handlePluginMenuAction(pluginMenuAction: Menu.MenuAction) {
    this.tabManager.handlePluginMenuAction(pluginMenuAction);
  }
  public toggleDevTools() {
    toggleDetachedDevTools(this.window.webContents);
  }
  public toggleSettingsDevTools() {
    toggleDetachedDevTools(this.settingsView.view.webContents);
  }
  public toggleCurrentTabDevTools() {
    const tab = this.tabManager.getById(this.tabManager.lastFocusedTab);

    toggleDetachedDevTools(tab.view.webContents);
  }

  public openUrlFromCommunity(url: string) {
    const tab = this.addTab(url);

    this.setTabFocus(tab.id);
  }

  public openUrl(url: string) {
    if (isAppAuthRedeem(url)) {
      const normalizedUrl = normalizeUrl(url);

      this.tabManager.loadUrlInMainTab(normalizedUrl);
    } else if (isCommunityUrl(url)) {
      this.handleUrl(urlPath(url));
      this.setFocusToMainTab();
    } else if (/^figma:\/\//.test(url)) {
      const tab = this.addTab(url.replace(/^figma:\//, HOMEPAGE));
      this.setTabFocus(tab.id);
    } else if (/^https?:\/\//.test(url)) {
      const tab = this.addTab(url);
      this.setTabFocus(tab.id);
    }
  }
  public focus() {
    if (this.window.isMinimized()) this.window.restore();
    this.window.focus();
  }
  public showHandler(event: IpcMainEvent) {
    const scale = storage.settings.ui.scalePanel;

    this.updatePanelScale(event, scale);
  }
  public toggleThemeCreatorPreviewMask() {
    this.settingsView.toggleThemeCreatorPreviewMask();
  }

  public updatePanelScale(_: IpcMainEvent, scale: number) {
    const panelScale = +scale.toFixed(2);

    storage.settings.app.panelHeight = Math.floor(TOPPANELHEIGHT * panelScale);
    storage.settings.ui.scalePanel = panelScale;

    this.window.webContents.send("setPanelScale", panelScale, storage.settings.app.panelHeight);

    this.updateTabsBounds();
  }
  public updateFigmaUiScale(_: IpcMainEvent, scale: number) {
    this.tabManager.updateScaleAll(scale);
  }
  public getBounds() {
    return this.window.getBounds();
  }
  public updateTabsBounds() {
    if (this.window.isDestroyed()) return;
    const bounds = this.calcBoundsForTabView();

    this.tabManager.setBoundsForAllTab(bounds);
    if (this.window.contentView.children.includes(this.settingsView.view)) {
      this.settingsView.updateProps(this.window.getContentBounds());
    }
  }
  public closeAllTab(_: IpcMainEvent) {
    for (const [_, tab] of this.tabManager.getAll()) {
      this.detachView(tab.view);
    }

    this.tabManager.closeAll();
    this.showView(this.tabManager.mainTab.view);

    this.window.webContents.send("closeAllTab");
  }
  public loadLoginPageAllWindows() {
    this.tabManager.loadLoginPage();
  }
  public redeemAppAuth(secret: string) {
    this.tabManager.redeemAppAuth(secret);
  }

  public newProject() {
    if (this.tabManager.hasOpenedNewFileTab) {
      return;
    }

    const tab = this.addTab(`${NEW_PROJECT_TAB_URL}?fuid=${this._userId}`, NEW_FILE_TAB_TITLE);
    this.setTabFocus(tab.id);

    this.window.webContents.send("newFileBtnVisible", false);
  }
  public createFile(args: WebApi.CreateFile) {
    const newFileTab = this.tabManager.getByTitle(NEW_FILE_TAB_TITLE);
    const tab = this.addTab(args.url);

    if (newFileTab) {
      this.closeTab(newFileTab.id);
      this.tabWasClosed(newFileTab.id);
    }

    this.window.webContents.send("newFileBtnVisible", true);

    this.setTabFocus(tab.id);

    return true;
  }
  public openMainMenuCloseHandler() {
    setTimeout(() => {
      if (!this.window.isDestroyed()) this.window.webContents.send("isMainMenuOpen", false);
    }, 150);
  }
  public hasWebContentId(webContentsId: number) {
    return this.tabManager.getAll().has(webContentsId);
  }

  public getTabInfo(tabId: number) {
    const tab = this.tabManager.getById(tabId);
    const url = tab.getUrl();

    return {
      id: tabId,
      title: tab instanceof Tab ? tab.title : "",
      url,
    };
  }

  public addTab(url: string, title?: string, lazy = false) {
    const parsedUrl = parseURL(url);
    if (parsedUrl && this._userId) parsedUrl.searchParams.set("fuid", this._userId);

    const tab = this.tabManager.addTab(parsedUrl ? parsedUrl.toString() : url, title, lazy);
    this.attachView(tab.view);
    tab.setBounds(this.calcBoundsForTabView());

    this.window.webContents.send("didTabAdd", {
      id: tab.id,
      url,
      title,
    });

    return tab;
  }

  public openSettingsView() {
    const bounds = this.window.getContentBounds();
    this.settingsView.updateProps(bounds);

    // Added last, so it is the topmost child view (above the active tab).
    this.window.contentView.addChildView(this.settingsView.view);
    this.settingsView.view.setVisible(true);

    isDev && toggleDetachedDevTools(this.settingsView.view.webContents);
  }
  public closeSettingsView() {
    if (!this.settingsView.view) {
      return;
    }

    this.settingsView.closeDevTools();

    this.detachView(this.settingsView.view);

    this.settingsView.postClose();
  }
  public toggleFullScreen() {
    this.window.setFullScreen(!this.window.isFullScreen());
  }
  private onEnterFullScreen() {
    const tab = this.tabManager.getById(this.tabManager.lastFocusedTab);

    if (tab) {
      tab.view.webContents.send("handleSetFullScreen", true);
    }
  }
  private onLeaveFullScreen() {
    const tab = this.tabManager.getById(this.tabManager.lastFocusedTab);

    if (tab) {
      tab.view.webContents.send("handleSetFullScreen", false);
    }
  }
  private applyState() {
    const { x, y, height, width, userId, tabs, isMaximized } = this.state;
    userId && this.setUserId(userId);

    if (storage.settings.app.saveLastOpenedTabs && tabs && tabs.length > 0) {
      this.window.webContents.once("did-finish-load", () => this.restoreTabs(tabs));
    }

    if (x !== -1 && y !== -1) {
      this.win.setBounds({ x, y, width, height });
    } else {
      this.win.setSize(width, height);
    }

    this.window.once("ready-to-show", () => {
      isMaximized ? this.window.maximize() : this.window.show();
    });
  }
  private loadCurrentTheme = (theme: Themes.Theme) => {
    if (!this.window.isDestroyed()) this.window.webContents.send("loadCurrentTheme", theme);
  };
  public setLoading(event: IpcMainEvent, args: WebApi.SetLoading) {
    const tabId = event.sender.id;
    const tab = this.tabManager.getById(tabId);

    if (!tab) {
      return;
    }

    this.window.webContents.send("setLoading", tabId, args.loading);
  }
  public windowMinimize(_: IpcMainEvent) {
    this.window.minimize();
  }
  public windowMaimize(event: IpcMainEvent) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    if (this.window.isMaximized()) {
      this.window.restore();
      event.reply("windowDidRestored");
    } else {
      this.window.maximize();
      event.reply("windowDidMaximized");
    }
  }
  private webContentDidFinishLoad() {
    if (this.state.hasOpenedCommunityTab) {
      this.openCommunity({
        path: "/@figma_linux",
        userId: this._userId,
      });
    }

    if (!this.state.lastActiveTabPath || !this.state.tabs?.length) {
      this.setFocusToMainTab();
    }
  }
  public setMenu(menu: Menu) {
    this.window.setMenu(menu);
  }
  public closeNewFileTab() {
    const newFileTab = this.tabManager.getByTitle(NEW_FILE_TAB_TITLE);

    if (!newFileTab) {
      return;
    }

    this.closeTab(newFileTab.id);
    this.tabWasClosed(newFileTab.id);
    this.window.webContents.send("newFileBtnVisible", true);
  }

  public setIsInVoiceCall(tabId: number, isInVoiceCall: boolean) {
    this.window.webContents.send("setIsInVoiceCall", { id: tabId, isInVoiceCall });
  }
  public setUsingMicrophone(tabId: number, isUsingMicrophone: boolean) {
    this.window.webContents.send("setUsingMicrophone", { id: tabId, isUsingMicrophone });
  }
  public reload() {
    this.window.reload();
  }
  public reloadTab(tabId: number) {
    this.tabManager.reloadTab(tabId);
  }
  public closeTab(tabId: number) {
    const tab = this.tabManager.getById(tabId);
    const isNewFileTab = this.tabManager.isNewFileTab(tabId);

    this.detachView(tab.view);

    const nextTabId = this.tabManager.close(tabId);

    if (this.tabManager.lastFocusedTab === tabId) {
      if (isNewFileTab) {
        this.tabManager.hasOpenedCommunityTab ? this.setFocusToCommunityTab() : this.setFocusToMainTab();
      } else {
        this.window.webContents.send("focusTab", nextTabId);

        switch (nextTabId) {
          case "mainTab": {
            this.setFocusToMainTab();
            break;
          }
          case "communityTab": {
            this.setFocusToCommunityTab();
            break;
          }
          default: {
            this.setTabFocus(nextTabId);
          }
        }
      }
    }

    if (!this.tabManager.hasOpenedNewFileTab) {
      this.window.webContents.send("newFileBtnVisible", true);
    }
  }
  public getLatestFocusedTabId() {
    return this.tabManager.lastFocusedTab;
  }
  public tabWasClosed(tabId: number) {
    this.window.webContents.send("tabWasClosed", tabId);
  }
  public setFocusToMainTab() {
    const mainTab = this.tabManager.mainTab;

    this.showView(mainTab.view);
    this.tabManager.focusMainTab();
    this.closeNewFileTab();
    this.window.webContents.send("focusTab", "mainTab");

    app.emit("needUpdateMenu", this.id, null, { "close-tab": false });
  }
  public setFocusToCommunityTab() {
    const communityTab = this.tabManager.communityTab;

    if (!communityTab) {
      this.setFocusToMainTab();
      return;
    }

    this.showView(communityTab.view);
    this.tabManager.focusCommunityTab();
    this.closeNewFileTab();
    this.window.webContents.send("focusTab", "communityTab");

    app.emit("needUpdateMenu", this.id, null, { "close-tab": true });
  }
  public setTabFocusByPath(path: string) {
    const tab = this.tabManager.getByPath(path);

    if (tab) {
      this.setTabFocus(tab.id);
    } else {
      if (/recents/.test(path)) {
        this.setFocusToMainTab();
        this.tabManager.loadUrlInMainTab(`${HOMEPAGE}${path}`);
      }
      if (/community/.test(path) && this.tabManager.communityTab) {
        this.setFocusToCommunityTab();
        this.tabManager.loadUrlInCommunityTab(`${HOMEPAGE}${path}`);
      }
    }
  }
  public loadUrlMainTab(url: string) {
    this.tabManager.mainTab.loadUrl(url);
  }
  public setTabFocus(tabId: number) {
    const tab = this.tabManager.getById(tabId);

    this.tabManager.focusTab(tabId);
    this.showView(tab.view);
    this.window.webContents.send("focusTab", tabId);

    app.emit("needUpdateMenu", this.id, tabId, { "close-tab": true });
  }
  public setTabTitle(event: IpcMainEvent, title: string) {
    const tab = this.tabManager.getById(event.sender.id);

    if (!tab || (tab instanceof Tab && tab.title === NEW_FILE_TAB_TITLE)) {
      return;
    }

    this.tabManager.setTitle(tab.id, title);
    this.window.webContents.send("setTitle", { id: tab.view.webContents.id, title });
  }
  public openFile(_: IpcMainEvent, ...args: string[]) {
    let url = `${HOMEPAGE}${args[0]}`;

    if (args[2]) {
      url = `${url}${args[2]}`;
    }

    const tab = this.addTab(url);
    this.setTabFocus(tab.id);
  }
  public closeCommunityTab() {
    if (this.tabManager.communityTab) {
      this.detachView(this.tabManager.communityTab.view);
    }
    this.tabManager.closeCommunityTab();
    this.setFocusToMainTab();

    this.tabManager.hasOpenedCommunityTab = false;
    this.window.webContents.send("communityTabWasClose");
  }
  public openCommunity(args: WebApi.OpenCommunity) {
    const alreadyOpen = this.tabManager.hasOpenedCommunityTab && this.tabManager.communityTab;
    const url = `${HOMEPAGE}${args.path}?fuid=${args.userId}`;

    if (!alreadyOpen) {
      this.tabManager.addCommunityTab();
      this.tabManager.communityTab.userId = args.userId;
      this.tabManager.communityTab.loadUrl(url);
      this.attachView(this.tabManager.communityTab.view);
    }

    this.window.webContents.send("openCommunity");
    this.tabManager.hasOpenedCommunityTab = true;

    this.setFocusToCommunityTab();
  }
  public updateVisibleNewProjectBtn(_: IpcMainEvent, visible: boolean) {
    this.window.webContents.send("updateVisibleNewProjectBtn", visible);
  }
  public handleCallbackForTab(webContentsId: number, cbId: number, args: any) {
    this.tabManager.handleCallbackForTab(webContentsId, cbId, args);
  }

  public changeTheme(_: IpcMainEvent, theme: Themes.Theme) {
    this.loadCurrentTheme(theme);

    storage.settings.theme.currentTheme = theme.id;
  }

  public handleFrontReady() {
    this.window.webContents.send("loadSettings", storage.settings);
    this.showHandler(null);
  }

  /** Close the window and release every webContents and listener it owns. */
  public close() {
    app.removeListener("loadCurrentTheme", this.loadCurrentTheme);
    clearTimeout(this.boundsTimer);

    this.tabManager.dispose();
    this.settingsView.dispose();

    if (!this.window.isDestroyed()) {
      this.window.destroy();
    }
  }

  private scheduleBoundsUpdate = () => {
    clearTimeout(this.boundsTimer);
    this.boundsTimer = setTimeout(() => this.updateTabsBounds(), 50);
  };

  private registerEvents() {
    app.on("loadCurrentTheme", this.loadCurrentTheme);

    this.window.on("show", this.showHandler.bind(this));
    this.window.on("resize", () => this.updateTabsBounds());
    this.window.on("maximize", this.scheduleBoundsUpdate);
    this.window.on("unmaximize", this.scheduleBoundsUpdate);
    this.window.on("enter-full-screen", this.onEnterFullScreen.bind(this));
    this.window.on("leave-full-screen", this.onLeaveFullScreen.bind(this));
    this.window.on("enter-full-screen", this.scheduleBoundsUpdate);
    this.window.on("leave-full-screen", this.scheduleBoundsUpdate);
    this.window.on("focus", () => app.emit("windowFocus", this.window.id));
    // Window manager close button / Alt+F4 / "Close window" go through the same cleanup.
    this.window.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      app.emit("windowClose", this.window.id);
    });

    this.window.webContents.on("did-finish-load", this.webContentDidFinishLoad.bind(this));
  }
}
