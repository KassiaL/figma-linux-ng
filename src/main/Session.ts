import { app, session, shell, WebContents } from "electron";
import * as path from "path";

import * as Const from "Const";
import { logger } from "./Logger";
import { cliArg } from "./bootstrap";
import { dialogs } from "./Dialogs";
import { storage } from "./Storage";
import { isFigmaOrigin, isFigmaHost, parseURL } from "Utils/Common";

// Permissions Figma pages may get without asking. Everything else is denied.
const FIGMA_ALLOWED_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "keyboardLock",
]);

const WINDOWS_PLATFORM = "Windows NT 10.0; Win64; x64";

/**
 * User agent for the Figma session. With userAgentOS = "windows" Figma's web app
 * talks to the Windows Figma Font Agent (run through Wine) on 127.0.0.1:44950.
 * The session only ever loads figma.com (other links go to the system browser),
 * so the override effectively applies to Figma requests only.
 */
export function buildUserAgent(defaultUserAgent: string, os: Types.SettingsInterface["app"]["userAgentOS"]) {
  if (os !== "windows") {
    return defaultUserAgent;
  }

  return defaultUserAgent.replace(/\(X11; Linux [^)]+\)|\(X11; [^)]+\)/, `(${WINDOWS_PLATFORM})`);
}

/** Only hand http(s)/mailto links to the OS; never file:, javascript:, custom schemes. */
export function openExternalSafe(url: string) {
  const parsed = parseURL(url);

  if (!parsed || !["https:", "http:", "mailto:"].includes(parsed.protocol)) {
    logger.warn("[security] blocked openExternal for:", url);
    return;
  }

  shell.openExternal(parsed.toString()).catch((error) => logger.error("openExternal failed:", error));
}

// webContents of in-app sign-in windows: they may visit any https IdP (Google, SAML, ...).
const authContents = new WeakSet<WebContents>();
export const markAuthContents = (contents: WebContents) => authContents.add(contents);

export default class Session {
  private _hasFigmaSession: boolean;
  private microphoneAllowed = false;

  constructor() {
    this._hasFigmaSession = null;

    app.on("web-contents-created", this.onWebContentsCreated);
  }

  public get hasFigmaSession() {
    return this._hasFigmaSession;
  }

  public handleAppReady = () => {
    const ses = session.defaultSession;
    const cliOs = cliArg("user-agent-os");
    const os = cliOs === "linux" || cliOs === "windows" ? cliOs : storage.settings.app.userAgentOS;

    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const origin = details.requestingUrl || webContents?.getURL() || "";

      if (!isFigmaOrigin(origin)) {
        return callback(false);
      }
      if (FIGMA_ALLOWED_PERMISSIONS.has(permission)) {
        return callback(true);
      }
      if (permission === "media") {
        // Voice calls need the microphone; camera is never granted.
        const onlyAudio = (details as Electron.MediaAccessPermissionRequest).mediaTypes?.every(
          (t) => t === "audio",
        );
        if (!onlyAudio) return callback(false);
        if (!this.microphoneAllowed) {
          const id = dialogs.showMessageBoxSync({
            type: "question",
            title: "Figma",
            message: "Microphone access required for voice call.",
            detail: "Allow microphone access?",
            textOkButton: "Allow",
            textCancelButton: "Deny",
            defaultFocusedButton: "Ok",
          });
          this.microphoneAllowed = id === 0;
        }
        return callback(this.microphoneAllowed);
      }

      logger.debug(`[security] denied permission "${permission}" for ${origin}`);
      callback(false);
    });
    ses.setPermissionCheckHandler((_, permission, requestingOrigin) => {
      return isFigmaOrigin(requestingOrigin) && FIGMA_ALLOWED_PERMISSIONS.has(permission);
    });

    ses.setUserAgent(buildUserAgent(ses.getUserAgent(), os));

    if (os === "windows") {
      // Keep the UA client hint consistent with the UA string for figma.com requests.
      ses.webRequest.onBeforeSendHeaders({ urls: ["https://*.figma.com/*", "https://figma.com/*"] }, (details, cb) => {
        const headers = details.requestHeaders;
        if (headers["sec-ch-ua-platform"] || headers["Sec-CH-UA-Platform"]) {
          delete headers["Sec-CH-UA-Platform"];
          headers["sec-ch-ua-platform"] = '"Windows"';
        }
        cb({ requestHeaders: headers });
      });
    }

    ses.cookies
      .get({ url: Const.HOMEPAGE })
      .then((cookies) => {
        this._hasFigmaSession = !!cookies.find((cookie) => cookie.name === Const.FIGMA_SESSION_COOKIE_NAME);

        logger.info("[session] already signed in?", this._hasFigmaSession);
      })
      .catch((error: Error) => logger.warn("[session] failed to get cookies:", Const.HOMEPAGE, error));
  };

  /**
   * Last line of defence for every webContents (tabs, popups, devtools excluded):
   * no <webview> outside the settings page, no navigation of local app pages to
   * remote content, and file drops never replace a Figma page with file:// content.
   */
  private onWebContentsCreated = (_: Electron.Event, contents: WebContents) => {
    contents.on("will-attach-webview", (event, webPreferences, params) => {
      const host = contents.getURL();
      // Only the theme creator preview inside the local settings page uses <webview>.
      if (!host.startsWith("file://") && !host.startsWith("http://localhost:")) {
        event.preventDefault();
        return;
      }
      // Theme creator previews: always our own preload (the page passes a cwd-relative
      // path that never worked in packaged builds), isolated and sandboxed.
      webPreferences.preload = path.join(__dirname, "..", "renderer", "themePreviewPreload.js");
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      delete (params as Record<string, unknown>).preload;
      if (!isFigmaOrigin(params.src)) event.preventDefault();
    });

    // Redirects to figma:// (end of the sign-in flow) do not fire will-navigate.
    contents.on("will-redirect", (event, url) => {
      if (url.startsWith(`${Const.PROTOCOL}:`)) {
        event.preventDefault();
        app.emit("handleFigmaProtocolUrl", url);
      }
    });

    contents.on("will-navigate", (event, url) => {
      const current = contents.getURL();
      const target = parseURL(url);

      if (!target) {
        event.preventDefault();
        return;
      }
      if (target.protocol === `${Const.PROTOCOL}:`) {
        // figma://app_auth/redeem?... and figma:// file links are handled by the app itself
        event.preventDefault();
        app.emit("handleFigmaProtocolUrl", url);
        return;
      }
      if (authContents.has(contents)) {
        if (target.protocol !== "https:") event.preventDefault();
        return;
      }
      if (current.startsWith("file://") || current.startsWith("http://localhost:")) {
        // Local UI pages never navigate (dev server reloads use reload(), not navigation).
        if (target.protocol !== "file:" && !url.startsWith("http://localhost:")) event.preventDefault();
        return;
      }
      if (target.protocol === "file:") {
        // e.g. a file dropped outside of Figma's drop zone
        event.preventDefault();
        return;
      }
      if (target.protocol === "https:" && (isFigmaHost(target.hostname) || this.isAuthHost(target.hostname))) {
        return;
      }

      event.preventDefault();
      openExternalSafe(url);
    });
  };

  // SSO providers Figma's login flow navigates through inside the app.
  private isAuthHost(hostname: string) {
    return (
      hostname === "accounts.google.com" ||
      hostname.endsWith(".okta.com") ||
      hostname.endsWith(".onelogin.com") ||
      hostname === "login.microsoftonline.com"
    );
  }
}
