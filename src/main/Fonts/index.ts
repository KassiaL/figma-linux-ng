import { readFile, readdir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { logger } from "Main/Logger";
import { parseFontFile, FigmaFontEntry } from "./FontParser";

interface CachedFont {
  mtimeMs: number;
  size: number;
  items: FigmaFontEntry[] | null; // null: file could not be parsed
}

export type FontList = Record<string, FigmaFontEntry[]>;

// TrueType/OpenType files and collections; Windows fonts often use upper-case extensions.
const FONT_RE = /\.(ttf|otf|ttc|otc)$/i;
const HOME = homedir();

/**
 * Local fonts for Figma's desktop font API.
 *
 * The previous implementation ran a blocking `spawnSync("find")` and re-read and
 * re-parsed every font file on each getFonts/getModifiedFonts call, stalling the
 * main process (and with it every window) whenever Figma refreshed its font list.
 * Now the directory walk is async, parsed results are cached per file
 * (mtime + size), and concurrent requests share one scan.
 */
export default class FontManager {
  private cache = new Map<string, CachedFont>();
  private knownFiles = new Set<string>();
  private pending: Promise<FontList> | null = null;

  public getFonts = (dirs: Array<string>): Promise<FontList> => {
    if (!this.pending) {
      this.pending = this.scan(dirs).finally(() => {
        this.pending = null;
      });
    }

    return this.pending;
  };

  public getFontFile = async (path: string, dirs: Array<string>): Promise<Buffer | null> => {
    if (!this.isAllowedFontPath(path, dirs)) {
      logger.warn("[fonts] refused to read a file that is not a scanned font:", path);
      return null;
    }

    return readFile(path);
  };

  // A font returned by the last scan, or (before the first scan) a font file inside a font dir.
  private isAllowedFontPath(path: string, dirs: Array<string>) {
    if (typeof path !== "string") return false;
    const full = resolve(path);

    if (this.knownFiles.has(full)) return true;

    return FONT_RE.test(full) && dirs.some((dir) => full.startsWith(resolve(dir) + "/"));
  }

  private async scan(dirs: Array<string>): Promise<FontList> {
    const started = Date.now();
    const seenDirs = new Set<string>();
    const seenFiles = new Set<string>();
    const files: string[] = [];
    for (const dir of dirs) {
      await this.walk(dir, seenDirs, seenFiles, files);
    }
    const fontList: FontList = {};
    let parsed = 0;

    this.knownFiles = new Set(files);

    for (const path of files) {
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }

      let entry = this.cache.get(path);
      if (!entry || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
        const items = await this.parse(path);
        const extra = { modified_at: Math.floor(info.mtimeMs / 1000), user_installed: path.startsWith(HOME + "/") };
        entry = { mtimeMs: info.mtimeMs, size: info.size, items: items && items.map((i) => ({ ...i, ...extra })) };
        this.cache.set(path, entry);
        parsed++;
      }
      if (entry.items) {
        fontList[path] = entry.items;
      }
    }

    for (const path of this.cache.keys()) {
      if (!this.knownFiles.has(path)) this.cache.delete(path);
    }

    const faces = Object.values(fontList).reduce((n, items) => n + items.length, 0);
    const families = new Set(Object.values(fontList).flatMap((items) => items.map((i) => i.family))).size;
    logger.info(`[fonts] ${files.length} files, ${faces} faces, ${families} families (${parsed} parsed) in ${Date.now() - started} ms`);

    return fontList;
  }

  private async parse(path: string): Promise<FigmaFontEntry[] | null> {
    try {
      const items = parseFontFile(await readFile(path));

      return items.length ? items : null;
    } catch (error) {
      logger.warn(`skip font: ${path}, error: `, error?.message);
      return null;
    }
  }

  /**
   * Recursive scan that follows symlinks (Ubuntu ships e.g. Ubuntu-BI.ttf as a link;
   * the old `find -type f` skipped those), guards against directory loops and keeps
   * one path per real file.
   */
  private async walk(dir: string, seenDirs: Set<string>, seenFiles: Set<string>, out: string[]): Promise<void> {
    let real: string;
    let entries;
    try {
      real = await realpath(dir);
      if (seenDirs.has(real)) return;
      seenDirs.add(real);
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = resolve(join(dir, entry.name));
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(full);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // dangling link
        }
      }

      if (isDir) {
        await this.walk(full, seenDirs, seenFiles, out);
      } else if (isFile && FONT_RE.test(entry.name)) {
        let realFile = full;
        try {
          realFile = await realpath(full);
        } catch {
          continue;
        }
        if (!seenFiles.has(realFile)) {
          seenFiles.add(realFile);
          out.push(full);
        }
      }
    }
  }
}
