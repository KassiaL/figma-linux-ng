import {
  app,
  session,
  ipcMain,
  Event,
  IpcMainEvent,
  IpcMainInvokeEvent,
  protocol,
} from "electron";

import * as Const from "Const";
import { request, isFigmaSender, isTrustedSender, describeSender } from "Utils/Main";
import { isAppAuthLink, isValidProjectLink, isFigmaProtocolUrl } from "Utils/Common";
import Args from "./Args";
import { cliFlag } from "./bootstrap";
import { logger } from "./Logger";
import { storage } from "./Storage";
import { readClipboardData, writeClipboardData } from "./Clipboard";
import Diagnostics from "./Diagnostics";
import ExtensionManager from "./ExtensionManager";
import ThemeManager from "./Ui/ThemeManager";
import WindowManager from "./Ui/WindowManager";
import Session from "./Session";
import FontManager from "./Fonts";

export default class App {
  private diagnostics: Diagnostics;

  constructor(
    private windowManager: WindowManager,
    private extensionManager: ExtensionManager,
    private session: Session,
    private fontManager: FontManager,
    private themeManager: ThemeManager,
  ) {
    const isSingleInstance = app.requestSingleInstanceLock();

    if (!isSingleInstance) {
      app.quit();
      return;
    }

    // figma:// is owned by whichever client the user registered (the upstream
    // Figma Linux by default). Taking it over is opt-in so both clients can coexist.
    if (storage.settings.app.registerProtocolHandler || cliFlag("register-protocol")) {
      if (!app.isDefaultProtocolClient(Const.PROTOCOL)) {
        app.setAsDefaultProtocolClient(Const.PROTOCOL);
      }
      storage.settings.app.registerProtocolHandler = true;
    }

    this.diagnostics = new Diagnostics();
    this.registerEvents();
  }

  private ready = (): void => {
    const { figmaUrl } = Args();

    this.session.handleAppReady();
    this.diagnostics.handleAppReady();
    this.windowManager.restoreState();

    if (figmaUrl !== "") {
      this.windowManager.whenReady(() => this.handleFigmaUrl(figmaUrl));
    }

    protocol.handle(Const.PROTOCOL, (req: GlobalRequest) => {
      logger.info("protocol.handle, req.url: ", req.url);
      this.handleFigmaUrl(req.url);

      return new Response(null, { status: 204 });
    });
  };

  private handleFigmaUrl(url: string) {
    if (this.windowManager.tryHandleAppAuthRedeemUrl(url)) {
      return;
    }
    if (isFigmaProtocolUrl(url) || isValidProjectLink(url) || /^https:\/\/(www\.)?figma\.com\//.test(url)) {
      this.windowManager.focusLastWindow();
      this.windowManager.openUrl(url);
    }
  }

  private secondInstance(_: Event, argv: string[]) {
    logger.debug("second-instance, argv: ", argv);

    const authLink = argv.find((i) => isAppAuthLink(i));
    if (authLink) {
      this.windowManager.tryHandleAppAuthRedeemUrl(authLink);
      return;
    }

    const projectLink = argv.find((i) => isValidProjectLink(i) || isFigmaProtocolUrl(i));
    this.windowManager.focusLastWindow();
    if (projectLink) {
      this.windowManager.openUrl(projectLink);
    }
  }
  private frontReady(_: IpcMainEvent) {
    if (!this.session.hasFigmaSession) {
      app.emit("closeAllTab");
    }

    this.themeManager.loadThemes();
    this.themeManager.loadCreatorTheme();
  }
  private setAuthedUsers(_: IpcMainEvent, userIds: string[]) {
    if (!Array.isArray(userIds)) return;
    const known = Array.isArray(storage.settings.authedUserIDs) ? storage.settings.authedUserIDs : [];

    storage.settings.authedUserIDs = [...new Set([...known, ...userIds.map(String)])];
  }
  private setWorkspaceName(_: IpcMainEvent, name: string) {
    logger.debug("The setWorkspaceName not implemented, workspaceName: ", name);
  }
  private setFigjamEnabled(_: IpcMainEvent, enabled: boolean) {
    logger.debug("The setFigjamEnabled not implemented, enabled: ", enabled);
  }
  private async setClipboardData(event: IpcMainInvokeEvent, data: WebApi.SetClipboardData) {
    if (!isFigmaSender(event)) {
      logger.warn("[security] setClipboardData from untrusted sender:", describeSender(event));
      return false;
    }

    try {
      await writeClipboardData(data);
      return true;
    } catch (error) {
      logger.error("setClipboardData failed:", error);
      return false;
    }
  }
  private async getClipboardData(event: IpcMainInvokeEvent, formats: string[]) {
    if (!isFigmaSender(event)) {
      logger.warn("[security] getClipboardData from untrusted sender:", describeSender(event));
      return null;
    }

    return readClipboardData(formats);
  }
  private async getFonts(event: IpcMainInvokeEvent) {
    if (!isTrustedSender(event)) return {};

    return this.fontManager.getFonts(storage.settings.app.fontDirs);
  }
  private async getFontFile(event: IpcMainInvokeEvent, data: WebApi.GetFontFile) {
    if (!isTrustedSender(event)) return null;

    // Only files that the font scan returned may be read (not arbitrary paths).
    const file = await this.fontManager.getFontFile(data?.path, storage.settings.app.fontDirs);

    if (file && file.byteLength > 0) {
      return file;
    }

    return null;
  }
  private async logout() {
    try {
      await request({
        url: Const.LOGOUT_PAGE,
        useSessionCookies: true,
      });
    } catch (error) {
      logger.error("logout request failed:", error);
    }

    // TODO: remove only current user's id
    storage.settings.authedUserIDs = [];

    try {
      await Promise.all([
        session.defaultSession.clearStorageData(),
        session.defaultSession.clearCache(),
      ]);
    } catch (error) {
      logger.error(error);
    }

    this.windowManager.closeTabOnAllWindows();
    this.windowManager.loadLoginPageAllWindows();
  }
  private onWindowAllClosed() {
    app.quit();
  }
  private relaunchApp() {
    app.relaunch();
    app.quit();
  }
  private quitApp() {
    this.windowManager.saveState();
    storage.save();

    app.quit();
  }

  private registerEvents = (): void => {
    ipcMain.on("frontReady", this.frontReady.bind(this));
    ipcMain.on("setAuthedUsers", this.setAuthedUsers.bind(this));
    ipcMain.on("setWorkspaceName", this.setWorkspaceName.bind(this));
    ipcMain.on("setFigjamEnabled", this.setFigjamEnabled.bind(this));

    ipcMain.handle("setClipboardData", this.setClipboardData.bind(this));
    ipcMain.handle("getClipboardData", this.getClipboardData.bind(this));
    ipcMain.handle("getFonts", this.getFonts.bind(this));
    ipcMain.handle("getFontFile", this.getFontFile.bind(this));

    app.on("ready", this.ready.bind(this));
    app.on("second-instance", this.secondInstance.bind(this));
    app.on("window-all-closed", this.onWindowAllClosed.bind(this));
    app.on("relaunchApp", this.relaunchApp.bind(this));
    app.on("signOut", this.logout.bind(this));
    app.on("quitApp", this.quitApp.bind(this));
    app.on("handleFigmaProtocolUrl", this.handleFigmaUrl.bind(this));
    app.on("before-quit", () => {
      this.windowManager.saveState();
      storage.save();
    });
  };
}
