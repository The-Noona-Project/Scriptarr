"use client";

/**
 * @file Client-side Moon API helpers and hooks for the Next user app.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {
  clearPersistentMoonJsonCache,
  clearPersistentMoonJsonCacheForStatus,
  isPersistentMoonJsonCacheable,
  readPersistentMoonJsonCache,
  writePersistentMoonJsonCache
} from "./persistentJsonCache.js";

/**
 * Perform a same-origin JSON request against Moon.
 *
 * @param {string} url
 * @param {RequestInit & {json?: unknown}} [options]
 * @returns {Promise<{ok: boolean, status: number, payload: any}>}
 */
export const requestJson = async (url, options = {}) => {
  try {
    const {json, ...fetchOptions} = options;
    const response = await fetch(url, {
      ...fetchOptions,
      headers: {
        ...(json == null ? {} : {"Content-Type": "application/json"}),
        ...(options.headers || {})
      },
      body: json == null ? options.body : JSON.stringify(json),
      cache: "no-store"
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {raw: text};
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      payload
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        status: 0,
        payload: {
          aborted: true,
          error: "Moon cancelled this request because a newer one started."
        }
      };
    }
    return {
      ok: false,
      status: 0,
      payload: {
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
};

/**
 * Clear Moon's local auth session cookie.
 *
 * @returns {Promise<{ok: boolean, status: number, payload: any}>}
 */
export const logoutMoonSession = async () => {
  const result = await requestJson("/api/moon/auth/logout", {
    method: "POST"
  });
  await clearPersistentMoonJsonCache();
  return result;
};

/**
 * Fetch a Moon JSON endpoint whenever its dependencies change.
 *
 * @template T
 * @param {string | null} url
 * @param {{enabled?: boolean, fallback?: T, deps?: unknown[], keepPreviousData?: boolean, persistentCache?: false | {userKey?: string, scope?: string}}} [options]
 * @returns {{
 *   loading: boolean,
 *   refreshing: boolean,
 *   error: string,
 *   status: number,
 *   data: T,
 *   refresh: () => Promise<void>,
 *   setData: import("react").Dispatch<import("react").SetStateAction<T>>
 * }}
 */
export const useMoonJson = (url, {enabled = true, fallback = /** @type {T} */ (null), deps = [], keepPreviousData = false, persistentCache = false} = {}) => {
  const [loading, setLoading] = useState(Boolean(enabled && url));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(0);
  const [data, setData] = useState(fallback);
  const fallbackRef = useRef(fallback);
  const controllerRef = useRef(null);
  const requestSeqRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const persistentUserKey = persistentCache && typeof persistentCache === "object"
    ? String(persistentCache.userKey || "")
    : "";
  const persistentScope = persistentCache && typeof persistentCache === "object"
    ? String(persistentCache.scope || "")
    : "";
  const persistentEnabled = Boolean(persistentUserKey && url && isPersistentMoonJsonCacheable(url));
  const persistentUserKeyRef = useRef(persistentUserKey);
  const persistentScopeRef = useRef(persistentScope);
  fallbackRef.current = fallback;
  persistentUserKeyRef.current = persistentUserKey;
  persistentScopeRef.current = persistentScope;

  const resolvePersistentCacheOptions = useCallback(() => {
    const nextUserKey = persistentUserKeyRef.current;
    const nextScope = persistentScopeRef.current;
    return {
      enabled: Boolean(nextUserKey && url && isPersistentMoonJsonCacheable(url)),
      userKey: nextUserKey,
      scope: nextScope
    };
  }, [url]);

  const fetchValue = useCallback(async () => {
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;
    controllerRef.current?.abort?.();
    controllerRef.current = null;

    if (!enabled || !url) {
      setLoading(false);
      setRefreshing(false);
      setError("");
      setStatus(0);
      setData(fallbackRef.current);
      hasLoadedRef.current = false;
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    let loadedPersistentCache = false;
    const initialPersistentCache = resolvePersistentCacheOptions();
    if (initialPersistentCache.enabled) {
      const cachedPayload = await readPersistentMoonJsonCache({
        url,
        userKey: initialPersistentCache.userKey,
        scope: initialPersistentCache.scope
      });
      if (requestSeq !== requestSeqRef.current || controller.signal.aborted) {
        return;
      }
      if (cachedPayload != null) {
        hasLoadedRef.current = true;
        loadedPersistentCache = true;
        setData(cachedPayload);
        setError("");
        setStatus(200);
      }
    }

    const shouldRefresh = loadedPersistentCache || (keepPreviousData && hasLoadedRef.current);
    setLoading(!shouldRefresh);
    setRefreshing(shouldRefresh);
    const result = await requestJson(url, {signal: controller.signal});
    if (requestSeq !== requestSeqRef.current) {
      return;
    }
    if (result.payload?.aborted) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (!result.ok) {
      const failurePersistentCache = resolvePersistentCacheOptions();
      await clearPersistentMoonJsonCacheForStatus(result.status, failurePersistentCache.userKey);
      if (loadedPersistentCache && ![401, 403].includes(result.status)) {
        setStatus(result.status);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      setError(result.payload?.error || "Moon could not finish loading this page.");
      setStatus(result.status);
      if ([401, 403].includes(result.status)) {
        setData(fallbackRef.current);
        hasLoadedRef.current = false;
      }
      setLoading(false);
      setRefreshing(false);
      return;
    }

    hasLoadedRef.current = true;
    setData(result.payload);
    setError("");
    setStatus(result.status);
    setLoading(false);
    setRefreshing(false);
  }, [enabled, keepPreviousData, resolvePersistentCacheOptions, url]);

  useEffect(() => {
    void fetchValue();
    return () => {
      controllerRef.current?.abort?.();
    };
  }, [fetchValue, ...deps]);

  useEffect(() => {
    if (!persistentEnabled || !hasLoadedRef.current) {
      return;
    }
    void writePersistentMoonJsonCache({
      url,
      userKey: persistentUserKey,
      scope: persistentScope,
      payload: data
    });
  }, [data, persistentEnabled, persistentScope, persistentUserKey, url]);

  return {loading, refreshing, error, status, data, refresh: fetchValue, setData};
};

/**
 * Fetch the collapsed Moon chrome bootstrap payload.
 *
 * @returns {Promise<{
 *   branding: any,
 *   auth: any,
 *   bootstrap: any,
 *   loginUrl: string
 * }>}
 */
export const loadMoonChromeContext = async (returnTo = "/") => {
  const trimmedReturnTo = typeof returnTo === "string" ? returnTo.trim() : "";
  const normalizedReturnTo = trimmedReturnTo.startsWith("/")
      && !trimmedReturnTo.startsWith("//")
      && !trimmedReturnTo.startsWith("/api/")
    ? trimmedReturnTo
    : "/";
  const chrome = await requestJson(`/api/moon/chrome/bootstrap?returnTo=${encodeURIComponent(normalizedReturnTo)}`);
  const payload = chrome.ok ? chrome.payload || {} : {};
  const user = payload.user || payload.auth?.user || (payload.auth?.authenticated ? payload.auth : null);

  return {
    branding: payload.branding || {siteName: "Scriptarr"},
    auth: user,
    bootstrap: payload.bootstrap || null,
    loginUrl: ""
  };
};

/**
 * Fetch a Discord OAuth URL only when a signed-out view needs it.
 *
 * @param {string} [returnTo]
 * @returns {Promise<string>}
 */
export const loadMoonLoginUrl = async (returnTo = "/") => {
  const trimmedReturnTo = typeof returnTo === "string" ? returnTo.trim() : "";
  const normalizedReturnTo = trimmedReturnTo.startsWith("/")
      && !trimmedReturnTo.startsWith("//")
      && !trimmedReturnTo.startsWith("/api/")
    ? trimmedReturnTo
    : "/";
  const discordUrl = await requestJson(`/api/moon/auth/discord/url?returnTo=${encodeURIComponent(normalizedReturnTo)}`);
  return discordUrl.ok ? String(discordUrl.payload?.oauthUrl || "").trim() : "";
};

/**
 * Memoize a simple lowercase search key.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const useSearchKey = (value) =>
  useMemo(() => String(value || "").trim().toLowerCase(), [value]);

export default {
  loadMoonChromeContext,
  loadMoonLoginUrl,
  logoutMoonSession,
  requestJson,
  useMoonJson,
  useSearchKey
};
