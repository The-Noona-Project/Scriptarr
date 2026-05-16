"use client";

/**
 * @file Browser-local JSON cache for Moon's card-heavy user surfaces.
 */

export const MOON_JSON_CACHE_NAME = "moon-user-json-v1";
export const MOON_JSON_CACHE_VERSION = "moon-card-json-v1";

const CACHE_REQUEST_PATH = "/__moon_user_json_cache__";
const DEFAULT_CACHE_ORIGIN = "https://moon.local";
const MAX_CACHE_ENTRIES_PER_USER = 24;

const normalizeString = (value) => String(value || "").trim();

const resolveCacheOrigin = () => {
  if (typeof globalThis !== "undefined" && globalThis.location?.origin) {
    return globalThis.location.origin;
  }
  return DEFAULT_CACHE_ORIGIN;
};

const hasCacheStorage = () =>
  typeof globalThis !== "undefined"
  && Boolean(globalThis.caches)
  && typeof globalThis.caches.open === "function"
  && typeof Request !== "undefined"
  && typeof Response !== "undefined";

const openJsonCache = async () => {
  if (!hasCacheStorage()) {
    return null;
  }
  try {
    return await globalThis.caches.open(MOON_JSON_CACHE_NAME);
  } catch {
    return null;
  }
};

const parseUrl = (url) => {
  try {
    return new URL(String(url || ""), resolveCacheOrigin());
  } catch {
    return null;
  }
};

/**
 * Normalize the user cache key used to isolate signed-in reader payloads.
 *
 * @param {unknown} userKey
 * @returns {string}
 */
export const normalizeMoonJsonCacheUserKey = (userKey) =>
  normalizeString(userKey).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 128);

/**
 * Resolve the exact same-origin URL identity used for persistent JSON entries.
 *
 * @param {string} url
 * @returns {string}
 */
export const canonicalMoonJsonCacheUrl = (url) => {
  const parsed = parseUrl(url);
  return parsed ? `${parsed.pathname}${parsed.search}` : "";
};

/**
 * Resolve the persistent cache scope for a Moon user JSON route.
 *
 * @param {string} url
 * @returns {"" | "home" | "library" | "profile"}
 */
export const resolvePersistentMoonJsonCacheScope = (url) => {
  const parsed = parseUrl(url);
  if (!parsed) {
    return "";
  }
  if (parsed.pathname === "/api/moon-v3/user/home" && !parsed.search) {
    return "home";
  }
  if (parsed.pathname === "/api/moon-v3/user/profile" && !parsed.search) {
    return "profile";
  }
  if (parsed.pathname === "/api/moon-v3/user/library" && parsed.searchParams.get("view") === "card") {
    return "library";
  }
  return "";
};

/**
 * Decide whether a URL is eligible for the return-visit JSON cache.
 *
 * @param {string} url
 * @returns {boolean}
 */
export const isPersistentMoonJsonCacheable = (url) => Boolean(resolvePersistentMoonJsonCacheScope(url));

/**
 * Build the synthetic CacheStorage request for a user-scoped JSON payload.
 *
 * @param {{url: string, userKey: string, scope?: string}} options
 * @returns {Request | null}
 */
export const buildPersistentMoonJsonCacheRequest = ({url, userKey, scope = ""}) => {
  const normalizedUserKey = normalizeMoonJsonCacheUserKey(userKey);
  const canonicalUrl = canonicalMoonJsonCacheUrl(url);
  const resolvedScope = normalizeString(scope) || resolvePersistentMoonJsonCacheScope(url);
  if (!normalizedUserKey || !canonicalUrl || !resolvedScope || !isPersistentMoonJsonCacheable(url)) {
    return null;
  }
  const cacheUrl = new URL(CACHE_REQUEST_PATH, resolveCacheOrigin());
  cacheUrl.searchParams.set("version", MOON_JSON_CACHE_VERSION);
  cacheUrl.searchParams.set("user", normalizedUserKey);
  cacheUrl.searchParams.set("scope", resolvedScope);
  cacheUrl.searchParams.set("url", canonicalUrl);
  return new Request(cacheUrl.toString(), {method: "GET"});
};

const parseCacheRequestMeta = (request) => {
  try {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== CACHE_REQUEST_PATH) {
      return null;
    }
    return {
      version: requestUrl.searchParams.get("version") || "",
      userKey: requestUrl.searchParams.get("user") || "",
      scope: requestUrl.searchParams.get("scope") || "",
      url: requestUrl.searchParams.get("url") || ""
    };
  } catch {
    return null;
  }
};

const readCacheEntry = async (cache, request) => {
  const response = await cache.match(request);
  if (!response) {
    return null;
  }
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
};

/**
 * Read a persisted Moon JSON payload for a signed-in user.
 *
 * @template T
 * @param {{url: string, userKey: string, scope?: string}} options
 * @returns {Promise<T | null>}
 */
