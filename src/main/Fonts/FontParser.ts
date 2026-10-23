/**
 * Minimal sfnt (TrueType / OpenType / collections) reader producing the font
 * entries Figma's local font API expects, in the same shape as the Figma Font
 * Agent returns them:
 *
 *   { family, style, postscript, weight, stretch, italic, modified_at, user_installed,
 *     variationAxes? }
 *
 * - family/style use the typographic names (name IDs 16/17) when present, so
 *   "Inter-Black.otf" is family "Inter", style "Black" (not family "Inter Black").
 * - stretch is the OS/2 width class (1..9), weight the OS/2 weight class.
 * - variable fonts expand to their named instances (fvar), plus the default
 *   instance when no named instance has the default coordinates.
 */

export interface VariationAxis {
  tag: string;
  name: string;
  value: number;
  min: number;
  max: number;
  default: number;
  hidden: boolean;
}

export interface FigmaFontEntry {
  family: string;
  style: string;
  postscript: string;
  weight: number;
  stretch: number;
  italic: boolean;
  variationAxes?: VariationAxis[];
  modified_at?: number;
  user_installed?: boolean;
}

interface Table {
  offset: number;
  length: number;
}

const tag4 = (b: Buffer, o: number) => b.toString("latin1", o, o + 4);
const fixed = (b: Buffer, o: number) => b.readInt32BE(o) / 65536;

function readTables(b: Buffer, start: number): Map<string, Table> {
  const numTables = b.readUInt16BE(start + 4);
  const tables = new Map<string, Table>();

  for (let i = 0; i < numTables; i++) {
    const rec = start + 12 + i * 16;
    tables.set(tag4(b, rec), { offset: b.readUInt32BE(rec + 8), length: b.readUInt32BE(rec + 12) });
  }

  return tables;
}

function decodeName(b: Buffer, platformId: number, encodingId: number, offset: number, length: number): string {
  const raw = b.subarray(offset, offset + length);

  if (platformId === 3 || platformId === 0 || (platformId === 2 && encodingId === 1)) {
    // UTF-16BE
    let s = "";
    for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode(raw.readUInt16BE(i));
    return s;
  }

  return raw.toString("latin1");
}

/** name ID -> string, preferring Windows English (US), then any Windows English, Unicode, Mac Roman English. */
function readNames(b: Buffer, table: Table | undefined): Map<number, string> {
  const names = new Map<number, string>();
  if (!table) return names;

  const o = table.offset;
  const count = b.readUInt16BE(o + 2);
  const storage = o + b.readUInt16BE(o + 4);
  const rank = new Map<number, number>();

  for (let i = 0; i < count; i++) {
    const r = o + 6 + i * 12;
    const platformId = b.readUInt16BE(r);
    const encodingId = b.readUInt16BE(r + 2);
    const languageId = b.readUInt16BE(r + 4);
    const nameId = b.readUInt16BE(r + 6);
    const length = b.readUInt16BE(r + 8);
    const offset = b.readUInt16BE(r + 10);

    let score = 0;
    if (platformId === 3 && (encodingId === 1 || encodingId === 10)) score = languageId === 0x409 ? 4 : (languageId & 0xff) === 0x09 ? 3 : 1;
    else if (platformId === 0) score = 2;
    else if (platformId === 1 && encodingId === 0 && languageId === 0) score = 2;
    if (!score || (rank.get(nameId) ?? 0) >= score) continue;

    // Kept verbatim (including trailing spaces): Figma compares style names exactly,
    // and the Font Agent reports them as stored in the font.
    const value = decodeName(b, platformId, encodingId, storage + offset, length).replace(/\0/g, "");
    if (value.trim()) {
      names.set(nameId, value);
      rank.set(nameId, score);
    }
  }

  return names;
}

const WIDTH_PERCENT = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];
const widthClassFromPercent = (percent: number) => {
  let best = 0;
  for (let i = 1; i < WIDTH_PERCENT.length; i++) {
    if (Math.abs(WIDTH_PERCENT[i] - percent) < Math.abs(WIDTH_PERCENT[best] - percent)) best = i;
  }
  return best + 1;
};

const isItalicStyle = (style: string) => /italic|oblique|kursiv/i.test(style);

