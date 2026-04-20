const normalizeUrl = (value, fallback = "") => {
  const normalized = String(value || fallback).trim();
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/$/, "");
};

const parseServiceTokens = (value) => {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const normalizeString = (value, fallback = "") => {
  const normalized = String(value ?? fallback).trim();
  return normalized || fallback;
};

const normalizeOptionalString = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

const normalizeCommandEnvKey = (commandName) =>
  String(commandName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");

export const PORTAL_COMMAND_NAMES = Object.freeze([
  "ding",
  "status",
  "chat",
  "search",
  "request",
  "subscribe",
  "downloadall"
]);

const resolveCommandDefaults = (env) =>
  Object.fromEntries(PORTAL_COMMAND_NAMES.map((name) => [
    name,
    {
      enabled: true,
      roleId: normalizeOptionalString(env[`REQUIRED_ROLE_${normalizeCommandEnvKey(name)}`])
    }
  ]));

export const resolvePortalConfig = (env = process.env) => ({
  port: Number.parseInt(env.SCRIPTARR_PORTAL_PORT || "3003", 10),
  sageBaseUrl: normalizeUrl(env.SCRIPTARR_SAGE_BASE_URL, "http://127.0.0.1:3004"),
  serviceToken: env.SCRIPTARR_SERVICE_TOKEN || env.SCRIPTARR_PORTAL_SERVICE_TOKEN || "portal-dev-token",
  serviceTokens: parseServiceTokens(env.SCRIPTARR_SERVICE_TOKENS),
  publicBaseUrl: normalizeUrl(env.SCRIPTARR_PUBLIC_BASE_URL || env.SCRIPTARR_MOON_BASE_URL, ""),
  discordToken: normalizeString(env.SCRIPTARR_DISCORD_TOKEN || env.DISCORD_TOKEN || "", ""),
  discordClientId: normalizeString(env.SCRIPTARR_DISCORD_CLIENT_ID || "", ""),
  discordDefaults: {
    guildId: normalizeOptionalString(env.SCRIPTARR_DISCORD_GUILD_ID || env.REQUIRED_GUILD_ID),
    superuserId: normalizeOptionalString(env.SCRIPTARR_DISCORD_SUPERUSER_ID || env.SUPERUSER_ID),
    onboarding: {
      channelId: normalizeOptionalString(env.SCRIPTARR_DISCORD_ONBOARDING_CHANNEL_ID),
      template: normalizeString(
        env.SCRIPTARR_ONBOARDING_TEMPLATE,
        "Welcome to Scriptarr, {username}. Requests are moderated, and Noona can answer read-only status questions."
      )
    },
    commands: resolveCommandDefaults(env)
  }
});
