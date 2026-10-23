import { fileURLToPath } from "url";
import { spawn } from "child_process";
import path from "path";
import svelte from "rollup-plugin-svelte";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve as resolve } from "@rollup/plugin-node-resolve";
import livereload from "rollup-plugin-livereload";
import dev from "rollup-plugin-dev";
import alias from "@rollup/plugin-alias";
import terser from "@rollup/plugin-terser";
import sveltePreprocess from "svelte-preprocess";
import typescript from "@rollup/plugin-typescript";
import css from "rollup-plugin-css-only";
import copy from "rollup-plugin-copy";
import postcss from "rollup-plugin-postcss";

import dotenv from "dotenv";
dotenv.config();

const panelPort = process.env.DEV_PANEL_PORT ?? 3330;
const settingsPort = process.env.DEV_SETTINGS_PORT ?? 3331;
const production = process.env.NODE_ENV !== "dev";
const watch = process.env.ROLLUP_WATCH === "true";
const projectRootDir = path.dirname(fileURLToPath(import.meta.url));
const commonExternal = ["electron"];
const commonPlugins = [
  typescript({
    tsconfig: "src/renderer/tsconfig.json",
    sourceMap: !production,
    inlineSources: !production,
  }),

  alias({
    entries: [
      {
        find: "Types",
        replacement: path.resolve(projectRootDir, "..", "src/types"),
      },
      {
        find: "Const",
        replacement: path.resolve(projectRootDir, "..", "src/constants"),
      },
      {
        find: "Utils",
        replacement: path.resolve(projectRootDir, "..", "src/utils"),
      },
      {
        find: "Common",
        replacement: path.resolve(projectRootDir, "..", "src/renderer/Common"),
      },
      {
        find: "Containers",
        replacement: path.resolve(projectRootDir, "..", "src/renderer/Common/Containers"),
      },
      {
        find: "Icons",
        replacement: path.resolve(projectRootDir, "..", "src/renderer/Common/Icons"),
      },
    ],
  }),
];

const svelteFrontendPlugins = [
  svelte({
    preprocess: sveltePreprocess({
      sourceMap: !production,
    }),
    compilerOptions: {
      dev: !production,
    },
  }),
  postcss({
    extract: "base.css",
  }),
  css({
    output: "bundle.css",
  }),
  resolve({
    browser: false,
    dedupe: ["svelte"],
  }),
  commonjs(),
  ...commonPlugins,
  watch && livereload("dist"),
  production && terser(),
];

function runElectron() {
  let server;

  function toExit() {
    if (server) server.kill(0);
  }

  return {
    writeBundle() {
      if (server) return;
      server = spawn("npm", ["run", "run:watch", "--", "--dev"], {
        stdio: ["ignore", "inherit", "inherit"],
        shell: true,
      });

      process.on("SIGTERM", toExit);
      process.on("exit", toExit);
    },
  };
}

export default [
  {
    input: "src/renderer/DesktopAPI/loadContent.ts",
    output: {
      sourcemap: !production,
      format: "cjs",
      name: "app",
      file: "dist/renderer/loadContent.js",
    },
    external: commonExternal,
    plugins: [...commonPlugins, production && terser()],
  },
  {
    input: "src/renderer/DesktopAPI/loadMainContent.ts",
    output: {
      sourcemap: !production,
      format: "cjs",
      name: "app",
      file: "dist/renderer/loadMainContent.js",
    },
    external: commonExternal,
    plugins: [...commonPlugins, production && terser()],
  },
  {
    input: "src/renderer/Diagnostics/preload.ts",
    output: {
      sourcemap: !production,
      format: "cjs",
      name: "app",
      file: "dist/renderer/diagnosticsPreload.js",
    },
    external: commonExternal,
    plugins: [...commonPlugins, production && terser()],
  },
  {
    input: "src/renderer/DesktopAPI/themePreviewPreload.ts",
    output: {
      sourcemap: !production,
      format: "cjs",
      name: "app",
      file: "dist/renderer/themePreviewPreload.js",
    },
    external: commonExternal,
    plugins: [...commonPlugins, production && terser()],
  },
  {
    input: "src/renderer/Settings/index.ts",
    output: {
      sourcemap: !production,
      format: "cjs",
      name: "app",
      file: "dist/renderer/settings.js",
    },
    external: commonExternal,
    plugins: [
      ...svelteFrontendPlugins,
      watch &&
        dev({
          spa: "dist/settings.html",
          host: "localhost",
          port: settingsPort,
          proxy: [
            {
              from: "/renderer/settings.js",
              to: `http://localhost:${settingsPort}/dist/renderer/settings.js`,
            },
            {
              from: "/renderer/base.css",
              to: `http://localhost:${settingsPort}/dist/renderer/base.css`,
            },
          ],
        }),
    ],
    watch: {
      clearScreen: false,
    },
  },
  {
    input: "src/renderer/Panel/index.ts",
    output: {
      sourcemap: !production,
      format: "cjs",
      name: "app",
      file: "dist/renderer/panel.js",
    },
    external: commonExternal,
    plugins: [
      ...svelteFrontendPlugins,
      copy({
        targets: [
          {
            src: "src/package.json",
            dest: "dist",
          },
          {
            src: "src/index.html",
            dest: "dist",
          },
          {
            src: "src/settings.html",
            dest: "dist",
          },
          {
            src: "src/diagnostics.html",
            dest: "dist",
          },
        ],
      }),
      watch && runElectron(),
      watch &&
        dev({
          spa: "dist/index.html",
          host: "localhost",
          port: panelPort,
          proxy: [
            {
              from: "/renderer/panel.js",
              to: `http://localhost:${panelPort}/dist/renderer/panel.js`,
            },
            {
              from: "/renderer/base.css",
              to: `http://localhost:${panelPort}/dist/renderer/base.css`,
            },
          ],
        }),
    ],
    watch: {
      clearScreen: false,
    },
  },
];
