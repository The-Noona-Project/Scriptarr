/**
 * @file Scriptarr Sage module: services/sage/lib/discordAuth.mjs.
 */
import {appendUserEvent} from "./adminEvents.mjs";

const encode = encodeURIComponent;
const DEFAULT_DISCORD_AUTH_TIMEOUT_MS = 8000;
const DEFAULT_VAULT_AUTH_TIMEOUT_MS = 3000;
const DEFAULT_AUTH_EVENT_TIMEOUT_MS = 1500;
const DISCORD_CALLBACK_PHASE_MESSAGES = Object.freeze({
  "discord-token": "Discord token exchange failed. Please try again.",
  "discord-user": "Discord profile lookup failed. Please try again.",
  "vault-user": "Scriptarr could not load your user record. Please try again.",
  "vault-session": "Scriptarr could not create your session. Please try again.",
  "auth-event": "Scriptarr could not record the login event."
});
const VAULT_USER_SAFE_ERROR_PREFIXES = Object.freeze([
  "The instance does not have SUPERUSER_ID configured.",
  "This Discord account is not allowed to claim the first admin session.",
  "This Discord account is not provisioned for Scriptarr."
]);

const normalizePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isTimeoutLikeError = (error) => {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error || "");
  return name === "TimeoutError" || name === "AbortError" || /timed out|timeout/i.test(message);
};

const withTimeoutSignal = (timeoutMs) => {
  const normalized = normalizePositiveInteger(timeoutMs, 0);
  return normalized > 0 ? {signal: AbortSignal.timeout(normalized)} : {};
};

const resolveVaultUserPublicMessage = (error) => {
  const message = error instanceof Error ? error.message : String(error || "");
  return VAULT_USER_SAFE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
    ? message
    : DISCORD_CALLBACK_PHASE_MESSAGES["vault-user"];
};

const resolvePhaseStatus = (phase, error) => {
  if (isTimeoutLikeError(error)) {
    return 504;
  }
  if (phase === "vault-user") {
    const publicMessage = resolveVaultUserPublicMessage(error);
    return publicMessage === DISCORD_CALLBACK_PHASE_MESSAGES["vault-user"] ? 502 : 403;
  }
  return phase.startsWith("discord-") || phase.startsWith("vault-") ? 502 : 500;
};

const resolvePhasePublicMessage = (phase, error) => {
  if (phase === "vault-user") {
    return resolveVaultUserPublicMessage(error);
  }
  return DISCORD_CALLBACK_PHASE_MESSAGES[phase] || "Discord login could not be completed. Please try again.";
};

const timeoutError = (phase, timeoutMs) => {
  const error = new Error(`${phase} timed out after ${timeoutMs}ms.`);
  error.name = "TimeoutError";
  return error;
};

/**
 * Phase-scoped error raised during Discord callback completion.
 */
export class DiscordCallbackPhaseError extends Error {
  /**
   * @param {string} phase
   * @param {unknown} cause
   * @param {Array<{phase: string, status: string, durationMs: number}>} [timings]
   */
  constructor(phase, cause, timings = []) {
    super(resolvePhasePublicMessage(phase, cause));
    this.name = "DiscordCallbackPhaseError";
    this.phase = phase;
    this.status = resolvePhaseStatus(phase, cause);
    this.cause = cause;
    this.timings = timings;
  }
}

