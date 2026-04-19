const normalize = (value, fallback) => String(value || fallback).replace(/\/$/, "");

export const resolvePortalConfig = () => ({
  port: Number.parseInt(process.env.SCRIPTARR_PORTAL_PORT || "3003", 10),
  vaultBaseUrl: normalize(process.env.SCRIPTARR_VAULT_BASE_URL, "http://127.0.0.1:3005"),
  oracleBaseUrl: normalize(process.env.SCRIPTARR_ORACLE_BASE_URL, "http://127.0.0.1:3001"),
  serviceToken: process.env.SCRIPTARR_PORTAL_SERVICE_TOKEN || "portal-dev-token",
  discordToken: process.env.DISCORD_TOKEN || "",
  onboardingTemplate: process.env.SCRIPTARR_ONBOARDING_TEMPLATE || "Welcome to Scriptarr, {username}. Requests are moderated, and Noona can answer read-only status questions."
});
