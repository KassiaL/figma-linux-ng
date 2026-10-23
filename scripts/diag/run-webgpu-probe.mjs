#!/usr/bin/env node
// Runs the standalone WebGPU probe (scripts/diag/webgpu-probe) with the Chromium
// switches of each Figma Linux NG GPU profile and prints one line per profile:
// adapter, fallback (software) or not, whether a triangle was really rendered
// (pixel readback), and whether the GPU process kept its seccomp sandbox.
//
//   npm run diag:webgpu              all profiles
//   npm run diag:webgpu -- vulkan    one profile
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const electron = join(root, "node_modules", "electron", "dist", "electron");
const isX11 = process.env.XDG_SESSION_TYPE !== "wayland";

// Keep in sync with src/main/Gpu/index.ts
const profiles = {
  "chromium-default": [],
  vulkan: ["enable-features=Vulkan", ...(isX11 ? ["disable-vulkan-surface"] : [])],
  "vulkan-swapchain": ["enable-features=Vulkan"],
  "angle-vulkan": ["use-angle=vulkan", "enable-features=Vulkan,VulkanFromANGLE"],
  "unsafe-webgpu-only (trap)": ["enable-unsafe-webgpu"],
};

const only = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), "flng-probe-"));

for (const [name, flags] of Object.entries(profiles)) {
  if (only && !name.startsWith(only)) continue;
  const out = join(dir, `${name.replace(/\W+/g, "_")}.json`);
  try {
    execFileSync(electron, [join(root, "scripts/diag/webgpu-probe"), `--probe-out=${out}`, `--probe-flags=${flags.join("|")}`, "--probe-hidden"], {
      stdio: "ignore",
      timeout: 45000,
    });
    const r = JSON.parse(readFileSync(out, "utf8"));
    const p = r.page || {};
    const a = p.adapterInfo || {};
    const gpu = (r.procs || []).find((x) => x.type === "GPU");
    const verdict = !p.adapter
      ? "NO ADAPTER"
      : a.isFallbackAdapter
        ? "SOFTWARE (fallback adapter)"
        : p.triangleRendered
          ? "HARDWARE OK"
          : "adapter ok, render FAILED";
    console.log(
      `${name.padEnd(28)} ${verdict.padEnd(28)} ${(a.vendor ? `${a.vendor}/${a.architecture}` : "-").padEnd(18)} ` +
        `vulkan=${r.featureStatus?.vulkan} gpu-seccomp=${gpu?.seccomp ?? "?"}${p.error ? `  (${p.error})` : ""}`,
    );
  } catch (e) {
    console.log(`${name.padEnd(28)} probe failed: ${e.message.split("\n")[0]}`);
  }
}
console.log(`\nraw results: ${dir}`);