export const readPersistentMoonJsonCache = async ({url, userKey, scope = ""}) => {
  const cache = await openJsonCache();
  const request = buildPersistentMoonJsonCacheRequest({url, userKey, scope});
  if (!cache || !request) {
    return null;
  }
  try {
    const entry = await readCacheEntry(cache, request);
    const normalizedUserKey = normalizeMoonJsonCacheUserKey(userKey);
    const canonicalUrl = canonicalMoonJsonCacheUrl(url);
    const resolvedScope = normalizeString(scope) || resolvePersistentMoonJsonCacheScope(url);
    if (
      entry?.version !== MOON_JSON_CACHE_VERSION
      || entry?.userKey !== normalizedUserKey
      || entry?.scope !== resolvedScope
      || entry?.url !== canonicalUrl
    ) {
      return null;
    }
    return entry.payload ?? null;
  } catch {
    return null;
  }
};

/**
 * Prune older JSON entries for one signed-in user.
 *
 * @param {string} userKey
 * @param {{maxEntries?: number}} [options]
 * @returns {Promise<number>}
 */
export const prunePersistentMoonJsonCache = async (userKey, {maxEntries = MAX_CACHE_ENTRIES_PER_USER} = {}) => {
  const cache = await openJsonCache();
  const normalizedUserKey = normalizeMoonJsonCacheUserKey(userKey);
  if (!cache || !normalizedUserKey) {
    return 0;
  }
  try {
    const keys = await cache.keys();
    const entries = [];
    for (const request of keys) {
      const meta = parseCacheRequestMeta(request);
      if (meta?.version !== MOON_JSON_CACHE_VERSION || meta.userKey !== normalizedUserKey) {
        continue;
      }
      const entry = await readCacheEntry(cache, request);
      entries.push({
        request,
        savedAtMs: Date.parse(String(entry?.savedAt || "")) || 0
      });
    }
    const overflow = entries
      .sort((left, right) => left.savedAtMs - right.savedAtMs)
      .slice(0, Math.max(0, entries.length - Math.max(1, Number.parseInt(String(maxEntries), 10) || 1)));
    await Promise.all(overflow.map((entry) => cache.delete(entry.request)));
    return overflow.length;
  } catch {
    return 0;
  }
};

/**
 * Persist a successful Moon JSON response for a signed-in user.
 *
 * @param {{url: string, userKey: string, scope?: string, payload: unknown}} options
 * @returns {Promise<boolean>}
 */
export const writePersistentMoonJsonCache = async ({url, userKey, scope = "", payload}) => {
  const cache = await openJsonCache();
  const request = buildPersistentMoonJsonCacheRequest({url, userKey, scope});
  if (!cache || !request) {
    return false;
  }
  try {
    const entry = {
      version: MOON_JSON_CACHE_VERSION,
      userKey: normalizeMoonJsonCacheUserKey(userKey),
      scope: normalizeString(scope) || resolvePersistentMoonJsonCacheScope(url),
      url: canonicalMoonJsonCacheUrl(url),
      savedAt: new Date().toISOString(),
      payload
    };
    await cache.put(request, new Response(JSON.stringify(entry), {
      headers: {"Content-Type": "application/json"}
    }));
    await prunePersistentMoonJsonCache(userKey);
    return true;
  } catch {
    return false;
  }
};

/**
 * Clear cached Moon JSON either for one user or for the whole local browser.
 *
 * @param {string} [userKey]
 * @returns {Promise<number>}
 */
export const clearPersistentMoonJsonCache = async (userKey = "") => {
  if (!hasCacheStorage()) {
    return 0;
  }
  const normalizedUserKey = normalizeMoonJsonCacheUserKey(userKey);
  if (!normalizedUserKey && typeof globalThis.caches.delete === "function") {
    try {
      return await globalThis.caches.delete(MOON_JSON_CACHE_NAME) ? 1 : 0;
    } catch {
      return 0;
    }
  }
  const cache = await openJsonCache();
  if (!cache || !normalizedUserKey) {
    return 0;
  }
  try {
    const keys = await cache.keys();
    let deleted = 0;
    for (const request of keys) {
      const meta = parseCacheRequestMeta(request);
      if (meta?.version === MOON_JSON_CACHE_VERSION && meta.userKey === normalizedUserKey) {
        deleted += await cache.delete(request) ? 1 : 0;
      }
    }
    return deleted;
  } catch {
    return 0;
  }
};

/**
 * Clear user-scoped cached JSON after auth failures that can expose stale rows.
 *
 * @param {number} status
 * @param {string} [userKey]
 * @returns {Promise<number>}
 */
export const clearPersistentMoonJsonCacheForStatus = async (status, userKey = "") => {
  const normalizedStatus = Number.parseInt(String(status), 10) || 0;
  return [401, 403].includes(normalizedStatus)
    ? clearPersistentMoonJsonCache(userKey)
    : 0;
};

export default {
  buildPersistentMoonJsonCacheRequest,
  canonicalMoonJsonCacheUrl,
  clearPersistentMoonJsonCache,
  clearPersistentMoonJsonCacheForStatus,
  isPersistentMoonJsonCacheable,
  normalizeMoonJsonCacheUserKey,
  prunePersistentMoonJsonCache,
  readPersistentMoonJsonCache,
  resolvePersistentMoonJsonCacheScope,
  writePersistentMoonJsonCache
};
