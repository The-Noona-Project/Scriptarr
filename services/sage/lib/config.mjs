/**
 * @file Scriptarr Sage module: services/sage/lib/config.mjs.
 */
/**
 * Normalize a service base URL by trimming any trailing slash.
 *
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
const normalizeBaseUrl = (value, fallback) => String(value || fallback).replace(/\/$/, "");
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

/**
 * Resolve the Scriptarr Sage runtime configuration from environment variables.
 *
 * @returns {{
 *   port: number,
 *   vaultBaseUrl: string,
 *   wardenBaseUrl: string,
 *   portalBaseUrl: string,
 *   oracleBaseUrl: string,
 *   ravenBaseUrl: string,
 *   publicBaseUrl: string,
 *   serviceToken: string,
 *   serviceTokens: Record<string, string>,
 *   superuserId: string,
 *   discordClientId: string,
 *   discordClientSecret: string,
 *   discordToken: string,
 *   autoProvisionDiscordUsers: boolean
 * }}
 */
export const resolveSageConfig = () => {
  const serviceTokens = {
    "scriptarr-sage": process.env.SCRIPTARR_SAGE_SERVICE_TOKEN || "sage-dev-token",
    ...parseServiceTokens(process.env.SCRIPTARR_SERVICE_TOKENS)
  };

  return {
    port: Number.parseInt(process.env.SCRIPTARR_SAGE_PORT || "3004", 10),
    vaultBaseUrl: normalizeBaseUrl(process.env.SCRIPTARR_VAULT_BASE_URL, "http://127.0.0.1:3005"),
    wardenBaseUrl: normalizeBaseUrl(process.env.SCRIPTARR_WARDEN_BASE_URL, "http://127.0.0.1:4001"),
    portalBaseUrl: normalizeBaseUrl(process.env.SCRIPTARR_PORTAL_BASE_URL, "http://127.0.0.1:3003"),
    oracleBaseUrl: normalizeBaseUrl(process.env.SCRIPTARR_ORACLE_BASE_URL, "http://127.0.0.1:3001"),
    ravenBaseUrl: normalizeBaseUrl(process.env.SCRIPTARR_RAVEN_BASE_URL, "http://127.0.0.1:8080"),
    publicBaseUrl: normalizeBaseUrl(process.env.SCRIPTARR_PUBLIC_BASE_URL, "http://localhost:3000"),
    serviceToken: process.env.SCRIPTARR_SERVICE_TOKEN || serviceTokens["scriptarr-sage"] || "sage-dev-token",
    serviceTokens,
    superuserId: process.env.SUPERUSER_ID || "",
    discordClientId: process.env.SCRIPTARR_DISCORD_CLIENT_ID || "",
    discordClientSecret: process.env.SCRIPTARR_DISCORD_CLIENT_SECRET || "",
    discordToken: process.env.SCRIPTARR_DISCORD_TOKEN || process.env.DISCORD_TOKEN || "",
    autoProvisionDiscordUsers: process.env.SCRIPTARR_AUTO_PROVISION_DISCORD_USERS !== "false"
  };
};

