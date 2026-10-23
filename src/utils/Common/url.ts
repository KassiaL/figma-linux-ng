import { PROTOCOL, HOMEPAGE } from "Const";

export const isPrototypeUrl = (url: string): boolean =>
  /figma\.com\/proto\/.+\/.+?node-id=.+/.test(url);

export const isCommunityUrl = (url: string): boolean => /figma\.com\/community\/.+/.test(url);
export const isFigmaUrl = (url: string): boolean =>
  /^(https?:\/\/w{0,3}?\.?figma\.com\/.*)/.test(url);

export const isFigmaProtocolUrl = (url: string): boolean => {
  const regex = new RegExp(`^${PROTOCOL}://.+`);

  return regex.test(url);
};

export const parseURL = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch (_a) {}
  return undefined;
};

export const normalizeUrl = (url: string): string => {
  if (!isFigmaProtocolUrl(url)) {
    return url;
  }

  const replaceRegExp = new RegExp(`^${PROTOCOL}:/`);

  return url.replace(replaceRegExp, HOMEPAGE);
};

export const getParsedUrl = (data: string): URL | undefined => parseURL(normalizeUrl(data));

// Path + query of an url, or "" when it can't be parsed.
export const urlPath = (url: string): string => {
  const parsed = parseURL(url);

  return parsed ? `${parsed.pathname}${parsed.search}` : "";
};
export const urlPathname = (url: string): string => parseURL(url)?.pathname ?? "";

export const isFigmaHost = (hostname: string): boolean =>
  hostname === "figma.com" || hostname.endsWith(".figma.com");

// Strict origin check (regexps above only look at the prefix of a string).
export const isFigmaOrigin = (url: string): boolean => {
  const parsed = parseURL(url);

  return !!parsed && parsed.protocol === "https:" && isFigmaHost(parsed.hostname);
};

export const isAppAuthGrandLink = (url: string) => /\/app_auth\/.*\/grant/.test(url);
export const isAppAuthRedeem = (url: string) => /\/app_auth\/redeem\?g_secret=.+/.test(url);

export const isAppAuthLink = (url: string) => /figma:\/\/app_auth\/redeem\?g_secret=.*/.test(url);

export const isRecentFilesLink = (url: string) =>
  /^(figma:\/\/|https?:\/\/w{0,3}?\.?figma\.com\/files\/recent)/.test(url);

export const isValidProjectLink = (url: string) =>
  /^(figma:\/\/|https?:\/\/w{0,3}?\.?figma\.com\/file\/)/.test(url);

export const isValidFigjamLink = (url: string) =>
  /^(figma:\/\/|https?:\/\/w{0,3}?\.?figma\.com\/jam)/.test(url);

export const isFigmaDocLink = (url: string) =>
  /^https:\/\/w{0,3}?.figma.com\/plugin-docs/.test(url);
export const isFigmaBoardLink = (url: string) =>
  /^https:\/\/w{0,3}?.figma.com\/board/.test(url);
export const isFigmaDesignLink = (url: string) =>
  /^https:\/\/w{0,3}?.figma.com\/design/.test(url);

// "/design/<key>" style identity of a Figma document url, ignoring the file name
// slug (Figma rewrites it) and query. null for non-document urls.
export const figmaDocId = (url: string): string | null => {
  const m = /^\/(file|design|proto|board|jam|slides|deck|site)\/([A-Za-z0-9]+)/.exec(
    url.startsWith("/") ? url : urlPathname(url),
  );

  return m ? `${m[1]}/${m[2]}` : null;
};

// Readable name from a Figma document url ("/design/<key>/My-File" -> "My File").
export const figmaDocTitle = (url: string): string | undefined => {
  const m = /^\/(?:file|design|proto|board|jam|slides|deck|site)\/[A-Za-z0-9]+\/([^/?#]+)/.exec(urlPathname(url));
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]).replace(/-/g, " ");
  } catch {
    return m[1];
  }
};