const runTimedPhase = async ({phase, timeoutMs, logger, failSoft = false, timings = []}, operation) => {
  const startedAt = Date.now();
  let timeout;
  try {
    const normalizedTimeoutMs = normalizePositiveInteger(timeoutMs, 0);
    const result = await Promise.race([
      operation(),
      normalizedTimeoutMs > 0
        ? new Promise((_, reject) => {
          timeout = setTimeout(() => reject(timeoutError(phase, normalizedTimeoutMs)), normalizedTimeoutMs);
        })
        : new Promise(() => {})
    ]);
    const durationMs = Date.now() - startedAt;
    timings.push({phase, status: "ok", durationMs});
    logger?.info?.("Discord callback phase completed.", {
      phase,
      durationMs
    });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    timings.push({phase, status: "failed", durationMs});
    logger?.warn?.("Discord callback phase failed.", {
      phase,
      durationMs,
      error: error instanceof Error ? error.message : String(error)
    });
    if (failSoft) {
      return null;
    }
    throw new DiscordCallbackPhaseError(phase, error, timings);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

/**
 * Normalize a caller-supplied return path so Moon only redirects back to safe
 * same-origin app routes after Discord auth completes.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const sanitizeReturnToPath = (value, fallback = "/") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    return fallback;
  }
  if (normalized.startsWith("/api/")) {
    return fallback;
  }
  return normalized || fallback;
};

/**
 * Encode Moon's post-auth redirect hints into Discord's OAuth state payload.
 *
 * @param {{returnTo?: string, nonce?: string}} [value]
 * @returns {string}
 */
export const buildDiscordOauthState = ({returnTo = "/", nonce = ""} = {}) =>
  Buffer.from(JSON.stringify({
    returnTo: sanitizeReturnToPath(returnTo, "/"),
    nonce: typeof nonce === "string" ? nonce.trim() : ""
  }), "utf8").toString("base64url");

/**
 * Decode a Discord OAuth state payload back into Scriptarr's auth hints.
 *
 * @param {unknown} value
 * @returns {{returnTo: string, nonce: string}}
 */
export const parseDiscordOauthState = (value) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return {returnTo: "/", nonce: ""};
  }

  try {
    const parsed = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8"));
    return {
      returnTo: sanitizeReturnToPath(parsed?.returnTo, "/"),
      nonce: typeof parsed?.nonce === "string" ? parsed.nonce.trim() : ""
    };
  } catch {
    return {returnTo: "/", nonce: ""};
  }
};

/**
 * Resolve the Discord OAuth callback URL Moon should send admins through.
 *
 * @param {{publicBaseUrl: string}} config
 * @returns {string}
 */
export const buildCallbackUrl = (config) =>
  process.env.SCRIPTARR_DISCORD_CALLBACK_URL
  || `${config.publicBaseUrl}/api/moon/auth/discord/callback`;

/**
 * Build the Discord OAuth authorize URL with Scriptarr's fixed identify scope.
 *
 * @param {{discordClientId: string, publicBaseUrl: string}} config
 * @param {{returnTo?: string, nonce?: string}} [options]
 * @returns {string}
 */
export const buildDiscordOauthUrl = (config, {returnTo = "/", nonce = ""} = {}) => {
  const callbackUrl = buildCallbackUrl(config);
  const scopes = encode("identify");
  const state = encode(buildDiscordOauthState({returnTo, nonce}));
  return `https://discord.com/oauth2/authorize?client_id=${encode(config.discordClientId)}&response_type=code&redirect_uri=${encode(callbackUrl)}&scope=${scopes}&state=${state}`;
};

/**
 * Exchange a Discord OAuth authorization code for an access token.
 *
 * @param {{discordClientId: string, discordClientSecret: string, publicBaseUrl: string, discordAuthTimeoutMs?: number}} config
 * @param {string} code
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{accessToken: string}>}
 */
export const exchangeDiscordToken = async (config, code, {timeoutMs = config.discordAuthTimeoutMs || DEFAULT_DISCORD_AUTH_TIMEOUT_MS} = {}) => {
  if (!config.discordClientId || !config.discordClientSecret) {
    throw new Error("Discord OAuth is not configured.");
  }

  const callbackUrl = buildCallbackUrl(config);
  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl
    }),
    ...withTimeoutSignal(timeoutMs)
  });

  if (!tokenResponse.ok) {
    throw new Error(`Discord token exchange failed with status ${tokenResponse.status}.`);
  }

  const tokenPayload = await tokenResponse.json();
  if (!tokenPayload?.access_token) {
    throw new Error("Discord token exchange did not return an access token.");
  }
  return {
    accessToken: tokenPayload.access_token
  };
};

