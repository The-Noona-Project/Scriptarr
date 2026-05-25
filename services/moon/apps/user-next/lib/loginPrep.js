"use client";

/**
 * @file Bounded post-login data warmup for Moon's dedicated login page.
 */

import {buildCatalogueApiUrl, normalizeCatalogueSearchParams} from "./browse.js";
import {requestJson} from "./api.js";
import {resolvePersistentMoonJsonCacheScope, writePersistentMoonJsonCache} from "./persistentJsonCache.js";
import {normalizeLoginReturnTo} from "./loginReturnTo.js";

export const POST_LOGIN_PREP_TIMEOUT_MS = 2000;

const HOME_PREP_URL = "/api/moon-v3/user/home";
const LIBRARY_COUNTS_PREP_URL = "/api/moon-v3/user/library?view=card&pageSize=1";
const DEFAULT_LIBRARY_PREP_URL = "/api/moon-v3/user/library?view=card&pageSize=72";
const PROFILE_PREP_URL = "/api/moon-v3/user/profile";

const normalizeString = (value) => String(value || "").trim();

const resolvePathType = (pathname) => {
  const match = normalizeString(pathname).match(/^\/library\/([^/?#]+)/);
  if (!match?.[1]) {
    return "";
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1] || "";
  }
};

const parseReturnTo = (returnTo) => {
  try {
    return new URL(normalizeLoginReturnTo(returnTo), "https://moon.local");
  } catch {
    return new URL("/", "https://moon.local");
  }
};

const buildExactLibraryPrepUrl = (returnTo) => {
  const parsed = parseReturnTo(returnTo);
  const isLibraryRoute = parsed.pathname === "/library" || parsed.pathname.startsWith("/library/");
  const isBrowseRoute = parsed.pathname === "/browse" || parsed.pathname.startsWith("/browse/");
  if (!isLibraryRoute && !isBrowseRoute) {
    return "";
  }

  const searchParams = normalizeCatalogueSearchParams(parsed.searchParams, {
    fallbackType: resolvePathType(parsed.pathname),
    fallbackView: isLibraryRoute ? "rows" : "grid"
  });
  return buildCatalogueApiUrl({
    query: searchParams.query,
    type: searchParams.type,
    letter: searchParams.letter,
    view: searchParams.view,
    pageSize: searchParams.pageSize
  });
};

/**
 * Resolve the stable user key used for post-login persistent cache entries.
 *
 * @param {Record<string, unknown> | null | undefined} user
 * @returns {string}
 */
export const resolvePostLoginPrepUserKey = (user) =>
  normalizeString(user?.discordUserId || user?.discordId || user?.id);

/**
 * Resolve the allowlisted user JSON URLs Moon may warm after login.
 *
 * @param {unknown} returnTo
 * @returns {string[]}
 */
export const resolvePostLoginPrepUrls = (returnTo = "/") => {
  const parsed = parseReturnTo(returnTo);
  if (parsed.pathname === "/admin" || parsed.pathname.startsWith("/admin/")) {
    return [];
  }
  const urls = [
    HOME_PREP_URL,
    LIBRARY_COUNTS_PREP_URL,
    DEFAULT_LIBRARY_PREP_URL
  ];
  const exactLibraryUrl = buildExactLibraryPrepUrl(returnTo);

  if (exactLibraryUrl) {
    urls.push(exactLibraryUrl);
  }
  if (parsed.pathname === "/profile" || parsed.pathname.startsWith("/profile/")) {
    urls.push(PROFILE_PREP_URL);
  }

  return Array.from(new Set(urls));
};

/**
 * Warm and persist safe Moon user payloads without blocking the login page
 * longer than the configured cap.
 *
 * @param {{returnTo?: string, user?: Record<string, unknown> | null, timeoutMs?: number}} options
 * @returns {Promise<{attempted: number, cached: number, timedOut: boolean}>}
 */
export const preloadPostLoginUserData = async ({returnTo = "/", user = null, timeoutMs = POST_LOGIN_PREP_TIMEOUT_MS} = {}) => {
  const userKey = resolvePostLoginPrepUserKey(user);
  const urls = resolvePostLoginPrepUrls(returnTo).filter((url) => resolvePersistentMoonJsonCacheScope(url));
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));

  try {
    const settled = await Promise.allSettled(urls.map(async (url) => {
      const scope = resolvePersistentMoonJsonCacheScope(url);
      if (!userKey || !scope) {
        return false;
      }
      const result = await requestJson(url, {signal: controller.signal});
      if (!result.ok) {
        return false;
      }
      return writePersistentMoonJsonCache({
        url,
        userKey,
        scope,
        payload: result.payload
      });
    }));
    return {
      attempted: urls.length,
      cached: settled.filter((entry) => entry.status === "fulfilled" && entry.value).length,
      timedOut
    };
  } finally {
    window.clearTimeout(timeout);
    controller.abort();
  }
};

export default {
  POST_LOGIN_PREP_TIMEOUT_MS,
  preloadPostLoginUserData,
  resolvePostLoginPrepUrls,
  resolvePostLoginPrepUserKey
};
