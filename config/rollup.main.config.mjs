import { fileURLToPath } from "url";
import { spawn } from "child_process";
import path from "path";
import commonjs from "@rollup/plugin-commonjs";
import alias from "@rollup/plugin-alias";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

import dotenv from "dotenv";
dotenv.config();

const watch = process.env.ROLLUP_WATCH === "true";
const production = process.env.NODE_ENV !== "dev";
const projectRootDir = path.dirname(fileURLToPath(import.meta.url));

export default {
  input: "src/main/index.ts",
  // Node built-ins, electron and runtime deps stay require()s (resolved from dist/node_modules when packaged).
  external: (id) => /^(electron|node:|fs|path|os|child_process|util|crypto|url|events|stream|zlib)(\/|$)/.test(id) || ["chokidar", "adm-zip"].includes(id),
  output: {
    sourcemap: !production,
    format: "cjs",
    name: "app",
    file: "dist/main/main.js",
  },
  plugins: [
    commonjs(),
    typescript({
      tsconfig: "tsconfig.json",
      sourceMap: !production,
      inlineSources: !production,
    }),

    alias({
      entries: [
        {
          find: "Main",
          replacement: path.resolve(projectRootDir, "src/main"),
        },
        {
          find: "Types",
          replacement: path.resolve(projectRootDir, "src/types"),
        },
        {
          find: "Utils",
          replacement: path.resolve(projectRootDir, "src/utils"),
        },
        {
          find: "Enums",
          replacement: path.resolve(projectRootDir, "src/types/enums.ts"),
        },
        {
          find: "Storage",
          replacement: path.resolve(projectRootDir, "src/main/Storage.ts"),
        },
        {
          find: "Const",
          replacement: path.resolve(projectRootDir, "src/constants"),
        },
      ],
    }),
    production && terser(),
  ],
  watch: {
    clearScreen: false,
  },
};