/**
 * Load the signed-in Discord user profile for an access token.
 *
 * @param {string} accessToken
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{discordUserId: string, username: string, avatarUrl: string | null}>}
 */
export const fetchDiscordUser = async (accessToken, {timeoutMs = DEFAULT_DISCORD_AUTH_TIMEOUT_MS} = {}) => {
  if (!accessToken) {
    throw new Error("Discord access token is missing.");
  }

  const meResponse = await fetch("https://discord.com/api/users/@me", {
    headers: {
      "Authorization": `Bearer ${accessToken}`
    },
    ...withTimeoutSignal(timeoutMs)
  });

  if (!meResponse.ok) {
    throw new Error(`Discord user lookup failed with status ${meResponse.status}.`);
  }

  const me = await meResponse.json();
  return {
    discordUserId: me.id,
    username: me.global_name || me.username || me.id,
    avatarUrl: me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
      : null
  };
};

/**
 * Exchange a Discord OAuth authorization code for the current user identity.
 *
 * @param {{discordClientId: string, discordClientSecret: string, publicBaseUrl: string, discordAuthTimeoutMs?: number}} config
 * @param {string} code
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{discordUserId: string, username: string, avatarUrl: string | null}>}
 */
export const exchangeDiscordCode = async (config, code, {timeoutMs = config.discordAuthTimeoutMs || DEFAULT_DISCORD_AUTH_TIMEOUT_MS} = {}) => {
  const token = await exchangeDiscordToken(config, code, {timeoutMs});
  return fetchDiscordUser(token.accessToken, {timeoutMs});
};

/**
 * Upsert a Vault user from a Discord OAuth identity using the already-loaded
 * bootstrap state for this callback.
 *
 * @param {{vaultClient: ReturnType<import("./vaultClient.mjs").createVaultClient>, config: {superuserId?: string, autoProvisionDiscordUsers?: boolean, vaultAuthTimeoutMs?: number}, identity: {discordUserId: string, username: string, avatarUrl: string | null}, bootstrap: {ownerClaimed?: boolean} | null}} options
 * @returns {Promise<any>}
 */
export const upsertUserFromDiscord = async ({vaultClient, config, identity, bootstrap}) => {
  const timeoutMs = normalizePositiveInteger(config.vaultAuthTimeoutMs, DEFAULT_VAULT_AUTH_TIMEOUT_MS);

  if (!bootstrap?.ownerClaimed) {
    if (!config.superuserId) {
      throw new Error("The instance does not have SUPERUSER_ID configured.");
    }
    if (identity.discordUserId !== config.superuserId) {
      throw new Error("This Discord account is not allowed to claim the first admin session.");
    }

    return vaultClient.upsertDiscordUser({
      ...identity,
      role: "owner",
      claimOwner: true
    }, {timeoutMs, throwOnError: true});
  }

  const existing = await vaultClient.getUserByDiscordId(identity.discordUserId, {timeoutMs});
  if (existing) {
    return vaultClient.upsertDiscordUser({
      ...identity,
      role: existing.role,
      permissions: existing.permissions
    }, {timeoutMs, throwOnError: true});
  }

  if (!config.autoProvisionDiscordUsers) {
    throw new Error("This Discord account is not provisioned for Scriptarr.");
  }

  return vaultClient.upsertDiscordUser({
    ...identity,
    role: "member"
  }, {timeoutMs, throwOnError: true});
};

