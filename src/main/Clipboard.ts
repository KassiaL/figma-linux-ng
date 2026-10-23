/**
 * Desktop clipboard bridge for Figma's `setClipboardData` / `getClipboardData`.
 *
 * Electron 44 removed `clipboard` from renderers and replaced the main-process
 * helpers (readHTML, readBuffer, writeImage, ...) with the async W3C-style
 * `clipboard.read()` / `clipboard.write([ClipboardItem])` API. Payloads come from
 * web content, so MIME types are allowlisted here (see ClipboardItem docs).
 */
import { clipboard, ClipboardItem, nativeImage } from "electron";

import { logger } from "./Logger";

const RAW = (format: string) => `electron application/osclipboard;format="${format}"`;

// Formats Figma reads besides its own HTML: Adobe/Sketch payloads copied from native apps.
const RAW_READ_FORMATS = ["com.adobe.pdf", "com.adobe.xd", "com.bohemiancoding.sketch.v3"];

const toBlob = (bytes: Uint8Array, type: string) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type });

export async function writeClipboardData(data: WebApi.SetClipboardData): Promise<boolean> {
  const bytes = new Uint8Array(data.data as unknown as ArrayBufferLike);
  let item: Record<string, string | Blob>;

  switch (data.format) {
    case "image/png":
    case "image/jpeg": {
      const png = data.format === "image/png" ? bytes : nativeImage.createFromBuffer(Buffer.from(bytes)).toPNG();
      item = { "image/png": toBlob(png, "image/png") };
      break;
    }
    case "image/svg+xml": {
      // Plain text keeps "paste SVG code" into editors working, like the old client.
      const svg = new TextDecoder().decode(bytes);
      item = { "text/plain": svg, "image/svg+xml": toBlob(bytes, "image/svg+xml") };
      break;
    }
    case "application/pdf":
      item = { [RAW("application/pdf")]: toBlob(bytes, "application/pdf") };
      break;
    case "text/plain":
    case "text/html":
      item = { [data.format]: new TextDecoder().decode(bytes) };
      break;
    default:
      logger.warn("[clipboard] refused to write unsupported format:", data.format);
      return false;
  }

  await clipboard.write([new ClipboardItem(item)]);
  return true;
}

export interface ClipboardReadResult {
  format: string;
  data: ArrayBuffer;
}

async function readType(type: string): Promise<Uint8Array | null> {
  for (const item of await clipboard.read()) {
    if (item.types.includes(type)) {
      const blob = (await item.getType(type)) as Blob;
      return new Uint8Array(await blob.arrayBuffer());
    }
  }

  return null;
}

export async function readClipboardData(formats: string[]): Promise<ClipboardReadResult | null> {
  const types = new Set((await clipboard.read()).flatMap((i) => i.types));

  for (const format of formats ?? []) {
    let data: Uint8Array | null = null;

    if (format === "text/html" && types.has("text/html")) {
      const html = new TextDecoder().decode(await readType("text/html")).trim();
      // Only Figma's own clipboard payload is handed back through this bridge.
      if (html.includes("<!--(figma)") && html.includes("(/figma)-->")) {
        data = new TextEncoder().encode(html);
      }
    } else if (format === "image/svg+xml") {
      if (types.has("image/svg+xml")) data = await readType("image/svg+xml");
      if (!data?.byteLength && types.has("text/plain")) {
        const text = (await clipboard.readText()).trim();
        if (text.startsWith("<svg") && text.endsWith("</svg>")) data = new TextEncoder().encode(text);
      }
    } else if (format === "image/png" || format === "image/jpeg") {
      const imageType = [...types].find((t) => t.startsWith("image/") && t !== "image/svg+xml");
      if (imageType) {
        const raw = await readType(imageType);
        data = imageType === "image/png" ? raw : nativeImage.createFromBuffer(Buffer.from(raw)).toPNG();
      }
    } else if (RAW_READ_FORMATS.includes(format) && types.has(RAW(format))) {
      data = await readType(RAW(format));
    }

    if (data && data.byteLength > 0) {
      const copy = data.slice().buffer as ArrayBuffer;
      return { format, data: copy };
    }
  }

  return null;
}

export async function readClipboardText(): Promise<string> {
  return clipboard.readText();
}
