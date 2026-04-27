/**
 * @file Scriptarr Sage module: services/sage/lib/discordAuth.mjs.
 */
const encode = encodeURIComponent;

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
 * @param {{returnTo?: string}} [value]
 * @returns {string}
 */
export const buildDiscordOauthState = ({returnTo = "/"} = {}) =>
  Buffer.from(JSON.stringify({
    returnTo: sanitizeReturnToPath(returnTo, "/")
  }), "utf8").toString("base64url");

/**
 * Decode a Discord OAuth state payload back into Scriptarr's auth hints.
 *
 * @param {unknown} value
 * @returns {{returnTo: string}}
 */
export const parseDiscordOauthState = (value) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return {returnTo: "/"};
  }

  try {
    const parsed = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8"));
    return {
      returnTo: sanitizeReturnToPath(parsed?.returnTo, "/")
    };
  } catch {
    return {returnTo: "/"};
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
 * @param {{returnTo?: string}} [options]
 * @returns {string}
 */
export const buildDiscordOauthUrl = (config, {returnTo = "/"} = {}) => {
  const callbackUrl = buildCallbackUrl(config);
  const scopes = encode("identify");
  const state = encode(buildDiscordOauthState({returnTo}));
  return `https://discord.com/oauth2/authorize?client_id=${encode(config.discordClientId)}&response_type=code&redirect_uri=${encode(callbackUrl)}&scope=${scopes}&state=${state}`;
};

/**
 * Exchange a Discord OAuth authorization code for the current user identity.
 *
 * @param {{discordClientId: string, discordClientSecret: string, publicBaseUrl: string}} config
 * @param {string} code
 * @returns {Promise<{discordUserId: string, username: string, avatarUrl: string | null}>}
 */
export const exchangeDiscordCode = async (config, code) => {
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
    })
  });

  if (!tokenResponse.ok) {
    throw new Error(`Discord token exchange failed with status ${tokenResponse.status}.`);
  }

  const tokenPayload = await tokenResponse.json();
  const meResponse = await fetch("https://discord.com/api/users/@me", {
    headers: {
      "Authorization": `Bearer ${tokenPayload.access_token}`
    }
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