/**
 * Complete the Discord callback with bounded, logged phases.
 *
 * @param {{config: {discordClientId: string, discordClientSecret: string, publicBaseUrl: string, discordAuthTimeoutMs?: number, vaultAuthTimeoutMs?: number, authEventTimeoutMs?: number, superuserId?: string, autoProvisionDiscordUsers?: boolean}, vaultClient: ReturnType<import("./vaultClient.mjs").createVaultClient>, code: string, authState: {returnTo: string}, logger?: {info?: Function, warn?: Function}}} options
 * @returns {Promise<{token: string, user: any, returnTo: string}>}
 */
export const completeDiscordCallbackLogin = async ({config, vaultClient, code, authState, logger}) => {
  const discordTimeoutMs = normalizePositiveInteger(config.discordAuthTimeoutMs, DEFAULT_DISCORD_AUTH_TIMEOUT_MS);
  const vaultTimeoutMs = normalizePositiveInteger(config.vaultAuthTimeoutMs, DEFAULT_VAULT_AUTH_TIMEOUT_MS);
  const eventTimeoutMs = normalizePositiveInteger(config.authEventTimeoutMs, DEFAULT_AUTH_EVENT_TIMEOUT_MS);
  const timings = [];
  const token = await runTimedPhase({
    phase: "discord-token",
    timeoutMs: discordTimeoutMs,
    logger,
    timings
  }, () => exchangeDiscordToken(config, code, {timeoutMs: discordTimeoutMs}));
  const identity = await runTimedPhase({
    phase: "discord-user",
    timeoutMs: discordTimeoutMs,
    logger,
    timings
  }, () => fetchDiscordUser(token.accessToken, {timeoutMs: discordTimeoutMs}));
  const {bootstrap, user} = await runTimedPhase({
    phase: "vault-user",
    timeoutMs: vaultTimeoutMs,
    logger,
    timings
  }, async () => {
    const bootstrap = await vaultClient.getBootstrapStatus({timeoutMs: vaultTimeoutMs});
    const user = await upsertUserFromDiscord({vaultClient, config, identity, bootstrap});
    return {bootstrap, user};
  });
  const session = await runTimedPhase({
    phase: "vault-session",
    timeoutMs: vaultTimeoutMs,
    logger,
    timings
  }, () => vaultClient.createSession(user.discordUserId, {timeoutMs: vaultTimeoutMs}));

  if (!session?.token) {
    throw new DiscordCallbackPhaseError("vault-session", new Error("Vault session response did not include a token."), timings);
  }

  await runTimedPhase({
    phase: "auth-event",
    timeoutMs: eventTimeoutMs,
    logger,
    failSoft: true,
    timings
  }, () => appendUserEvent(vaultClient, {
    domain: "auth",
    eventType: bootstrap?.ownerClaimed ? "login" : "bootstrap-owner",
    user,
    targetType: "session",
    targetId: session.token,
    message: bootstrap?.ownerClaimed
      ? `${user.username} signed in through Discord.`
      : `${user.username} claimed the protected bootstrap owner session.`,
    metadata: {
      discordUserId: user.discordUserId,
      role: user.role
    }
  }, logger, {timeoutMs: eventTimeoutMs}).then((event) => {
    if (!event) {
      throw new Error("Auth event persistence failed.");
    }
    return event;
  }));

  logger?.info?.("Discord callback login completed.", {
    timings,
    discordUserId: user.discordUserId,
    role: user.role
  });

  return {token: session.token, user, returnTo: authState.returnTo};
};

/**
 * Convert a callback failure into a user-safe HTTP response.
 *
 * @param {unknown} error
 * @returns {{status: number, payload: {error: string, phase?: string}}}
 */
export const formatDiscordCallbackError = (error) => {
  if (error instanceof DiscordCallbackPhaseError) {
    return {
      status: error.status,
      payload: {
        error: error.message,
        phase: error.phase
      }
    };
  }
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.startsWith("Discord OAuth state")) {
    return {
      status: 403,
      payload: {
        error: message,
        phase: "state"
      }
    };
  }
  return {
    status: 403,
    payload: {
      error: "Discord login could not be completed. Please try again."
    }
  };
};
