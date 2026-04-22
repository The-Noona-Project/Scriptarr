import {proxyRequest} from "./proxy.mjs";

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
  const handleMoonV3Proxy = async (req, res) => {
    const targetPath = normalizeSplat(req.params.splat);
    const query = toQueryString(req.query);
    const response = await proxyRequest({
      baseUrl: config.sageBaseUrl,
      path: `/api/moon-v3/${targetPath}${query ? `?${query}` : ""}`,
      method: req.method,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      sessionToken: getSessionToken(req),
      headers: req.headers.accept ? {"Accept": req.headers.accept} : {}
    });

    const contentType = response.headers["content-type"] || "application/json; charset=utf-8";
    res.status(response.status);
    res.setHeader("Content-Type", contentType);
    res.send(response.body);
  };

  app.all("/api/moon/v3/*splat", handleMoonV3Proxy);
  app.all("/api/moon-v3/*splat", handleMoonV3Proxy);
};

export default registerMoonV3ProxyRoutes;
