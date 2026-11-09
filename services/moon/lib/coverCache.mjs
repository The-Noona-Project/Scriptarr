/** @file Derived cover thumbnails, including authenticated reader-page fallback art. */
import {createHash, randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {readerResponseMatchesSelector} from "./readerImageIdentity.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const REMOTE_RETRY_MS = 60_000;
const RASTER_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

/**
 * Fail closed unless a current Sage probe authorizes the exact first reader page.
 * HTTP success alone is insufficient: unavailable pages may use an HTTP 200 diagnostic envelope.
 * @param {{status: number, headers: Record<string, string>, body: Buffer}} response Authenticated page-status response.
 * @returns {void}
 */
const requireReaderCoverAuthorization = (response, pagePath = "") => {
  let payload = null;
  try {payload = JSON.parse(response.body.toString("utf8"));} catch {}
  if (response.status === 200 && /^application\/json\b/i.test(response.headers["content-type"] || "")
    && payload?.ok === true && payload.status === 200 && payload.pageIndex === 0
    && payload.contentTypeFamily === "image" && Number.isInteger(payload.contentLength)
    && payload.contentLength > 0 && payload.contentLength <= MAX_BYTES && payload.cacheable === true
    && (!pagePath.includes("thumbnail=true") || payload.thumbnail === true && payload.segmentIndex === 0)) return;
  const error = new Error("Reader cover authorization unavailable.");
  error.status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status
    : Number.isInteger(payload?.status) && payload.status >= 400 && payload.status <= 599 ? payload.status : 503;
  throw error;
};

/**
 * Accept only Sage's same-title, revisioned first reader page; never an arbitrary upstream URL.
 * @param {string} titleId Authorized canonical catalog title id.
 * @param {string} value Sage-provided reader page path.
 * @returns {string} Validated path, or an empty string when no fallback exists.
 */
export const validateCoverFallbackPath = (titleId, value = "") => {
  if (!value) return "";
  const prefix = `/api/moon-v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/`;
  if (typeof value !== "string" || !value.startsWith(prefix)) throw new Error("Invalid cover fallback path.");
  const match = /^([^/?#]+)\/page\/0\?rev=((?:avif|webp)-[a-f0-9]{16})(?:(&thumbnail=true))?$/.exec(value.slice(prefix.length));
  let chapterId = "";
  try {chapterId = match ? decodeURIComponent(match[1]) : "";} catch {}
  if (!match || (match[2].startsWith("webp-") && !match[3]) || (match[2].startsWith("avif-") && match[3])
    || !chapterId || chapterId === "." || chapterId === ".." || /[\\/\u0000-\u001f\u007f]/.test(chapterId)
    || encodeURIComponent(chapterId) !== match[1]) throw new Error("Invalid cover fallback path.");
  return value;
};

/**
 * Convert a bounded real raster image into the existing cover thumbnail format.
 * @param {Buffer} input Image bytes, never an SVG or generated placeholder.
 * @param {string} contentType Upstream media type.
 * @returns {Promise<Buffer>} Derived WebP bytes.
 */
const convert = async (input, contentType) => {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!Buffer.isBuffer(input) || !input.length || input.length > MAX_BYTES || (type && !RASTER_TYPES.has(type))) {
    throw new Error("Cover source did not return a supported bounded raster image.");
  }
  return sharp(input, {limitInputPixels: 24_000_000}).rotate()
    .resize({width: 512, height: 768, fit: "inside", withoutEnlargement: true}).webp({quality: 82}).toBuffer();
};

/**
 * Build a per-runtime derived cache. Callers must authenticate the current cover source first.
 * Reader fallback cache hits reauthorize the exact page through a current-identity status probe.
 * @param {{cacheDir: string, fetchImpl?: typeof fetch, now?: () => number}} options Cache dependencies.
 * @returns {(source: {titleId: string, coverUrl?: string, coverRevision?: string, fallbackPagePath?: string,
 *   fetchFallback?: (path: string) => Promise<{status: number, headers: Record<string, string>, body: Buffer}>,
 *   authorizeFallback?: (path: string) => Promise<{status: number, headers: Record<string, string>, body: Buffer}>}) => Promise<object>}
 */
export const createCoverCache = ({cacheDir, fetchImpl = fetch, now = Date.now}) => {
  const remoteFailures = new Map();
  /** @param {string} file Derived cache path. @returns {Promise<Buffer|null>} Existing thumbnail. */
  const read = async (file) => {
    try {return await fs.readFile(file);} catch (error) {if (error?.code !== "ENOENT") throw error; return null;}
  };
  /** @param {string} file Derived cache path. @param {Buffer} buffer WebP bytes. @returns {Promise<void>} */
  const write = async (file, buffer) => {
    await fs.mkdir(path.dirname(file), {recursive: true});
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {await fs.writeFile(temporary, buffer); await fs.rename(temporary, file);}
    finally {await fs.rm(temporary, {force: true});}
  };
  /** @param {string} url External metadata cover URL. @returns {Promise<{buffer: Buffer, inputBytes: number}>} Converted thumbnail. */
  const fetchRemote = async (url) => {
    const response = await fetchImpl(url, {signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {Accept: "image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.2", "User-Agent": "Scriptarr cover cache"}});
    if (!response.ok) {await response.body?.cancel(); throw new Error("Cover fetch failed.");}
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body || []) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw new Error("Cover source image is too large.");
      chunks.push(Buffer.from(chunk));
    }
    const input = Buffer.concat(chunks);
    return {buffer: await convert(input, response.headers.get("content-type")), inputBytes: input.length};
  };
  return async ({titleId, coverUrl = "", coverRevision = "latest", fallbackPagePath = "", fetchFallback, authorizeFallback}) => {
    const fallback = validateCoverFallbackPath(titleId, fallbackPagePath);
    const key = createHash("sha256").update(JSON.stringify([titleId, coverUrl, coverRevision, fallback])).digest("hex");
    const remoteFile = path.resolve(cacheDir, `${key}-remote.webp`), fallbackFile = path.resolve(cacheDir, `${key}-reader.webp`);
    if (coverUrl) {
      const cached = await read(remoteFile);
      if (cached) return {status: "cached", sourceKind: "remote", bytes: cached.length, buffer: cached, cacheFile: remoteFile};
      if (!fallback || (remoteFailures.get(key) || 0) <= now()) {
        try {
          const {buffer, inputBytes} = await fetchRemote(coverUrl);
          await write(remoteFile, buffer); remoteFailures.delete(key);
          return {status: "converted", sourceKind: "remote", bytes: buffer.length, buffer, cacheFile: remoteFile,
            inputBytes, outputBytes: buffer.length, bytesSaved: Math.max(0, inputBytes - buffer.length)};
        } catch (error) {
          if (!fallback) throw error;
          remoteFailures.set(key, now() + REMOTE_RETRY_MS);
          if (remoteFailures.size > 256) remoteFailures.delete(remoteFailures.keys().next().value);
        }
      }
    }
    if (!fallback) throw new Error("No usable cover image is available.");
    const cached = await read(fallbackFile);
    if (cached) {
      // A cache hit still requires current authorization, without redownloading discarded AVIF bytes.
      try {
        if (!authorizeFallback) throw new Error("Missing reader cover authorization probe.");
        requireReaderCoverAuthorization(await authorizeFallback(fallback), fallback);
      } catch (error) {
        if (!Number.isInteger(error.status) || error.status < 400 || error.status > 599) error.status = 503;
        throw error;
      }
      return {status: "cached", sourceKind: "reader", bytes: cached.length, buffer: cached, cacheFile: fallbackFile};
    }
    if (!fetchFallback) throw new Error("No usable cover image is available.");
    const response = await fetchFallback(fallback);
    if (response.status < 200 || response.status >= 300) {
      const error = new Error("Reader cover fallback unavailable.");
      error.status = response.status;
      throw error;
    }
    if (fallback.includes("thumbnail=true") && !readerResponseMatchesSelector(response.headers, {segmentIndex: 0, thumbnail: true})) {
      throw new Error("Reader cover thumbnail identity differs.");
    }
    if (!RASTER_TYPES.has(String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase())
      || !Buffer.isBuffer(response.body) || !response.body.length || response.body.length > MAX_BYTES) {
      throw new Error("Cover source did not return a supported bounded raster image.");
    }
    const buffer = await convert(response.body, response.headers["content-type"]);
    await write(fallbackFile, buffer);
    return {status: "converted", sourceKind: "reader", bytes: buffer.length, buffer, cacheFile: fallbackFile,
      inputBytes: response.body.length, outputBytes: buffer.length, bytesSaved: Math.max(0, response.body.length - buffer.length)};
  };
};
