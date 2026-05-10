import {serializeCookie} from "./cookies.mjs";
import {proxyJson} from "./proxy.mjs";
import {canAccessAdmin as canAccessMoonAdmin} from "@scriptarr/access";

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

const sanitizeReturnToPath = (value, fallback = "/") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    return fallback;
  }
  if (normalized.startsWith("/api/")) {
    return fallback;
  }
  return normalized || fallback;
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("\"", "&quot;");

const canAccessAdmin = (user) => canAccessMoonAdmin(user);

const resolvePublicOrigin = (config, req) => {
  try {
    if (config?.publicBaseUrl) {
      return new URL(config.publicBaseUrl).origin;
    }
  } catch {
    // Fall back to the request host below.
  }
  return `${req.protocol || "https"}://${req.get("host") || "localhost"}`;
};

const renderAuthRelayPage = ({targetPath, publicOrigin}) => {
  const safeTarget = JSON.stringify(sanitizeReturnToPath(targetPath, "/"));
  const safeOrigin = JSON.stringify(publicOrigin || "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Signing in…</title>
    <meta http-equiv="refresh" content="2;url=${escapeHtml(targetPath)}">
    <style>
      body { font-family: system-ui, sans-serif; background: #0f1418; color: #f3efe8; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      main { max-width: 420px; padding: 24px; border-radius: 18px; background: rgba(17, 24, 31, 0.92); border: 1px solid rgba(112, 132, 152, 0.2); }
      a { color: #f3efe8; }
    </style>
  </head>
  <body>
    <main>
      <h1>Moon finished signing you in.</h1>
      <p>Returning you to Scriptarr…</p>
      <p><a href="${escapeHtml(targetPath)}">Continue now</a></p>
    </main>
    <script>
      const targetPath = ${safeTarget};
      const publicOrigin = ${safeOrigin};
      const payload = {type: "scriptarr-auth-complete", returnTo: targetPath};

      try {
        if (window.opener && !window.opener.closed) {
          try {
            window.opener.postMessage(payload, publicOrigin || "*");
          } catch {}
          try {
            window.opener.location.replace(targetPath);
          } catch {}
          try {
            window.opener.focus();
          } catch {}
          window.close();
        }
      } catch {}

      window.location.replace(targetPath);
    </script>
  </body>
</html>`;
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

  app.get("/api/moon/chrome/bootstrap", async (req, res) => {
    const [branding, auth, bootstrap] = await Promise.all([
      proxyToSage(req, "/api/moon-v3/public/branding"),
      proxyToSage(req, "/api/auth/status"),
      proxyToSage(req, "/api/auth/bootstrap-status")
    ]);
    const authPayload = auth.status >= 200 && auth.status < 400 ? auth.payload : null;
    const user = authPayload?.user || (authPayload?.authenticated ? authPayload : null);
    res.json({
      branding: branding.status >= 200 && branding.status < 400 ? branding.payload : {siteName: "Scriptarr"},
      auth: authPayload,
      user,
      bootstrap: bootstrap.status >= 200 && bootstrap.status < 400 ? bootstrap.payload : null
    });
  });

  app.get("/api/moon/auth/discord/url", async (req, res) => {
    const query = toQueryString({
      returnTo: sanitizeReturnToPath(req.query?.returnTo, "/")
    });
    const result = await proxyToSage(req, `/api/auth/discord/url${query ? `?${query}` : ""}`);
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
    const fallbackPath = sanitizeReturnToPath(result.payload?.returnTo, "/");
    const targetPath = fallbackPath.startsWith("/admin") && !canAccessAdmin(result.payload?.user)
      ? "/"
      : fallbackPath;
    res
      .status(200)
      .type("html")
      .send(renderAuthRelayPage({
        targetPath,
        publicOrigin: resolvePublicOrigin(config, req)
      }));
  });

  app.get("/api/moon/auth/status", async (req, res) => {
    const result = await proxyToSage(req, "/api/auth/status");
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/auth/logout", async (req, res) => {
    await proxyToSage(req, "/api/auth/logout", {method: "POST"});
    res.setHeader("Set-Cookie", serializeCookie(config.sessionCookieName, "", {maxAge: 0}));
    res.json({ok: true});
  });
};

export default registerAuthRoutes;
