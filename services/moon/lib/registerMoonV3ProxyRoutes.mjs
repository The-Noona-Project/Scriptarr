import crypto from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import {proxyRequest, proxyStream} from "./proxy.mjs";

const COVER_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const COVER_CACHE_TIMEOUT_MS = 10_000;
const COVER_CACHE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const READER_PAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const READER_PAGE_CACHE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const READER_PAGE_CACHE_PRUNE_TARGET_BYTES = Math.round(READER_PAGE_CACHE_MAX_TOTAL_BYTES * 0.85);
const READER_PAGE_CACHE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

/**
 * Normalize an Express splat parameter into a slash-delimited path segment.
 *
 * @param {string | string[] | undefined} splat
 * @returns {string}
 */
const normalizeSplat = (splat) => Array.isArray(splat) ? splat.join("/") : String(splat || "");

/**
 * Serialize an Express query object into a URL query string.
 *
 * @param {import("express").Request["query"]} query
 * @returns {string}
 */
const toQueryString = (query) => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query || {})) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        params.append(key, String(entry));
      }
      continue;
    }

    if (value != null) {
      params.set(key, String(value));
    }
  }

  return params.toString();
};

const isReaderPageImagePath = (targetPath) =>
  /^user\/reader\/title\/[^/]+\/chapter\/[^/]+\/page\/\d+$/.test(String(targetPath || ""));

const isReaderPageStatusPath = (targetPath) =>
  /^user\/reader\/title\/[^/]+\/chapter\/[^/]+\/page\/\d+\/status$/.test(String(targetPath || ""));

const toReaderPageImagePath = (targetPath) => String(targetPath || "").replace(/\/status$/, "");

const safeCacheToken = (value, limit = 120) => String(value || "")
  .replace(/[^a-zA-Z0-9_-]/g, "_")
  .slice(0, limit);

const safeInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sanitizeReaderPageStatusPayload = (payload, {cacheFiles = null, cached = null} = {}) => ({
  ok: payload?.ok === true,
  status: Math.max(0, safeInteger(payload?.status, 0)),
  pageIndex: Math.max(0, safeInteger(payload?.pageIndex, 0)),
  revision: safeCacheToken(payload?.revision, 64),
  contentTypeFamily: safeCacheToken(payload?.contentTypeFamily, 40),
  byteLength: Math.max(0, safeInteger(cached?.stat?.size || payload?.byteLength, 0)),
  durationMs: Math.max(0, safeInteger(payload?.durationMs, 0)),
  cacheable: payload?.cacheable === true,
  failureCode: safeCacheToken(payload?.failureCode, 80),
  source: safeCacheToken(payload?.source, 40),
  cacheHit: Boolean(cached),
  cacheState: cacheFiles ? (cached ? "hit" : "miss") : "bypass"
});

const resolveReaderPageCacheFiles = (config, targetPath, query) => {
  const revision = String(query?.rev || "").trim();
  if (!revision) {
    return null;
  }
  const safeRevision = safeCacheToken(revision, 64);
  if (!safeRevision) {
    return null;
  }
  const key = crypto
    .createHash("sha256")
    .update(`${targetPath}?rev=${safeRevision}`)
    .digest("hex");
  const root = path.resolve(config.readerPageCacheDir || "data/moon-reader-page-cache");
  const directory = path.join(root, key.slice(0, 2));
  return {
    key,
    directory,
    dataFile: path.join(directory, `${key}.bin`),
    metaFile: path.join(directory, `${key}.json`),
    tempFile: path.join(directory, `${key}.${process.pid}.${Date.now()}.tmp`)
  };
};

const listReaderPageCacheFiles = async (root) => {
  const entries = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let children = [];
    try {
      children = await fs.readdir(directory, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        pending.push(childPath);
        continue;
      }
      if (!child.isFile() || !child.name.endsWith(".bin")) {
        continue;
      }
      try {
        const stat = await fs.stat(childPath);
        entries.push({path: childPath, metaPath: childPath.replace(/\.bin$/, ".json"), size: stat.size, mtimeMs: stat.mtimeMs});
      } catch {
        // Ignore files racing with another writer or pruner.
      }
    }
  }
  return entries;
};

const pruneReaderPageCache = async (root) => {
  const entries = await listReaderPageCacheFiles(root);
  let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes <= READER_PAGE_CACHE_MAX_TOTAL_BYTES) {
    return;
  }
  const oldestFirst = entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of oldestFirst) {
    if (totalBytes <= READER_PAGE_CACHE_PRUNE_TARGET_BYTES) {
      break;
    }
    totalBytes -= entry.size;
    await Promise.all([
      fs.rm(entry.path, {force: true}).catch(() => null),
      fs.rm(entry.metaPath, {force: true}).catch(() => null)
    ]);
  }
};

