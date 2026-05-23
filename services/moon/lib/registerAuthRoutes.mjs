import {parseCookies, serializeCookie} from "./cookies.mjs";
import {proxyJson} from "./proxy.mjs";
import {canAccessAdmin as canAccessMoonAdmin} from "@scriptarr/access";

const DEFAULT_CHROME_BOOTSTRAP_PROXY_TIMEOUT_MS = 1500;

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

const parseOauthState = (value) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return {nonce: "", returnTo: "/"};
  }
  try {
    const parsed = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8"));
    return {
      nonce: typeof parsed?.nonce === "string" ? parsed.nonce.trim() : "",
      returnTo: sanitizeReturnToPath(parsed?.returnTo, "/")
    };
  } catch {
    return {nonce: "", returnTo: "/"};
  }
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("\"", "&quot;");

const canAccessAdmin = (user) => canAccessMoonAdmin(user);

/**
 * Resolve the per-broker timeout for Moon's collapsed chrome bootstrap route.
 *
 * @returns {number}
 */
const resolveChromeBootstrapProxyTimeoutMs = () => {
  const parsed = Number.parseInt(process.env.SCRIPTARR_MOON_CHROME_BOOTSTRAP_PROXY_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CHROME_BOOTSTRAP_PROXY_TIMEOUT_MS;
};

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

const shouldUseSecureCookie = (config, req) => {
  const forwardedProto = String(req.get?.("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  if (req.secure || forwardedProto === "https") {
    return true;
  }
  try {
    return new URL(config?.publicBaseUrl || "").protocol === "https:";
  } catch {
    return false;
  }
};

const renderAuthRelayPage = ({targetPath, publicOrigin}) => {
  const safeTarget = JSON.stringify(sanitizeReturnToPath(targetPath, "/"));
  const safeTargetPath = sanitizeReturnToPath(targetPath, "/");
  const safeOrigin = JSON.stringify(publicOrigin || "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Signing in...</title>
    <meta http-equiv="refresh" content="2;url=${escapeHtml(safeTargetPath)}">
    <style>
      body { font-family: system-ui, sans-serif; background: #0f1418; color: #f3efe8; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      main { max-width: 420px; padding: 24px; border-radius: 18px; background: rgba(17, 24, 31, 0.92); border: 1px solid rgba(112, 132, 152, 0.2); }
      a { color: #f3efe8; }
    </style>
  </head>
  <body>
    <main>
      <h1>Scriptarr finished signing you in.</h1>
      <p>Returning you to Scriptarr...</p>
      <p><a href="${escapeHtml(safeTargetPath)}">Continue now</a></p>
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
  const oauthStateCookieName = `${config.sessionCookieName || "scriptarr_session"}.oauth_state`;
  const chromeBootstrapProxyTimeoutMs = resolveChromeBootstrapProxyTimeoutMs();
  const proxyToSage = (req, targetPath, options = {}) => proxyJson({
    baseUrl: config.sageBaseUrl,
    path: targetPath,
    sessionToken: getSessionToken(req),
    ...options
  });

  const safeProxyToSage = async (req, targetPath, fallbackError, options = {}) => {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 0;
    const proxyOptions = {...options};
    delete proxyOptions.timeoutMs;
    let timeout = null;
    if (timeoutMs && !proxyOptions.signal) {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      proxyOptions.signal = controller.signal;
    }

    try {
      return await proxyToSage(req, targetPath, proxyOptions);
    } catch (error) {
      const timedOut = Boolean(timeoutMs && proxyOptions.signal?.aborted);
      logger?.warn?.("Moon auth broker request failed.", {
        targetPath,
        error: timedOut ? `Timed out after ${timeoutMs}ms.` : error instanceof Error ? error.message : String(error)
      });
      return {
        status: 502,
        payload: {
          error: fallbackError,
          detail: timedOut ? `Timed out after ${timeoutMs}ms.` : error instanceof Error ? error.message : String(error)
        }
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };

  /**
   * Resolve a Sage-owned Discord OAuth URL and parse the browser-bound nonce.
   *
   * @param {import("express").Request} req
   * @param {string} returnTo
   * @returns {Promise<{result: {status: number, payload: any}, oauthUrl: URL | null, oauthState: {nonce: string, returnTo: string}}>}
   */
  const resolveDiscordLogin = async (req, returnTo) => {
    const query = toQueryString({returnTo});
    const result = await safeProxyToSage(
      req,
      `/api/auth/discord/url${query ? `?${query}` : ""}`,
      "Discord login broker unavailable."
    );
    let oauthUrl = null;
    try {
      oauthUrl = result.payload?.oauthUrl ? new URL(result.payload.oauthUrl) : null;
    } catch {
      oauthUrl = null;
    }
    return {
      result,
      oauthUrl,
      oauthState: oauthUrl ? parseOauthState(oauthUrl.searchParams.get("state")) : {nonce: "", returnTo}
    };
  };

  /**
   * Attach the short-lived OAuth state cookie when Sage returns a valid nonce.
   *
   * @param {import("express").Request} req
   * @param {import("express").Response} res
   * @param {{nonce: string}} oauthState
   * @returns {void}
   */
  const setOauthStateCookie = (req, res, oauthState) => {
    if (!oauthState.nonce) {
      return;
    }
    res.setHeader("Set-Cookie", serializeCookie(oauthStateCookieName, oauthState.nonce, {
      maxAge: 300,
      path: "/api/moon/auth/discord/callback",
      secure: shouldUseSecureCookie(config, req)
    }));
  };

  app.get("/api/moon/auth/bootstrap-status", async (req, res) => {
    const result = await proxyToSage(req, "/api/auth/bootstrap-status");
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/chrome/bootstrap", async (req, res) => {
    const chromeProxyOptions = {timeoutMs: chromeBootstrapProxyTimeoutMs};
    const [branding, auth, bootstrap] = await Promise.all([
      safeProxyToSage(req, "/api/moon-v3/public/branding", "Branding broker unavailable.", chromeProxyOptions),
      safeProxyToSage(req, "/api/auth/status", "Auth broker unavailable.", chromeProxyOptions),
      safeProxyToSage(req, "/api/auth/bootstrap-status", "Bootstrap broker unavailable.", chromeProxyOptions)
    ]);
    const authPayload = auth.status >= 200 && auth.status < 400 ? auth.payload : null;
    const user = authPayload?.user || (authPayload?.authenticated ? authPayload : null);
    res.json({
      branding: branding.status >= 200 && branding.status < 400 ? branding.payload : {siteName: "Scriptarr"},
      auth: authPayload,
      user,
      bootstrap: bootstrap.status >= 200 && bootstrap.status < 400 ? bootstrap.payload : null,
      errors: {
        branding: branding.status >= 500 ? branding.payload?.error || "Branding broker unavailable." : "",
        auth: auth.status >= 500 ? auth.payload?.error || "Auth broker unavailable." : "",
        bootstrap: bootstrap.status >= 500 ? bootstrap.payload?.error || "Bootstrap broker unavailable." : ""
      }
    });
  });

  app.get("/api/moon/auth/discord/url", async (req, res) => {
    const {result, oauthState} = await resolveDiscordLogin(req, sanitizeReturnToPath(req.query?.returnTo, "/"));
    setOauthStateCookie(req, res, oauthState);
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/auth/discord/start", async (req, res) => {
    const {result, oauthUrl, oauthState} = await resolveDiscordLogin(req, sanitizeReturnToPath(req.query?.returnTo, "/"));
    setOauthStateCookie(req, res, oauthState);
    if (!oauthUrl || result.status >= 400) {
      const status = result.status >= 400 ? result.status : 502;
      res
        .status(status)
        .type("html")
        .send(`<pre>Discord login failed: ${escapeHtml(result.payload?.error || "Discord login broker unavailable.")}</pre>`);
      return;
    }
    res.redirect(302, oauthUrl.toString());
  });

  app.get("/api/moon/auth/discord/callback", async (req, res) => {
    const query = toQueryString(req.query);
    const cookies = parseCookies(req.headers.cookie || "");
    const expectedNonce = String(cookies[oauthStateCookieName] || "").trim();
    const receivedState = parseOauthState(req.query?.state);
    const secureCookie = shouldUseSecureCookie(config, req);
    const clearOauthCookie = serializeCookie(oauthStateCookieName, "", {
      maxAge: 0,
      path: "/api/moon/auth/discord/callback",
      secure: secureCookie
    });
    if (!expectedNonce || !receivedState.nonce || expectedNonce !== receivedState.nonce) {
      res.setHeader("Set-Cookie", clearOauthCookie);
      res.status(403).send("<pre>Discord login failed: OAuth state did not match this browser session.</pre>");
      return;
    }
    const result = await safeProxyToSage(
      req,
      `/api/auth/discord/callback${query ? `?${query}` : ""}`,
      "Discord login broker unavailable."
    );

    if (result.status >= 400 || !result.payload?.token) {
      logger?.warn("Discord login failed in Moon callback route.", {
        status: result.status,
        error: result.payload?.error || "Unknown error"
      });
      res.setHeader("Set-Cookie", clearOauthCookie);
      res.status(result.status).send(`<pre>Discord login failed: ${result.payload?.error || "Unknown error"}</pre>`);
      return;
    }

    res.setHeader("Set-Cookie", [
      clearOauthCookie,
      serializeCookie(config.sessionCookieName, result.payload.token, {secure: secureCookie})
    ]);
    const fallbackPath = sanitizeReturnToPath(result.payload?.returnTo, "/");
    const targetPath = fallbackPath.startsWith("/admin") && !canAccessAdmin(result.payload?.user)
      ? "/"
      : fallbackPath;
    res
      .status(200)
      .type("html")
      .send(renderAuthRelayPage({
        targetPath,
        publicOrigin: resolvePublicOrigin(config, req),
        user: result.payload?.user || null
      }));
  });

  app.get("/api/moon/auth/status", async (req, res) => {
    const result = await proxyToSage(req, "/api/auth/status");
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/auth/logout", async (req, res) => {
    await proxyToSage(req, "/api/auth/logout", {method: "POST"});
    res.setHeader("Set-Cookie", serializeCookie(config.sessionCookieName, "", {
      maxAge: 0,
      secure: shouldUseSecureCookie(config, req)
    }));
    res.json({ok: true});
  });
};

export default registerAuthRoutes;
