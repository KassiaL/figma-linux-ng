// Keep first: sets app identity and profile paths before anything reads userData.
import "./bootstrap";
import { applyGpuSwitches } from "./Gpu";

import App from "./App";
import Session from "./Session";
import FontManager from "./Fonts";
import ExtensionManager from "./ExtensionManager";
import ThemeManager from "./Ui/ThemeManager";
import ThemeValidator from "./Ui/ThemeManager/ThemeValidator";
import WindowManager from "./Ui/WindowManager";
import { logger } from "./Logger";

process.on("uncaughtException", (error: Error) => {
  logger.error(`uncaughtException: `, error);
});
process.on("unhandledRejection", (reason: Error) => {
  logger.error(`unhandledRejection: `, reason);
});

const gpuPlan = applyGpuSwitches();
logger.info(
  `[gpu] profile=${gpuPlan.profile} switches=${JSON.stringify(gpuPlan.switches)} ` +
    `enable-features=${gpuPlan.enableFeatures.join(",")}`,
);
gpuPlan.warnings.forEach((w) => logger.warn(`[gpu] ${w}`));

new App(
  new WindowManager(),
  new ExtensionManager(),
  new Session(),
  new FontManager(),
  new ThemeManager(new ThemeValidator()),
);
