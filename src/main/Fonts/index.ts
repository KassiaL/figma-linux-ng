import { readFile, readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { logger } from "Main/Logger";
import TTF from "./TTF";
import TTC from "./TTC";

interface CachedFont {
  mtimeMs: number;
  size: number;
  items: Fonts.IFontsFigmaItem[] | null; // null: file could not be parsed
}

// Same patterns the previous `find -name "*.?tf" / "*.ttc"` used.
const TTF_RE = /\.[^./]tf$/;
const TTC_RE = /\.ttc$/;

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
  private pending: Promise<Fonts.IFonts> | null = null;

  public getFonts = (dirs: Array<string>): Promise<Fonts.IFonts> => {
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

    return (
      (TTF_RE.test(full) || TTC_RE.test(full)) &&
      dirs.some((dir) => full.startsWith(resolve(dir) + "/"))
    );
  }

  private async scan(dirs: Array<string>): Promise<Fonts.IFonts> {
    const started = Date.now();
    const files = (await Promise.all(dirs.map((dir) => this.walk(dir)))).flat();
    const fontList: Fonts.IFonts = {};
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
        entry = { mtimeMs: info.mtimeMs, size: info.size, items: await this.parse(path) };
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

    logger.debug(`[fonts] ${files.length} files, ${parsed} parsed, ${Date.now() - started} ms`);

    return fontList;
  }

  private async parse(path: string): Promise<Fonts.IFontsFigmaItem[] | null> {
    try {
      const buffer = await readFile(path);

      return TTC_RE.test(path) ? new TTC(buffer).getData() : [new TTF(buffer).getData()];
    } catch (error) {
      logger.warn(`skip font: ${path}, error: `, error?.message);
      return null;
    }
  }

  private async walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const result: string[] = [];
    const nested: Promise<string[]>[] = [];

    for (const entry of entries) {
      const full = resolve(join(dir, entry.name));

      if (entry.isDirectory()) nested.push(this.walk(full));
      else if (entry.isFile() && (TTF_RE.test(entry.name) || TTC_RE.test(entry.name))) result.push(full);
    }

    return result.concat(...(await Promise.all(nested)));
  }
}