const readReaderPageCacheEntry = async (files) => {
  if (!files) {
    return null;
  }
  try {
    const [metadataRaw, stat] = await Promise.all([
      fs.readFile(files.metaFile, "utf8"),
      fs.stat(files.dataFile)
    ]);
    const metadata = JSON.parse(metadataRaw);
    if (!stat.isFile() || metadata?.status !== 200) {
      return null;
    }
    return {metadata, stat};
  } catch {
    return null;
  }
};

const sendReaderPageCacheHit = (res, files, entry) => {
  const metadata = entry.metadata || {};
  res.status(200);
  res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
  res.setHeader("Cache-Control", metadata.cacheControl || "private, max-age=604800");
  res.setHeader("Content-Length", String(entry.stat.size));
  res.setHeader("X-Scriptarr-Reader-Cache", "hit");
  if (metadata.etag) {
    res.setHeader("ETag", metadata.etag);
  }
  if (metadata.lastModified) {
    res.setHeader("Last-Modified", metadata.lastModified);
  }
  const stream = nodeFs.createReadStream(files.dataFile);
  stream.on("error", (error) => {
    res.destroy(error instanceof Error ? error : undefined);
  });
  stream.pipe(res);
};

const sendProxyStreamFailure = (res, error) => {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(502).json({error: "Upstream stream failed."});
};

const pipeProxyStream = (stream, res, {onError = null} = {}) => {
  stream.on("error", (error) => {
    onError?.(error);
    sendProxyStreamFailure(res, error);
  });
  stream.pipe(res);
};

const isCacheableReaderPageResponse = (response) => {
  if (!response || response.status !== 200) {
    return false;
  }
  const contentType = String(response.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!READER_PAGE_CACHE_CONTENT_TYPES.has(contentType)) {
    return false;
  }
  const contentLength = Number.parseInt(String(response.headers?.["content-length"] || "0"), 10);
  return !Number.isFinite(contentLength) || contentLength <= 0 || contentLength <= READER_PAGE_CACHE_MAX_BYTES;
};

const startReaderPageCacheWrite = async (files, response) => {
  if (!files || !isCacheableReaderPageResponse(response)) {
    return null;
  }
  await fs.mkdir(files.directory, {recursive: true});
  const writer = nodeFs.createWriteStream(files.tempFile);
  let byteLength = 0;
  let aborted = false;
  const abort = () => {
    if (aborted) {
      return;
    }
    aborted = true;
    writer.destroy();
    void fs.rm(files.tempFile, {force: true}).catch(() => null);
  };
  writer.on("error", abort);
  writer.on("finish", () => {
    if (aborted) {
      return;
    }
    const metadata = {
      status: 200,
      contentType: response.headers["content-type"] || "application/octet-stream",
      cacheControl: response.headers["cache-control"] || "private, max-age=604800",
      etag: response.headers.etag || "",
      lastModified: response.headers["last-modified"] || "",
      byteLength,
      cachedAt: new Date().toISOString()
    };
    const root = path.dirname(files.directory);
    void fs.rename(files.tempFile, files.dataFile)
      .then(() => fs.writeFile(files.metaFile, JSON.stringify(metadata)))
      .then(() => pruneReaderPageCache(root))
      .catch(() => fs.rm(files.tempFile, {force: true}).catch(() => null));
  });
  return {
    write(chunk) {
      if (aborted) {
        return;
      }
      byteLength += Buffer.byteLength(chunk);
      if (byteLength > READER_PAGE_CACHE_MAX_BYTES) {
        abort();
        return;
      }
      writer.write(chunk);
    },
    finish() {
      if (!aborted) {
        writer.end();
      }
    },
    abort
  };
};

const forwardResponseHeaders = (res, headers = {}, {stream = false} = {}) => {
  for (const [key, value] of Object.entries(headers || {})) {
    const normalized = String(key).toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || (stream && normalized === "content-length")) {
      continue;
    }
    res.setHeader(key, value);
  }
};

/**
 * Register the generic Moon v3 proxy route that forwards every admin and user
 * data request through Sage while preserving JSON and reader image responses.
 *
 * @param {import("express").Express} app
 * @param {{
 *   config: {sageBaseUrl: string},
 *   getSessionToken: (request: import("express").Request) => string
 * }} options
 * @returns {void}
 */
