import {parseCookies, serializeCookie} from "./cookies.mjs";
import {proxyJson} from "./proxy.mjs";
import {canAccessAdmin as canAccessMoonAdmin} from "@scriptarr/access";

const DEFAULT_CHROME_BOOTSTRAP_PROXY_TIMEOUT_MS = 3000;
const DEFAULT_AUTH_STATUS_PROXY_TIMEOUT_MS = 5000;
const OAUTH_STATE_COOKIE_PATH = "/api/moon/auth/discord";
const LEGACY_OAUTH_STATE_COOKIE_PATH = "/api/moon/auth/discord/callback";
const MAX_CALLBACK_QUERY_LENGTH = 4096;

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
  const unsafeCharacters = /[\\\u0000-\u001f\u007f]/;
  const safeFallback = typeof fallback === "string" && fallback.startsWith("/") && !fallback.startsWith("//") && !unsafeCharacters.test(fallback)
    ? fallback
    : "/";
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || unsafeCharacters.test(normalized)) {
    return safeFallback;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    return safeFallback;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || unsafeCharacters.test(decoded)) {
    return safeFallback;
  }
  let parsed;
  try {
    parsed = new URL(decoded, "https://moon.local");
  } catch {
    return safeFallback;
  }
  const pathname = parsed.pathname || "/";
  if (
    parsed.origin !== "https://moon.local"
    || pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/login"
    || pathname.startsWith("/login/")
    || pathname.startsWith("/_next/")
    || pathname.startsWith("/admin/_next/")
    || pathname.startsWith("/reader/_next/")
  ) {
    return safeFallback;
  }
  return `${pathname}${parsed.search}${parsed.hash}` || safeFallback;
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
 * Parse the browser-captured Discord callback query without logging it.
 *
 * @param {unknown} value
 * @returns {{ok: boolean, query: string, params: URLSearchParams, error?: string}}
 */
const normalizeCallbackQuery = (value) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return {ok: true, query: "", params: new URLSearchParams()};
  }
  if (raw.length > MAX_CALLBACK_QUERY_LENGTH) {
    return {ok: false, query: "", params: new URLSearchParams(), error: "Discord callback payload was too large."};
  }
  try {
    const params = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
    return {ok: true, query: params.toString(), params};
  } catch {
    return {ok: false, query: "", params: new URLSearchParams(), error: "Discord callback payload could not be read."};
  }
};

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

