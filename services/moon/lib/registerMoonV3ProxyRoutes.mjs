import crypto from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import {proxyRequest, proxyStream} from "./proxy.mjs";
import {createCoverCache} from "./coverCache.mjs";
import {readerImageSelector, readerProbeMatchesSelector, readerResponseMatchesSelector} from "./readerImageIdentity.mjs";

const DEFAULT_JSON_PROXY_TIMEOUT_MS = 15_000;
const READER_PAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const READER_PAGE_CACHE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const READER_PAGE_CACHE_PRUNE_TARGET_BYTES = Math.round(READER_PAGE_CACHE_MAX_TOTAL_BYTES * 0.85);
const READER_PAGE_CACHE_CONTENT_TYPES = new Set(["image/avif", "image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"]);
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

const resolveJsonProxyTimeoutMs = () => {
  const parsed = Number.parseInt(process.env.SCRIPTARR_MOON_V3_JSON_PROXY_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_JSON_PROXY_TIMEOUT_MS;
};

const sanitizeReaderPageStatusPayload = (payload, {cacheFiles = null, cached = null} = {}) => ({
  ok: payload?.ok === true,
  status: Math.max(0, safeInteger(payload?.status, 0)),
  pageIndex: Math.max(0, safeInteger(payload?.pageIndex, 0)),
  segmentIndex: Math.max(0, safeInteger(payload?.segmentIndex, 0)),
  thumbnail: payload?.thumbnail === true,
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
  const selector = readerImageSelector(query);
  if (!selector) return null;
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
    .update(`${targetPath}?rev=${safeRevision}&${selector.key}`)
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
  let completed = false;
  const cleanup = () => {
    res.off("close", handleClose);
  };
  const handleClose = () => {
    if (!completed) {
      stream.destroy();
    }
    cleanup();
  };
  res.once("close", handleClose);
  res.once("finish", () => {
    completed = true;
    cleanup();
  });
  stream.on("error", (error) => {
    completed = true;
    cleanup();
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

/**
 * Start an upstream JSON request and abort it if the downstream browser
 * disconnects before Moon has received the upstream response.
 *
 * @param {import("express").Response} res
 * @param {Parameters<typeof proxyRequest>[0]} options
 * @param {{timeoutMs?: number}} [settings]
 * @returns {Promise<Awaited<ReturnType<typeof proxyRequest>> | null>}
 */
const proxyRequestWithResponseAbort = async (res, options, {timeoutMs = 0} = {}) => {
  const controller = new AbortController();
  let clientClosed = false;
  let timedOut = false;
  let timeout = null;
  const abortPendingRequest = () => {
    clientClosed = true;
    controller.abort();
  };
  res.once("close", abortPendingRequest);
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  try {
    return await proxyRequest({
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (clientClosed) {
      return null;
    }
    if (timedOut) {
      throw new Error("The operation was aborted due to timeout");
    }
    throw error;
  } finally {
    res.off("close", abortPendingRequest);
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

/**
 * Start an upstream stream request and abort it if the downstream client
 * disconnects before the upstream response arrives.
 *
 * @param {import("express").Response} res
 * @param {Parameters<typeof proxyStream>[0]} options
 * @returns {Promise<{response: Awaited<ReturnType<typeof proxyStream>>, controller: AbortController} | null>}
 */
const proxyStreamWithResponseAbort = async (res, options) => {
  const controller = new AbortController();
  let closed = false;
  const abortPendingRequest = () => {
    closed = true;
    controller.abort();
  };
  res.once("close", abortPendingRequest);
  try {
    const response = await proxyStream({
      ...options,
      signal: controller.signal
    });
    res.off("close", abortPendingRequest);
    if (closed || controller.signal.aborted) {
      response.body?.destroy();
      return null;
    }
    return {response, controller};
  } catch (error) {
    res.off("close", abortPendingRequest);
    if (closed || controller.signal.aborted) {
      return null;
    }
    throw error;
  }
};

/**
 * Pipe an upstream readable to Express while binding upstream/cache lifetimes
 * to downstream close, finish, and stream error events.
 *
 * @param {import("node:stream").Readable} stream
 * @param {import("express").Response} res
 * @param {{controller?: AbortController | null, onAbort?: (() => void) | null, onError?: ((error: Error) => void) | null}} [options]
 * @returns {void}
 */
const pipeProxyStream = (stream, res, {controller = null, onAbort = null, onError = null} = {}) => {
  let completed = false;
  const cleanup = () => {
    res.off("close", handleClose);
    res.off("finish", handleFinish);
  };
  const handleFinish = () => {
    completed = true;
    cleanup();
  };
  const handleClose = () => {
    if (!completed) {
      controller?.abort();
      stream.destroy();
      onAbort?.();
    }
    cleanup();
  };
  res.once("close", handleClose);
  res.once("finish", handleFinish);
  stream.on("error", (error) => {
    completed = true;
    cleanup();
    controller?.abort();
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
export const registerMoonV3ProxyRoutes = (app, {config, getSessionToken, logger}) => {
  const jsonProxyTimeoutMs = resolveJsonProxyTimeoutMs();
  const forwardedHeaders = (req) => ({
    ...(req.headers.accept ? {"Accept": req.headers.accept} : {}),
    ...(req.get("X-Scriptarr-Api-Key") ? {"X-Scriptarr-Api-Key": req.get("X-Scriptarr-Api-Key")} : {})
  });

  /**
   * Recheck the exact reader page through Sage before serving shared cached
   * bytes. A warm cache must not bypass revoked sessions or page-level denial.
   *
   * @param {import("express").Request} req browser request
   * @param {import("express").Response} res browser response
   * @param {string} targetPath normalized reader image route
   * @param {string} query serialized browser query
   * @returns {Promise<boolean>} whether cached bytes may be served
   */
  const authorizeReaderCacheHit = async (req, res, targetPath, query) => {
    res.setHeader("Cache-Control", "no-store");
    if (!getSessionToken(req) && !req.get("X-Scriptarr-Api-Key")) {
      res.status(401).json({error: "A signed-in reader session is required."});
      return false;
    }
    try {
      const checked = await proxyRequestWithResponseAbort(res, {
        baseUrl: config.sageBaseUrl,
        path: `/api/moon-v3/${targetPath}/status${query ? `?${query}` : ""}`,
        method: "GET",
        sessionToken: getSessionToken(req),
        headers: forwardedHeaders(req)
      }, {timeoutMs: Math.min(jsonProxyTimeoutMs, 5000)});
      if (!checked) {
        return false;
      }
      let payload = null;
      try {
        payload = JSON.parse(checked.body.toString("utf8"));
      } catch {
        payload = null;
      }
      const selector = readerImageSelector(Object.fromEntries(new URLSearchParams(query)));
      if (checked.status === 200 && payload?.ok === true && payload?.status === 200 && readerProbeMatchesSelector(payload, selector)) {
        return true;
      }
      const deniedStatus = checked.status >= 400 && checked.status < 500
        ? checked.status
        : Number.isInteger(payload?.status) && payload.status >= 400 && payload.status < 500
          ? payload.status : 503;
      res.status(deniedStatus).json({error: deniedStatus === 503
        ? "Reader authorization is temporarily unavailable."
        : "This reader page is not available for the current session."});
      return false;
    } catch {
      if (!res.headersSent && !res.destroyed) {
        res.status(503).json({error: "Reader authorization is temporarily unavailable."});
      }
      return false;
    }
  };

  const handleMoonV3Proxy = async (req, res) => {
    const targetPath = normalizeSplat(req.params.splat);
    const query = toQueryString(req.query);
    if ((isReaderPageImagePath(targetPath) || isReaderPageStatusPath(targetPath)) && !readerImageSelector(req.query)) {
      res.status(400).json({error: "Invalid reader image selector."});
      return;
    }
    try {
    const isEventStream = targetPath === "admin/events/stream";
    if (isEventStream) {
      const proxied = await proxyStreamWithResponseAbort(res, {
        baseUrl: config.sageBaseUrl,
        path: `/api/moon-v3/${targetPath}${query ? `?${query}` : ""}`,
        method: req.method,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
        sessionToken: getSessionToken(req),
        headers: forwardedHeaders(req)
      });
      if (!proxied) {
        return;
      }
      const {response, controller} = proxied;
      res.status(response.status);
      forwardResponseHeaders(res, response.headers, {stream: true});
      if (!response.body) {
        res.end();
        return;
      }
      pipeProxyStream(response.body, res, {controller});
      return;
    }
    if (req.method === "GET" && isReaderPageImagePath(targetPath)) {
      const cacheFiles = resolveReaderPageCacheFiles(config, targetPath, req.query);
      const cached = await readReaderPageCacheEntry(cacheFiles);
      if (cached) {
        if (!await authorizeReaderCacheHit(req, res, targetPath, query)) {
          return;
        }
        sendReaderPageCacheHit(res, cacheFiles, cached);
        return;
      }
      const proxied = await proxyStreamWithResponseAbort(res, {
        baseUrl: config.sageBaseUrl,
        path: `/api/moon-v3/${targetPath}${query ? `?${query}` : ""}`,
        method: req.method,
        sessionToken: getSessionToken(req),
        headers: forwardedHeaders(req)
      });
      if (!proxied) {
        return;
      }
      const {response, controller} = proxied;
      if (response.status === 200 && !readerResponseMatchesSelector(response.headers, readerImageSelector(req.query))) {
        controller?.abort();
        response.body?.destroy();
        res.status(502).setHeader("Cache-Control", "no-store");
        res.json({error: "The reader returned a different image variant."});
        return;
      }
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
        controller,
        onAbort: () => cacheWriter?.abort(),
        onError: () => cacheWriter?.abort()
      });
      return;
    }
    if (req.method === "GET" && isReaderPageStatusPath(targetPath)) {
      const imageTargetPath = toReaderPageImagePath(targetPath);
      const cacheFiles = resolveReaderPageCacheFiles(config, imageTargetPath, req.query);
      const cached = await readReaderPageCacheEntry(cacheFiles);
      const response = await proxyRequestWithResponseAbort(res, {
        baseUrl: config.sageBaseUrl,
        path: `/api/moon-v3/${targetPath}${query ? `?${query}` : ""}`,
        method: req.method,
        sessionToken: getSessionToken(req),
        headers: forwardedHeaders(req)
      }, {timeoutMs: jsonProxyTimeoutMs});
      if (!response) {
        return;
      }
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
    const response = await proxyRequestWithResponseAbort(res, {
      baseUrl: config.sageBaseUrl,
      path: `/api/moon-v3/${targetPath}${query ? `?${query}` : ""}`,
      method: req.method,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      sessionToken: getSessionToken(req),
      headers: forwardedHeaders(req)
    }, {timeoutMs: jsonProxyTimeoutMs});
    if (!response) {
      return;
    }

    const contentType = response.headers["content-type"] || "application/json; charset=utf-8";
    res.status(response.status);
    forwardResponseHeaders(res, response.headers);
    if (!res.hasHeader("Content-Type")) {
      res.setHeader("Content-Type", contentType);
    }
    res.send(response.body);
    } catch (error) {
      logger?.warn?.("Moon could not reach Sage for a Moon v3 proxy request.", {
        targetPath,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) {
        res.status(502).json({
          error: "Sage broker unavailable.",
          detail: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const ensureCoverCached = createCoverCache({cacheDir: config.coverCacheDir || "data/moon-cover-cache"});

  /**
   * Load the current authorized source before serving any derived thumbnail.
   * @param {import("express").Request} req Current browser session or API-key request.
   * @param {string} titleId Requested catalog title.
   * @returns {Promise<object>} Authorized cover metadata and optional reader fallback.
   */
  const readCoverSource = async (req, titleId) => {
    const response = await proxyRequest({
      baseUrl: config.sageBaseUrl,
      path: `/api/moon-v3/user/library/cover/${encodeURIComponent(titleId)}/source`,
      method: "GET",
      sessionToken: getSessionToken(req),
      headers: forwardedHeaders(req),
      signal: AbortSignal.timeout(15_000)
    });
    let payload = null;
    try {payload = JSON.parse(Buffer.isBuffer(response.body) ? response.body.toString("utf8") : String(response.body || ""));} catch {}
    if (response.status < 200 || response.status >= 300 || !payload?.titleId || (!payload.coverUrl && !payload.fallbackPagePath)) {
      const error = new Error("Cover source unavailable.");
      error.status = response.status >= 400 ? response.status : 502;
      throw error;
    }
    return payload;
  };

  /**
   * Use the same authorized artwork selection for individual covers and the admin optimizer.
   * @param {import("express").Request} req Current caller credentials.
   * @param {string} titleId Requested catalog title.
   * @returns {Promise<object>} Cached or newly converted thumbnail.
   */
  const loadCoverForRequest = async (req, titleId) => {
    const source = await readCoverSource(req, titleId);
    /**
     * Read the fixed reader path with this caller, sharing credentials for body and probe requests.
     * @param {string} pagePath Validated same-title reader path.
     * @param {number} timeoutMs Bounded body or status-probe deadline.
     * @returns {Promise<{status: number, headers: Record<string, string>, body: Buffer}>}
     */
    const readFallback = (pagePath, timeoutMs) => proxyRequest({
      baseUrl: config.sageBaseUrl, path: pagePath, method: "GET",
      sessionToken: getSessionToken(req), headers: forwardedHeaders(req), signal: AbortSignal.timeout(timeoutMs)
    });
    return ensureCoverCached({
      titleId: source.titleId,
      coverUrl: source.coverUrl || "",
      coverRevision: source.coverRevision || "latest",
      fallbackPagePath: source.fallbackPagePath || "",
      fetchFallback: (pagePath) => readFallback(pagePath, 15_000),
      authorizeFallback: (pagePath) => readFallback(pagePath.replace(/\/page\/0(?=\?)/, "/page/0/status"), 5000)
    });
  };

  /**
   * Serve a remote cover or the authorized title's first reader page as derived WebP.
   * @param {import("express").Request} req Current authenticated cover request.
   * @param {import("express").Response} res Derived private image response.
   * @returns {Promise<void>}
   */
  const handleCoverCache = async (req, res) => {
    res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
    res.vary("Cookie"); res.vary("Authorization"); res.vary("X-Scriptarr-Api-Key");
    try {
      const titleId = normalizeSplat(req.params.titleId || req.params[0] || "").replace(/\.webp$/i, "");
      if (!titleId) {res.status(400).json({error: "Title id is required."}); return;}
      const cached = await loadCoverForRequest(req, titleId);
      res.status(200).type("image/webp").send(cached.buffer);
    } catch (error) {
      res.status(error?.status || 502).json({error: "Scriptarr could not load that cover."});
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
        if (!title?.id) {
          skipped += 1;
          continue;
        }
        try {
          const result = await loadCoverForRequest(req, title.id);
          if (result.status === "converted") {
            converted += 1;
            bytesSaved += Number.parseInt(String(result.bytesSaved || 0), 10) || 0;
          } else {
            skipped += 1;
          }
        } catch (error) {
          if (error?.status === 404) skipped += 1;
          else failed += 1;
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
