import crypto from "node:crypto";
import express from "express";
import sharp from "sharp";
import {proxyRequest, proxyStream} from "./proxy.mjs";

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
      for (const [key, value] of Object.entries(response.headers)) {
        if (["transfer-encoding", "content-length"].includes(String(key).toLowerCase())) {
          continue;
        }
        res.setHeader(key, value);
      }
      response.body?.pipe(res);
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
    res.setHeader("Content-Type", contentType);
    res.send(response.body);
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
        error: error instanceof Error ? error.message : "Moon could not process that logo."
      });
    }
  });

  app.all("/api/moon/v3/*splat", handleMoonV3Proxy);
  app.all("/api/moon-v3/*splat", handleMoonV3Proxy);
};

export default registerMoonV3ProxyRoutes;
