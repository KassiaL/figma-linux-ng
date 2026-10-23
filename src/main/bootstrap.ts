/**
 * Must be the first import of the main entry: it fixes the app identity and the
 * profile/cache locations before any module (Storage, Logger) touches userData.
 *
 * Figma Linux NG keeps its data apart from the upstream Figma Linux client
 * (~/.config/figma-linux, ~/snap/figma-linux), so both can be installed side by side.
 */
import { app } from "electron";
import * as path from "path";

export const APP_ID = "figma-linux-ng";
export const APP_NAME = "Figma Linux NG";

export const cliArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));

  return found ? found.slice(prefix.length) : undefined;
};
export const cliFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const home = app.getPath("home");
const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const xdgCache = process.env.XDG_CACHE_HOME || path.join(home, ".cache");

// --profile-dir lets tests and diagnostics run against a throwaway profile.
const profileDir = cliArg("profile-dir");
const userData = profileDir ? path.resolve(profileDir) : path.join(xdgConfig, APP_ID);
const cacheDir = profileDir ? path.join(userData, "cache") : path.join(xdgCache, APP_ID);

app.setName(APP_NAME);
app.setPath("userData", userData);
app.setPath("sessionData", userData);
app.setPath("crashDumps", path.join(userData, "Crashpad"));
app.setPath("logs", path.join(userData, "logs"));
// HTTP disk cache goes to XDG cache dir; cookies, IndexedDB, local storage stay in userData.
// The cache is never wiped on startup: Figma relies on it for fast file reopening.
app.commandLine.appendSwitch("disk-cache-dir", cacheDir);

export const paths = { userData, cacheDir };