function parseFace(b: Buffer, start: number): FigmaFontEntry[] {
  const tables = readTables(b, start);
  const names = readNames(b, tables.get("name"));

  const family = names.get(16) || names.get(1);
  const style = names.get(17) || names.get(2) || "Regular";
  if (!family) throw new Error("font has no family name");

  let weight = 400;
  let stretch = 5;
  let italic = isItalicStyle(style);
  const os2 = tables.get("OS/2");
  if (os2 && os2.length >= 64) {
    weight = b.readUInt16BE(os2.offset + 4) || 400;
    stretch = Math.min(9, Math.max(1, b.readUInt16BE(os2.offset + 6) || 5));
    const fsSelection = b.readUInt16BE(os2.offset + 62);
    italic = italic || !!(fsSelection & 0x1) || !!(fsSelection & 0x200);
  }
  const post = tables.get("post");
  if (post && post.length >= 8 && fixed(b, post.offset + 4) !== 0) {
    italic = true; // slanted designs (e.g. "Noto Serif Tamil Slanted")
  }

  const postscript = names.get(6) || `${family}-${style}`.replace(/\s+/g, "");
  const base: FigmaFontEntry = { family, style, postscript, weight, stretch, italic };

  const fvar = tables.get("fvar");
  if (!fvar) {
    return [base];
  }

  // Variable font: axes + named instances.
  const o = fvar.offset;
  const axesOffset = o + b.readUInt16BE(o + 4);
  const axisCount = b.readUInt16BE(o + 8);
  const axisSize = b.readUInt16BE(o + 10);
  const instanceCount = b.readUInt16BE(o + 12);
  const instanceSize = b.readUInt16BE(o + 14);

  const axes: Omit<VariationAxis, "value">[] = [];
  for (let i = 0; i < axisCount; i++) {
    const a = axesOffset + i * axisSize;
    axes.push({
      tag: tag4(b, a),
      min: fixed(b, a + 4),
      default: fixed(b, a + 8),
      max: fixed(b, a + 12),
      hidden: !!(b.readUInt16BE(a + 16) & 0x1),
      name: names.get(b.readUInt16BE(a + 18)) ?? tag4(b, a),
    });
  }

  // Same instance PostScript names the Font Agent produces (family without spaces).
  const psPrefix = family.replace(/[^A-Za-z0-9]/g, "");
  const entryFor = (instStyle: string, coords: number[], psName?: string): FigmaFontEntry => {
    const variationAxes = axes.map((axis, i) => ({ ...axis, value: coords[i] }));
    const wght = variationAxes.find((a) => a.tag === "wght");
    const wdth = variationAxes.find((a) => a.tag === "wdth");
    const ital = variationAxes.find((a) => a.tag === "ital");
    const slnt = variationAxes.find((a) => a.tag === "slnt");

    return {
      family,
      style: instStyle,
      postscript: psName || `${psPrefix}-${instStyle.replace(/\s+/g, "")}`,
      weight: wght ? Math.round(wght.value * 100000) / 100000 : weight,
      stretch: wdth ? widthClassFromPercent(wdth.value) : stretch,
      italic: isItalicStyle(instStyle) || (ital ? ital.value >= 1 : false) || (slnt ? slnt.value !== 0 : false) || italic,
      variationAxes,
    };
  };

  const entries: FigmaFontEntry[] = [];
  const instancesOffset = axesOffset + axisCount * axisSize;
  const defaults = axes.map((a) => a.default);
  let hasDefault = false;

  for (let i = 0; i < instanceCount; i++) {
    const r = instancesOffset + i * instanceSize;
    const subfamilyNameId = b.readUInt16BE(r);
    const coords = axes.map((_, k) => fixed(b, r + 4 + k * 4));
    const psNameId = instanceSize >= 4 + axisCount * 4 + 2 ? b.readUInt16BE(r + 4 + axisCount * 4) : 0xffff;
    const instStyle = names.get(subfamilyNameId);
    if (!instStyle) continue;

    hasDefault ||= coords.every((c, k) => c === defaults[k]);
    // Instance PostScript names stored in the font (psNameId) are ignored on purpose:
    // the Font Agent always derives "<Family>-<Style>", and file references must match it.
    void psNameId;
    entries.push(entryFor(instStyle, coords));
  }

  if (!hasDefault || !entries.length) {
    entries.push(entryFor(style, defaults, postscript));
  }

  return entries;
}

/** All faces in a font file buffer (a collection yields several). */
export function parseFontFile(b: Buffer): FigmaFontEntry[] {
  const tag = tag4(b, 0);

  if (tag === "ttcf") {
    const count = b.readUInt32BE(8);
    const result: FigmaFontEntry[] = [];
    for (let i = 0; i < count; i++) {
      try {
        result.push(...parseFace(b, b.readUInt32BE(12 + i * 4)));
      } catch {
        /* skip broken face */
      }
    }
    return result;
  }

  if (tag === "OTTO" || tag === "true" || b.readUInt32BE(0) === 0x00010000) {
    return parseFace(b, 0);
  }

  throw new Error(`not an sfnt font (${JSON.stringify(tag)})`);
}