const resolveAuthStatusProxyTimeoutMs = () => {
  const parsed = Number.parseInt(process.env.SCRIPTARR_MOON_AUTH_STATUS_PROXY_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_AUTH_STATUS_PROXY_TIMEOUT_MS;
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

/**
 * Validate browser-originated auth completion requests when an Origin header is
 * present. SameSite cookies and the OAuth nonce still carry the primary bind.
 *
 * @param {import("express").Request} req
 * @param {{publicBaseUrl?: string}} config
 * @returns {boolean}
 */
const allowsAuthCompletionOrigin = (req, config) => {
  const origin = String(req.get("origin") || "").trim();
  if (!origin) {
    return true;
  }
  return origin === resolvePublicOrigin(config, req);
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

/**
 * Render the same-origin Discord callback loader. The actual OAuth query is
 * read by the browser and sent to Moon's complete route without being rendered.
 *
 * @param {{publicOrigin?: string}} options
 * @returns {string}
 */
const renderAuthCallbackLoaderPage = ({publicOrigin}) => {
  const safeOrigin = JSON.stringify(publicOrigin || "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Signing in...</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: linear-gradient(145deg, #06090d, #0d151b 54%, #070b10); color: #f7efe4; font-family: Inter, system-ui, sans-serif; }
      main { width: min(420px, calc(100vw - 32px)); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px; background: rgba(15, 22, 28, 0.92); box-shadow: 0 28px 70px rgba(0, 0, 0, 0.34); padding: 28px; }
      .auth-mark { width: 48px; height: 48px; border: 3px solid rgba(255, 255, 255, 0.16); border-top-color: #f5a24c; border-radius: 50%; animation: spin 0.85s linear infinite; margin-bottom: 18px; }
      .auth-kicker { margin: 0 0 8px; color: #8fc8ff; font-size: 0.74rem; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; }
      h1 { margin: 0; font-size: 1.35rem; line-height: 1.2; }
      p { color: rgba(247, 239, 228, 0.72); line-height: 1.55; margin: 12px 0 0; }
      a { color: #f7efe4; }
      .auth-actions { display: none; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
      .auth-actions.is-visible { display: flex; }
      .auth-actions a { border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 8px; padding: 10px 12px; text-decoration: none; }
      main.is-error .auth-mark { animation: none; border-color: rgba(255, 101, 117, 0.28); border-top-color: #ff6575; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .auth-mark { animation: none; } }
    </style>
  </head>
  <body>
    <main id="auth-card" role="status" aria-live="polite">
      <div class="auth-mark" aria-hidden="true"></div>
      <p class="auth-kicker">Discord login</p>
      <h1 id="auth-title">Authenticating</h1>
      <p id="auth-copy">Checking this browser's login handoff.</p>
      <div id="auth-actions" class="auth-actions">
        <a href="/login">Try again</a>
        <a href="/">Open home</a>
      </div>
    </main>
    <script>
      const publicOrigin = ${safeOrigin};
      const callbackQuery = window.location.search || "";
      const phases = [
        ["Authenticating", "Checking this browser's login handoff."],
        ["Verifying", "Confirming your Discord identity with Scriptarr."],
        ["Connecting", "Opening your Scriptarr session."],
        ["Redirecting", "Taking you back to the page you requested."]
      ];
      const card = document.getElementById("auth-card");
      const title = document.getElementById("auth-title");
      const copy = document.getElementById("auth-copy");
      const actions = document.getElementById("auth-actions");
      let phaseIndex = 0;
      try {
        window.history.replaceState(null, "", "/api/moon/auth/discord/callback");
      } catch {}
      const showPhase = (index) => {
        const phase = phases[Math.min(index, phases.length - 1)];
        title.textContent = phase[0];
        copy.textContent = phase[1];
      };
      const phaseTimer = window.setInterval(() => {
        phaseIndex += 1;
        showPhase(phaseIndex);
      }, 650);
      const finishWithError = (message) => {
        window.clearInterval(phaseTimer);
        card.classList.add("is-error");
        title.textContent = "Login needs another try";
        copy.textContent = message || "Scriptarr could not finish signing you in.";
        actions.classList.add("is-visible");
      };

      fetch("/api/moon/auth/discord/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({callbackQuery})
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          finishWithError(payload.error);
          return;
        }
        window.clearInterval(phaseTimer);
        showPhase(3);
        const targetPath = payload.returnTo || "/";
        const message = {type: "scriptarr-auth-complete", returnTo: targetPath};
        try {
          if (window.opener && !window.opener.closed) {
            try {
              window.opener.postMessage(message, publicOrigin || "*");
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
      }).catch(() => {
        finishWithError("Scriptarr could not reach the login service. Please try again.");
      });
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
  const authStatusProxyTimeoutMs = resolveAuthStatusProxyTimeoutMs();
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
    const logPath = proxyOptions.logPath || targetPath;
    delete proxyOptions.logPath;
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
        targetPath: logPath,
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
      path: OAUTH_STATE_COOKIE_PATH,
      secure: shouldUseSecureCookie(config, req)
    }));
  };

  const clearOauthStateCookies = (req) => {
    const secureCookie = shouldUseSecureCookie(config, req);
    return [
      serializeCookie(oauthStateCookieName, "", {
        maxAge: 0,
        path: OAUTH_STATE_COOKIE_PATH,
        secure: secureCookie
      }),
      serializeCookie(oauthStateCookieName, "", {
        maxAge: 0,
        path: LEGACY_OAUTH_STATE_COOKIE_PATH,
        secure: secureCookie
      })
    ];
  };

  app.get("/api/moon/auth/bootstrap-status", async (req, res) => {
    const result = await safeProxyToSage(req, "/api/auth/bootstrap-status", "Bootstrap broker unavailable.", {
      timeoutMs: authStatusProxyTimeoutMs
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/chrome/bootstrap", async (req, res) => {
    const chromeProxyOptions = {timeoutMs: chromeBootstrapProxyTimeoutMs};
    const authProxyOptions = {timeoutMs: authStatusProxyTimeoutMs};
    const [branding, auth, bootstrap] = await Promise.all([
      safeProxyToSage(req, "/api/moon-v3/public/branding", "Branding broker unavailable.", chromeProxyOptions),
      safeProxyToSage(req, "/api/auth/status", "Auth broker unavailable.", authProxyOptions),
      safeProxyToSage(req, "/api/auth/bootstrap-status", "Bootstrap broker unavailable.", authProxyOptions)
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
    res
      .status(200)
      .set("Cache-Control", "no-store")
      .type("html")
      .send(renderAuthCallbackLoaderPage({
        publicOrigin: resolvePublicOrigin(config, req)
      }));
  });

  app.post("/api/moon/auth/discord/complete", async (req, res) => {
    if (!allowsAuthCompletionOrigin(req, config)) {
      res.setHeader("Set-Cookie", clearOauthStateCookies(req));
      res.status(403).json({
        ok: false,
        error: "Discord login must finish from this Scriptarr site.",
        phase: "origin"
      });
      return;
    }
    const parsedQuery = normalizeCallbackQuery(req.body?.callbackQuery);
    if (!parsedQuery.ok) {
      res.setHeader("Set-Cookie", clearOauthStateCookies(req));
      res.status(400).json({
        ok: false,
        error: parsedQuery.error || "Discord login could not be completed."
      });
      return;
    }
    const query = parsedQuery.query;
    const cookies = parseCookies(req.headers.cookie || "");
    const expectedNonce = String(cookies[oauthStateCookieName] || "").trim();
    const receivedState = parseOauthState(parsedQuery.params.get("state"));
    const secureCookie = shouldUseSecureCookie(config, req);
    const clearOauthCookies = clearOauthStateCookies(req);
    if (!expectedNonce || !receivedState.nonce || expectedNonce !== receivedState.nonce) {
      res.setHeader("Set-Cookie", clearOauthCookies);
      res.status(403).json({
        ok: false,
        error: "OAuth state did not match this browser session.",
        phase: "state"
      });
      return;
    }
    const result = await safeProxyToSage(
      req,
      `/api/auth/discord/callback${query ? `?${query}` : ""}`,
      "Discord login broker unavailable.",
      {logPath: "/api/auth/discord/callback"}
    );

    if (result.status >= 400 || !result.payload?.token) {
      logger?.warn("Discord login failed in Moon callback route.", {
        status: result.status,
        error: result.payload?.error || "Unknown error"
      });
      res.setHeader("Set-Cookie", clearOauthCookies);
      res.status(result.status).json({
        ok: false,
        error: result.payload?.error || "Unknown error",
        phase: result.payload?.phase || "unknown"
      });
      return;
    }

    res.setHeader("Set-Cookie", [
      ...clearOauthCookies,
      serializeCookie(config.sessionCookieName, result.payload.token, {secure: secureCookie})
    ]);
    const fallbackPath = sanitizeReturnToPath(result.payload?.returnTo, "/");
    const targetPath = fallbackPath.startsWith("/admin") && !canAccessAdmin(result.payload?.user)
      ? "/"
      : fallbackPath;
    res.status(200).json({
      ok: true,
      returnTo: targetPath
    });
  });

  app.get("/api/moon/auth/status", async (req, res) => {
    const result = await safeProxyToSage(req, "/api/auth/status", "Auth broker unavailable.", {
      timeoutMs: authStatusProxyTimeoutMs
    });
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
