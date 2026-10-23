import { app, ipcMain, WebContentsView, Rectangle, IpcMainEvent } from "electron";
import { storage } from "Main/Storage";
import { isDev } from "Utils/Common";
import { settingsUrlProd, settingsUrlDev, toggleDetachedDevTools } from "Utils/Main";
import { dialogs } from "Main/Dialogs";

/**
 * Local settings page (trusted file:// content). It keeps Node integration for the
 * Svelte UI and <webview> for the theme creator preview; webviews are restricted to
 * figma.com without preload in Main/Session (will-attach-webview).
 */
export default class SettingsView {
  private enableColorSpaceSrgbWasChanged = false;
  private disableThemesChanged = false;
  private chromiumFlagsChanged = false;
  private loaded = false;

  public view: WebContentsView;

  constructor() {
    this.view = new WebContentsView({
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        experimentalFeatures: false,
        webviewTag: true,
        spellcheck: false,
      },
    });
    this.view.setVisible(false);

    this.registerEvents();
  }

  public closeDevTools() {
    if (this.view.webContents.isDevToolsOpened()) {
      this.view.webContents.closeDevTools();
    }
  }

  public postClose() {
    this.view.setVisible(false);

    let id = 1;
    if (this.enableColorSpaceSrgbWasChanged) {
      id = dialogs.showMessageBoxSync({
        type: "question",
        title: "Figma",
        message: "Restart to Change Color Space?",
        detail: `Figma needs to be restarted to change the color space.`,
        textOkButton: "Restart",
        defaultFocusedButton: "Ok",
      });
    }
    if (this.chromiumFlagsChanged) {
      id = dialogs.showMessageBoxSync({
        type: "question",
        title: "Figma",
        message: "Restart to apply Chromium flags?",
        detail: `Figma needs to be restarted to apply Chromium flags.`,
        textOkButton: "Restart",
        defaultFocusedButton: "Ok",
      });
    }
    if (this.disableThemesChanged) {
      let text = "Restart to disable themes?";
      const disableThemes = storage.settings.app.disableThemes;

      if (!disableThemes) {
        text = "Restart to enable themes?";
      }

      id = dialogs.showMessageBoxSync({
        type: "question",
        title: "Figma",
        message: text,
        detail: `Figma needs to be restarted to change use of themes.`,
        textOkButton: "Restart",
        defaultFocusedButton: "Ok",
      });
    }

    if (!id) {
      app.emit("relaunchApp");
    }
  }

  // The settings page is loaded on first open instead of with every window.
  public updateProps(bounds: Rectangle) {
    if (!this.loaded) {
      this.loaded = true;
      this.view.webContents.loadURL(isDev ? settingsUrlDev : settingsUrlProd);
      isDev && toggleDetachedDevTools(this.view.webContents);
    }

    this.enableColorSpaceSrgbWasChanged = false;
    this.disableThemesChanged = false;
    this.chromiumFlagsChanged = false;
    this.view.setBounds({
      height: bounds.height,
      width: bounds.width,
      y: 0,
      x: 0,
    });
  }

  public toggleThemeCreatorPreviewMask() {
    this.view.webContents.send("toggleThemeCreatorPreviewMask");
  }

  public dispose() {
    ipcMain.removeListener("changeTheme", this.changeTheme);
    ipcMain.removeListener("frontReady", this.handleFrontReady);
    app.removeListener("enableColorSpaceSrgbWasChanged", this.enableColorSpaceSrgbChange);
    app.removeListener("chromiumFlagsChanged", this.chromiumFlagsChange);
    app.removeListener("disableThemesChanged", this.disableThemesChange);
    app.removeListener("syncThemesEnd", this.syncThemesEnd);
    app.removeListener("loadCurrentTheme", this.loadCurrentTheme);
    app.removeListener("loadCreatorThemes", this.loadCreatorThemes);

    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
  }

  private send(channel: string, ...args: any[]) {
    if (this.loaded && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send(channel, ...args);
    }
  }

  private enableColorSpaceSrgbChange = (enabled: boolean) => {
    const previousValue = storage.settings.app.enableColorSpaceSrgb;

    if (enabled === previousValue) {
      return;
    }

    this.enableColorSpaceSrgbWasChanged = true;
  };
  private chromiumFlagsChange = (enabled: boolean) => {
    this.chromiumFlagsChanged = enabled;
  };
  private disableThemesChange = (enabled: boolean) => {
    const previousValue = storage.settings.app.disableThemes;

    if (enabled === previousValue) {
      return;
    }

    this.disableThemesChanged = true;
  };
  private syncThemesEnd = (themes: Themes.Theme[]) => {
    this.send("themesLoaded", themes);
  };
  private loadCurrentTheme = (theme: Themes.Theme) => {
    this.send("loadCurrentTheme", theme);
  };
  private loadCreatorThemes = (themes: Themes.Theme[]) => {
    this.send("loadCreatorThemes", themes);
  };
  private changeTheme = (_: IpcMainEvent, theme: Themes.Theme) => {
    this.loadCurrentTheme(theme);

    storage.settings.theme.currentTheme = theme.id;
  };
  private handleFrontReady = () => {
    this.send("loadSettings", storage.settings);
  };

  private registerEvents() {
    ipcMain.on("changeTheme", this.changeTheme);
    ipcMain.on("frontReady", this.handleFrontReady);

    app.on("enableColorSpaceSrgbWasChanged", this.enableColorSpaceSrgbChange);
    app.on("chromiumFlagsChanged", this.chromiumFlagsChange);
    app.on("disableThemesChanged", this.disableThemesChange);
    app.on("syncThemesEnd", this.syncThemesEnd);
    app.on("loadCurrentTheme", this.loadCurrentTheme);
    app.on("loadCreatorThemes", this.loadCreatorThemes);
  }
}