export const registerMoonV3ProxyRoutes = (app, {config, getSessionToken}) => {
  const forwardedHeaders = (req) => ({
    ...(req.headers.accept ? {"Accept": req.headers.accept} : {}),
    ...(req.get("X-Scriptarr-Api-Key") ? {"X-Scriptarr-Api-Key": req.get("X-Scriptarr-Api-Key")} : {})
  });

  const handleMoonV3Proxy = async (req, res) => {
    const targetPath = normalizeSplat(req.params.splat);
    const query = toQueryString(req.query);
    const isEventStream = targetPath === "admin/events/stream";
    if (isEventStream) {
      const response = await proxyStream({
        baseUrl: config.sageBaseUrl,
        path: `/api/moon-v3/${targetPath}${query ? `?${query}` : ""}`,
        method: req.method,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
        sessionToken: getSessionToken(req),
        headers: forwardedHeaders(req)
      });
      res.status(response.status);
      forwardResponseHeaders(res, response.headers, {stream: true});
      if (!response.body) {
        res.end();
        return;
      }
      pipeProxyStream(response.body, res);
      return;
    }
    if (req.method === "GET" && isReaderPageImagePath(targetPath)) {
      const cacheFiles = resolveReaderPageCacheFiles(config, targetPath, req.query);
      const cached = await readReaderPageCacheEntry(cacheFiles);
      if (cached) {
        sendReaderPageCacheHit(res, cacheFiles, cached);
        return;
      }
      const response = await proxyStream({
        baseUrl: config.sageBaseUrl,
        path: `/api/moon-v3/${targetPath}${query ? `?${query}` : ""}`,
        method: req.method,
        sessionToken: getSessionToken(req),
        headers: forwardedHeaders(req)
      });
      res.status(response.status);
      forwardResponseHeaders(res, response.headers, {stream: true});
      res.setHeader("X-Scriptarr-Reader-Cache", cacheFiles ? "miss" : "bypass");
      if (!response.body) {
        res.end();
        return;
      }
      let cacheWriter = null;
      try {
        cacheWriter = await startReaderPageCacheWrite(cacheFiles, response);
      } catch {
        cacheWriter = null;
      }
      if (cacheWriter) {
        response.body.on("data", (chunk) => cacheWriter.write(chunk));
        response.body.on("end", () => cacheWriter.finish());
      }
      pipeProxyStream(response.body, res, {
        onError: () => cacheWriter?.abort()
      });
      return;
    }
    if (req.method === "GET" && isReaderPageStatusPath(targetPath)) {
      const imageTargetPath = toReaderPageImagePath(targetPath);
      const cacheFiles = resolveReaderPageCacheFiles(config, imageTargetPath, req.query);
      const cached = await readReaderPageCacheEntry(cacheFiles);
      const response = await proxyRequest({
        baseUrl: config.sageBaseUrl,
        path: `/api/moon-v3/${targetPath}${query ? `?${query}` : ""}`,
        method: req.method,
        sessionToken: getSessionToken(req),
        headers: forwardedHeaders(req)
      });
      const responseBody = Buffer.isBuffer(response.body) ? response.body.toString("utf8") : String(response.body || "");
      const contentType = response.headers["content-type"] || "application/json; charset=utf-8";
      res.status(response.status);
      forwardResponseHeaders(res, response.headers);
      res.setHeader("X-Scriptarr-Reader-Cache", cacheFiles ? (cached ? "hit" : "miss") : "bypass");
      if (!/^application\/json\b/i.test(String(contentType)) || !responseBody.trim()) {
        if (!res.hasHeader("Content-Type")) {
          res.setHeader("Content-Type", contentType);
        }
        res.send(response.body);
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(responseBody);
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        res.setHeader("Content-Type", contentType);
        res.send(response.body);
        return;
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.json(sanitizeReaderPageStatusPayload(payload, {cacheFiles, cached}));
      return;
    }
    const response = await proxyRequest({
      baseUrl: config.sageBaseUrl,
      path: `/api/moon-v3/${targetPath}${query ? `?${query}` : ""}`,
      method: req.method,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      sessionToken: getSessionToken(req),
      headers: forwardedHeaders(req)
    });

    const contentType = response.headers["content-type"] || "application/json; charset=utf-8";
    res.status(response.status);
    forwardResponseHeaders(res, response.headers);
    if (!res.hasHeader("Content-Type")) {
      res.setHeader("Content-Type", contentType);
    }
    res.send(response.body);
  };

  const resolveCoverCacheFile = (titleId, revision) => {
    const safeTitleId = String(titleId || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
    const safeRevision = String(revision || "latest").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "latest";
    return path.resolve(config.coverCacheDir || "data/moon-cover-cache", `${safeTitleId}-${safeRevision}.webp`);
  };

  const readCoverSource = async (req, titleId) => {
    const response = await proxyRequest({
      baseUrl: config.sageBaseUrl,
      path: `/api/moon-v3/user/library/cover/${encodeURIComponent(titleId)}/source`,
      method: "GET",
      sessionToken: getSessionToken(req),
      headers: forwardedHeaders(req)
    });
    const text = Buffer.isBuffer(response.body) ? response.body.toString("utf8") : String(response.body || "");
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (response.status < 200 || response.status >= 300 || !payload?.coverUrl) {
      const error = new Error(payload?.error || "Cover source not found.");
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  const fetchCoverBuffer = async (coverUrl) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COVER_CACHE_TIMEOUT_MS);
    try {
      const response = await fetch(coverUrl, {
        signal: controller.signal,
        headers: {
          "Accept": "image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.2",
          "User-Agent": "Scriptarr cover cache"
        }
      });
      if (!response.ok) {
        throw new Error(`Cover fetch failed with status ${response.status}.`);
      }
      const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (contentType && !COVER_CACHE_CONTENT_TYPES.has(contentType)) {
        throw new Error("Cover source did not return a supported raster image.");
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > COVER_CACHE_MAX_BYTES) {
        throw new Error("Cover source image is too large.");
      }
      return buffer;
    } finally {
      clearTimeout(timeout);
    }
  };

  const ensureCoverCached = async ({titleId, coverUrl, coverRevision = "latest"}) => {
    const cacheFile = resolveCoverCacheFile(titleId, coverRevision);
    try {
      const cached = await fs.readFile(cacheFile);
      return {status: "cached", bytes: cached.length, cacheFile};
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    const input = await fetchCoverBuffer(coverUrl);
    const output = await sharp(input, {limitInputPixels: 24_000_000})
      .rotate()
      .resize({width: 512, height: 768, fit: "inside", withoutEnlargement: true})
      .webp({quality: 82})
      .toBuffer();
    await fs.mkdir(path.dirname(cacheFile), {recursive: true});
    await fs.writeFile(cacheFile, output);
    return {
      status: "converted",
      inputBytes: input.length,
      outputBytes: output.length,
      bytesSaved: Math.max(0, input.length - output.length),
      cacheFile
    };
  };

  const handleCoverCache = async (req, res) => {
    try {
      const titleId = normalizeSplat(req.params.titleId || req.params[0] || "").replace(/\.webp$/i, "");
      if (!titleId) {
        res.status(400).json({error: "Title id is required."});
        return;
      }
      const source = await readCoverSource(req, titleId);
      const revision = String(req.query.rev || source.coverRevision || "latest");
      const cacheFile = resolveCoverCacheFile(source.titleId || titleId, revision);
      try {
        const cached = await fs.readFile(cacheFile);
        res.status(200);
        res.setHeader("Content-Type", "image/webp");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.send(cached);
        return;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      const cached = await ensureCoverCached({
        titleId: source.titleId || titleId,
        coverUrl: source.coverUrl,
        coverRevision: revision
      });
      const output = await fs.readFile(cached.cacheFile);
      res.status(200);
      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(output);
    } catch (error) {
      res.status(error?.status || 502).json({
        error: error instanceof Error ? error.message : "Scriptarr could not load that cover."
      });
    }
  };

  const fetchSageJson = async (req, pathValue) => {
    const response = await proxyRequest({
      baseUrl: config.sageBaseUrl,
      path: pathValue,
      method: "GET",
      sessionToken: getSessionToken(req),
      headers: forwardedHeaders(req)
    });
    const text = Buffer.isBuffer(response.body) ? response.body.toString("utf8") : String(response.body || "");
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return {status: response.status, ok: response.status >= 200 && response.status < 300, payload};
  };

  const handleCoverCacheOptimize = async (req, res) => {
    const auth = await fetchSageJson(req, "/api/moon-v3/admin/system/tasks");
    if (!auth.ok) {
      res.status(auth.status).json(auth.payload || {error: "Scriptarr could not verify admin task access."});
      return;
    }

    const startedAt = Date.now();
    let cursor = "";
    let scanned = 0;
    let converted = 0;
    let skipped = 0;
    let failed = 0;
    let bytesSaved = 0;
    do {
      const params = new URLSearchParams({view: "card", pageSize: "100"});
      if (cursor) {
        params.set("cursor", cursor);
      }
      const page = await fetchSageJson(req, `/api/moon-v3/user/library?${params.toString()}`);
      if (!page.ok) {
        res.status(page.status).json(page.payload || {error: "Scriptarr could not load library cards."});
        return;
      }
      const titles = Array.isArray(page.payload?.titles) ? page.payload.titles : [];
      for (const title of titles) {
        scanned += 1;
        if (!title?.id || !title?.coverUrl) {
          skipped += 1;
          continue;
        }
        try {
          const result = await ensureCoverCached({
            titleId: title.id,
            coverUrl: title.coverUrl,
            coverRevision: title.coverRevision || "latest"
          });
          if (result.status === "converted") {
            converted += 1;
            bytesSaved += Number.parseInt(String(result.bytesSaved || 0), 10) || 0;
          } else {
            skipped += 1;
          }
        } catch {
          failed += 1;
        }
      }
      cursor = String(page.payload?.pageInfo?.nextCursor || "");
    } while (cursor);

    res.json({
      ok: true,
      scanned,
      converted,
      skipped,
      failed,
      bytesSaved,
      durationMs: Date.now() - startedAt
    });
  };

  const logoUploadBody = express.raw({
    limit: "4mb",
    type: ["image/png", "image/jpeg", "image/webp", "application/octet-stream"]
  });

  /**
   * Convert an uploaded raster logo into the WebP variants Sage stores in
   * Vault-backed branding settings.
   *
   * @param {Buffer} input
   * @returns {Promise<Record<string, unknown>>}
   */
  const buildLogoVariants = async (input) => {
    const base = sharp(input, {limitInputPixels: 24_000_000}).rotate();
    const [metadata, chrome, icon192, icon512] = await Promise.all([
      base.clone().metadata(),
      base.clone()
        .resize({width: 1024, height: 1024, fit: "inside", withoutEnlargement: true})
        .webp({quality: 88})
        .toBuffer({resolveWithObject: true}),
      base.clone()
        .resize({width: 192, height: 192, fit: "contain", background: {r: 0, g: 0, b: 0, alpha: 0}})
        .webp({quality: 88})
        .toBuffer({resolveWithObject: true}),
      base.clone()
        .resize({width: 512, height: 512, fit: "contain", background: {r: 0, g: 0, b: 0, alpha: 0}})
        .webp({quality: 88})
        .toBuffer({resolveWithObject: true})
    ]);
    const toVariant = (entry) => ({
      mimeType: "image/webp",
      width: entry.info.width,
      height: entry.info.height,
      byteLength: entry.data.length,
      dataBase64: entry.data.toString("base64")
    });
    return {
      originalWidth: metadata.width || 0,
      originalHeight: metadata.height || 0,
      variants: {
        chrome: toVariant(chrome),
        icon192: toVariant(icon192),
        icon512: toVariant(icon512)
      }
    };
  };

  app.put("/api/moon/v3/admin/settings/branding/logo", logoUploadBody, async (req, res) => {
    try {
      const input = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!input.length) {
        res.status(400).json({error: "Logo upload is empty."});
        return;
      }
      const converted = await buildLogoVariants(input);
      const revision = crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
      const response = await proxyRequest({
        baseUrl: config.sageBaseUrl,
        path: "/api/moon-v3/admin/settings/branding/logo",
        method: "PUT",
        body: {
          revision,
          originalMimeType: req.get("Content-Type") || "application/octet-stream",
          originalBytes: input.length,
          originalWidth: converted.originalWidth,
          originalHeight: converted.originalHeight,
          variants: converted.variants
        },
        sessionToken: getSessionToken(req),
        headers: forwardedHeaders(req)
      });
      res.status(response.status);
      res.setHeader("Content-Type", response.headers["content-type"] || "application/json; charset=utf-8");
      res.send(response.body);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Scriptarr could not process that logo."
      });
    }
  });

  app.get("/api/moon/v3/user/covers/:titleId.webp", handleCoverCache);
  app.get("/api/moon-v3/user/covers/:titleId.webp", handleCoverCache);
  app.post("/api/moon/v3/admin/system/tasks/cover-cache/optimize", handleCoverCacheOptimize);
  app.post("/api/moon-v3/admin/system/tasks/cover-cache/optimize", handleCoverCacheOptimize);

  app.all("/api/moon/v3/*splat", handleMoonV3Proxy);
  app.all("/api/moon-v3/*splat", handleMoonV3Proxy);
};

export default registerMoonV3ProxyRoutes;
