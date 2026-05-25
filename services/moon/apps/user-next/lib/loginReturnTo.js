/**
 * @file Shared login return-path helpers for Moon's user, reader, and admin
 * browser entrypoints.
 */

const DEFAULT_LOGIN_RETURN_TO = "/";
const RETURN_TO_ORIGIN = "https://moon.local";

const hasUnsafeReturnToCharacters = (value) => /[\\\u0000-\u001f\u007f]/.test(value);

const decodeReturnToCandidate = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
};

/**
 * Normalize a same-origin browser return path for the dedicated login page.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const normalizeLoginReturnTo = (value, fallback = DEFAULT_LOGIN_RETURN_TO) => {
  const normalizedFallback = typeof fallback === "string" && fallback.startsWith("/") && !fallback.startsWith("//") && !hasUnsafeReturnToCharacters(fallback)
    ? fallback
    : DEFAULT_LOGIN_RETURN_TO;
  const rawValue = typeof value === "string" ? value.trim() : "";
  if (!rawValue) {
    return normalizedFallback;
  }
  if (hasUnsafeReturnToCharacters(rawValue)) {
    return normalizedFallback;
  }
  const decodedValue = decodeReturnToCandidate(rawValue);
  if (!decodedValue || hasUnsafeReturnToCharacters(decodedValue) || !decodedValue.startsWith("/") || decodedValue.startsWith("//")) {
    return normalizedFallback;
  }

  let parsed;
  try {
    parsed = new URL(decodedValue, RETURN_TO_ORIGIN);
  } catch {
    return normalizedFallback;
  }

  if (parsed.origin !== RETURN_TO_ORIGIN) {
    return normalizedFallback;
  }

  const pathname = parsed.pathname || "/";
  if (
    pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/login"
    || pathname.startsWith("/login/")
    || pathname.startsWith("/_next/")
    || pathname.startsWith("/admin/_next/")
    || pathname.startsWith("/reader/_next/")
  ) {
    return normalizedFallback;
  }

  return `${pathname}${parsed.search}${parsed.hash}` || normalizedFallback;
};

/**
 * Build the dedicated Moon login page URL for a same-origin destination.
 *
 * @param {unknown} returnTo
 * @returns {string}
 */
export const buildMoonLoginPageHref = (returnTo = DEFAULT_LOGIN_RETURN_TO) =>
  `/login?returnTo=${encodeURIComponent(normalizeLoginReturnTo(returnTo))}`;

/**
 * Build the same-origin OAuth starter URL used by the login page button.
 *
 * @param {unknown} returnTo
 * @returns {string}
 */
export const buildMoonDiscordLoginStartHref = (returnTo = DEFAULT_LOGIN_RETURN_TO) => {
  const targetPath = normalizeLoginReturnTo(returnTo);
  const relayPath = `/login?returnTo=${encodeURIComponent(targetPath)}&prepare=1`;
  return `/api/moon/auth/discord/start?returnTo=${encodeURIComponent(relayPath)}`;
};

export default {
  buildMoonDiscordLoginStartHref,
  buildMoonLoginPageHref,
  normalizeLoginReturnTo
};
