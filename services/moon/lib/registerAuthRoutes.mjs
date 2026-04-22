import {serializeCookie} from "./cookies.mjs";
import {proxyJson} from "./proxy.mjs";

/**
 * Serialize the current request query object back into a URL query string.
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
 * Register Moon authentication routes that proxy through Sage and manage the
 * browser session cookie locally.
 *
 * @param {import("express").Express} app
 * @param {{
 *   config: {sageBaseUrl: string, sessionCookieName: string},
 *   getSessionToken: (request: import("express").Request) => string,
 *   logger?: {warn: Function}
 * }} options
 * @returns {void}
 */
export const registerAuthRoutes = (app, {config, getSessionToken, logger}) => {
  const proxyToSage = (req, targetPath, options = {}) => proxyJson({
    baseUrl: config.sageBaseUrl,
    path: targetPath,
    sessionToken: getSessionToken(req),
    ...options
  });

  app.get("/api/moon/auth/bootstrap-status", async (req, res) => {
    const result = await proxyToSage(req, "/api/auth/bootstrap-status");
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/auth/discord/url", async (req, res) => {
    const result = await proxyToSage(req, "/api/auth/discord/url");
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/auth/discord/callback", async (req, res) => {
    const query = toQueryString(req.query);
    const result = await proxyToSage(req, `/api/auth/discord/callback${query ? `?${query}` : ""}`);

    if (result.status >= 400 || !result.payload?.token) {
      logger?.warn("Discord login failed in Moon callback route.", {
        status: result.status,
        error: result.payload?.error || "Unknown error"
      });
      res.status(result.status).send(`<pre>Discord login failed: ${result.payload?.error || "Unknown error"}</pre>`);
      return;
    }

    res.setHeader("Set-Cookie", serializeCookie(config.sessionCookieName, result.payload.token));
    res.redirect("/admin");
  });

  app.get("/api/moon/auth/status", async (req, res) => {
    const result = await proxyToSage(req, "/api/auth/status");
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/auth/logout", (_req, res) => {
    res.setHeader("Set-Cookie", serializeCookie(config.sessionCookieName, "", {maxAge: 0}));
    res.json({ok: true});
  });
};

export default registerAuthRoutes;
