import { randomUUID } from "crypto";
import { LogLevel } from "Types/enums";

export const DEFAULT_SETTINGS: Types.SettingsInterface = {
  clientId: randomUUID(),
  userId: "",
  authedUserIDs: [],
  app: {
    logLevel: LogLevel.INFO,
    lastTimeClearLogFile: 0,
    enableColorSpaceSrgb: false,
    visibleNewProjectBtn: true,
    useZenity: false,
    disableThemes: false,
    panelHeight: 40,
    saveLastOpenedTabs: true,
    exportDir: `${process.env.HOME}/Pictures/Figma`,
    // Extra user-defined Chromium switches. GPU switches come from gpuProfile (see Main/Gpu).
    commandSwitches: [],
    fontDirs: [
      "/usr/share/fonts",
      "/usr/local/share/fonts",
      "/run/host/fonts",
      "/run/host/user-fonts",
      `${process.env.HOME}/.local/share/fonts`,
    ],
    recentlyClosedTabs: [],
    windowsState: {},
    lastOpenedTabs: {},
    featureFlags: {},
    savedExtensions: [],
    themeDropdownOpen: true,
    creatorsThemesDropdownOpen: false,
    useOldPreviewer: false,
    dontShowTutorialCreator: false,
    gpuProfile: "vulkan",
    enableUnsafeWebGpu: false,
    ozonePlatform: "auto",
    userAgentOS: "windows",
    lazyRestoreTabs: true,
    webgpuInstrumentation: false,
    registerProtocolHandler: false,
  },
  theme: {
    currentTheme: "0",
  },
  ui: {
    scalePanel: 1,
    scaleFigmaUI: 1,
  },
};
