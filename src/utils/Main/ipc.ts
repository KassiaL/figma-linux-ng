import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

import { isFigmaOrigin } from "Utils/Common";

type Event = IpcMainEvent | IpcMainInvokeEvent;

const senderUrl = (event: Event): string => {
  try {
    return event.senderFrame?.url ?? event.sender.getURL();
  } catch {
    return "";
  }
};

/** IPC from the app's own local pages (panel, settings, diagnostics). */
export const isLocalAppSender = (event: Event): boolean => {
  const url = senderUrl(event);

  return url.startsWith("file://") || /^http:\/\/localhost:\d+\//.test(url);
};

/** IPC from a figma.com frame (top-level Figma page, not a plugin iframe on another origin). */
export const isFigmaSender = (event: Event): boolean => isFigmaOrigin(senderUrl(event));

export const isTrustedSender = (event: Event): boolean => isFigmaSender(event) || isLocalAppSender(event);

export const describeSender = (event: Event): string => senderUrl(event) || `webContents#${event.sender?.id}`;
