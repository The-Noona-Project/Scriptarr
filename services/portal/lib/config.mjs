const normalize = (value, fallback) => String(value || fallback).replace(/\/$/, "");

export const resolvePortalConfig = () => ({
  port: Number.parseInt(process.env.SCRIPTARR_PORTAL_PORT || "3003", 10),
  sageBaseUrl: normalize(process.env.SCRIPTARR_SAGE_BASE_URL, "http://127.0.0.1:3004"),
  serviceToken: process.env.SCRIPTARR_SERVICE_TOKEN || process.env.SCRIPTARR_PORTAL_SERVICE_TOKEN || "portal-dev-token",
  discordToken: process.env.DISCORD_TOKEN || "",
  onboardingTemplate: process.env.SCRIPTARR_ONBOARDING_TEMPLATE || "Welcome to Scriptarr, {username}. Requests are moderated, and Noona can answer read-only status questions."
});
