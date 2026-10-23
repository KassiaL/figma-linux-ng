/**
 * Chromium GPU switches. Applied once, before `app.ready`.
 *
 * Measured with scripts/diag/webgpu-probe on Electron 45 / Chromium 156,
 * Ubuntu 24.04 X11, RTX 4060, driver 580 (see docs/WEBGPU.md):
 *
 *  - no switches                 -> navigator.gpu exists, requestAdapter() === null
 *  - enable-unsafe-webgpu only   -> adapter is SwiftShader (software, isFallbackAdapter)
 *  - enable-features=Vulkan      -> hardware NVIDIA adapter, GPU process stays seccomp-sandboxed
 *  - + use-angle=vulkan          -> hardware adapter too, but Chromium runs the GPU process
 *                                   without its seccomp sandbox
 *  - VulkanFromANGLE without use-angle=vulkan -> Vulkan init fails, adapter null
 *
 * So the default profile is "vulkan": WebGPU on Dawn/Vulkan, WebGL/compositing on ANGLE/OpenGL.
 */
import { app } from "electron";

import { cliArg, cliFlag } from "Main/bootstrap";
import { storage } from "Main/Storage";

interface Plan {
  profile: Types.GpuProfile;
  switches: Array<[string, string?]>;
  enableFeatures: string[];
  disableFeatures: string[];
  warnings: string[];
}

const PROFILES: Types.GpuProfile[] = ["vulkan", "angle-vulkan", "chromium-default", "software"];

const splitList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function buildGpuPlan(settings: Types.SettingsInterface["app"]): Plan {
  const requested = cliArg("gpu-profile") as Types.GpuProfile | undefined;
  const profile = PROFILES.includes(requested) ? requested : settings.gpuProfile ?? "vulkan";
  const plan: Plan = { profile, switches: [], enableFeatures: [], disableFeatures: [], warnings: [] };

  switch (profile) {
    case "vulkan":
      plan.enableFeatures.push("Vulkan");
      break;
    case "angle-vulkan":
      plan.switches.push(["use-angle", "vulkan"]);
      plan.enableFeatures.push("Vulkan", "VulkanFromANGLE");
      plan.warnings.push(
        "gpuProfile=angle-vulkan: Chromium disables the GPU process seccomp sandbox with ANGLE/Vulkan",
      );
      break;
    case "software":
      plan.switches.push(["disable-gpu"]);
      break;
    case "chromium-default":
      break;
  }

  if (settings.enableUnsafeWebGpu || cliFlag("enable-unsafe-webgpu")) {
    plan.switches.push(["enable-unsafe-webgpu"]);
    if (profile !== "vulkan" && profile !== "angle-vulkan") {
      plan.warnings.push("enable-unsafe-webgpu without Vulkan exposes the SwiftShader software adapter");
    }
  }

  const ozone = cliArg("ozone-platform") ?? settings.ozonePlatform;
  if (ozone && ozone !== "auto") {
    plan.switches.push(["ozone-platform", ozone]);
  }

  if (settings.enableColorSpaceSrgb) {
    plan.switches.push(["force-color-profile", "srgb"]);
  }

  // User switches from settings. enable/disable-features are merged instead of
  // appended: Chromium only honours the last occurrence of a switch.
  for (const item of settings.commandSwitches ?? []) {
    if (!item?.switch) continue;
    const name = item.switch.replace(/^-+/, "");

    if (name === "enable-features") plan.enableFeatures.push(...splitList(item.value));
    else if (name === "disable-features") plan.disableFeatures.push(...splitList(item.value));
    else if (name === "no-sandbox" || name === "disable-gpu-sandbox") {
      plan.warnings.push(`ignored "${name}" from settings: sandbox switches must be passed explicitly on the command line`);
    } else plan.switches.push([name, item.value]);
  }

  // Features given on the real command line are kept as well.
  plan.enableFeatures.push(...splitList(app.commandLine.getSwitchValue("enable-features")));
  plan.disableFeatures.push(...splitList(app.commandLine.getSwitchValue("disable-features")));
  plan.enableFeatures = [...new Set(plan.enableFeatures)];
  plan.disableFeatures = [...new Set(plan.disableFeatures)];

  return plan;
}

export let appliedGpuPlan: Plan | undefined;

export function applyGpuSwitches(): Plan {
  const plan = buildGpuPlan(storage.settings.app);

  for (const [name, value] of plan.switches) {
    value === undefined ? app.commandLine.appendSwitch(name) : app.commandLine.appendSwitch(name, value);
  }
  if (plan.enableFeatures.length) {
    app.commandLine.appendSwitch("enable-features", plan.enableFeatures.join(","));
  }
  if (plan.disableFeatures.length) {
    app.commandLine.appendSwitch("disable-features", plan.disableFeatures.join(","));
  }

  appliedGpuPlan = plan;

  return plan;
}
