/**
 * Remove a trailing slash from a base URL style string.
 *
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
const normalizeBaseUrl = (value, fallback) => String(value || fallback).replace(/\/$/, "");

/**
 * Resolve the Scriptarr Moon runtime configuration from environment variables.
 *
 * @returns {{
 *   port: number,
 *   sageBaseUrl: string,
 *   sessionCookieName: string
 * }}
 */
export const resolveMoonConfig = () => ({
  port: Number.parseInt(process.env.SCRIPTARR_MOON_PORT || "3000", 10),
  sageBaseUrl: normalizeBaseUrl(process.env.SCRIPTARR_SAGE_BASE_URL, "http://127.0.0.1:3004"),
  sessionCookieName: "scriptarr_session"
});

export default resolveMoonConfig;
