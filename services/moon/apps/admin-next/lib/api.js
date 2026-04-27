"use client";

/**
 * @file Client-side same-origin API helpers for Moon's Next admin app.
 */

import {useCallback, useEffect, useRef, useState} from "react";

/**
 * Perform a Moon admin JSON request.
 *
 * @param {string} url
 * @param {RequestInit & {json?: unknown}} [options]
 * @returns {Promise<{ok: boolean, status: number, payload: any}>}
 */
export const requestJson = async (url, options = {}) => {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.json == null ? {} : {"Content-Type": "application/json"}),
        ...(options.headers || {})
      },
      body: options.json == null ? options.body : JSON.stringify(options.json),
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
 * Build the admin chrome bootstrap requests.
 *
 * @param {string} [returnTo]
 * @returns {Promise<{branding: any, user: any, bootstrap: any, loginUrl: string}>}
 */
export const loadAdminChromeContext = async (returnTo = "/admin") => {
  const normalizedReturnTo = typeof returnTo === "string"
      && returnTo.startsWith("/admin")
      && !returnTo.startsWith("//")
    ? returnTo
    : "/admin";
  const [branding, auth, bootstrap, discordUrl] = await Promise.all([
    requestJson("/api/moon/v3/public/branding"),
    requestJson("/api/moon/auth/status"),
    requestJson("/api/moon/auth/bootstrap-status"),
    requestJson(`/api/moon/auth/discord/url?returnTo=${encodeURIComponent(normalizedReturnTo)}`)
  ]);

  return {
    branding: branding.ok ? branding.payload : {siteName: "Scriptarr"},
    user: auth.ok ? auth.payload?.user || auth.payload || null : null,
    bootstrap: bootstrap.ok ? bootstrap.payload : null,
    loginUrl: discordUrl.ok ? String(discordUrl.payload?.oauthUrl || "").trim() : ""
  };
};

/**
 * Fetch a same-origin admin JSON endpoint whenever dependencies change.
 *
 * @template T
 * @param {string | null} url
 * @param {{enabled?: boolean, fallback?: T, deps?: unknown[]}} [options]
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
export const useAdminJson = (url, {enabled = true, fallback = /** @type {T} */ (null), deps = []} = {}) => {
  const [loading, setLoading] = useState(Boolean(enabled && url));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(0);
  const [data, setData] = useState(fallback);
  const fallbackRef = useRef(fallback);
  const hasLoadedRef = useRef(false);
  fallbackRef.current = fallback;

  const refresh = useCallback(async () => {
    if (!enabled || !url) {
      setLoading(false);
      setRefreshing(false);
      setError("");
      setStatus(0);
      setData(fallbackRef.current);
      hasLoadedRef.current = false;
      return;
    }

    const initialLoad = !hasLoadedRef.current;
    if (initialLoad) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    const result = await requestJson(url);
    setStatus(result.status);
    if (!result.ok) {
      setError(initialLoad ? result.payload?.error || "Moon could not finish loading this admin page." : "");
      setLoading(false);
      setRefreshing(false);
      return;
    }

    setData(result.payload);
    setError("");
    hasLoadedRef.current = true;
    setLoading(false);
    setRefreshing(false);
  }, [enabled, url]);

  useEffect(() => {
    void refresh();
  }, [refresh, ...deps]);

  return {loading, refreshing, error, status, data, refresh, setData};
};

/**
 * Subscribe to a Moon admin SSE stream and mark local data stale.
 *
 * @param {{
 *   domains?: string[],
 *   enabled?: boolean,
 *   locked?: boolean,
 *   onStale: () => void,
 *   onRefresh?: () => void
 * }} options
 * @returns {{state: string, stale: boolean, clearStale: () => void}}
 */
export const useAdminEventStaleness = ({domains = [], enabled = true, locked = false, onStale, onRefresh}) => {
  const [state, setState] = useState("connecting");
  const [stale, setStale] = useState(false);
  const onStaleRef = useRef(onStale);
  const onRefreshRef = useRef(onRefresh);
  onStaleRef.current = onStale;
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      setState("idle");
      return undefined;
    }

    const query = domains.map((domain) => `domain=${encodeURIComponent(domain)}`).join("&");
    const stream = new EventSource(`/api/moon/v3/admin/events/stream${query ? `?${query}` : ""}`);
    let poller = 0;

    const markStale = () => {
      setStale(true);
      onStaleRef.current?.();
    };

    stream.addEventListener("open", () => {
      if (poller) {
        clearInterval(poller);
        poller = 0;
      }
      setState("live");
    });
    stream.addEventListener("admin-event", markStale);
    stream.addEventListener("error", () => {
      setState("degraded");
      if (!poller) {
        poller = window.setInterval(markStale, 15000);
      }
    });

    return () => {
      stream.close();
      if (poller) {
        clearInterval(poller);
      }
    };
  }, [enabled, domains.join("|")]);

  useEffect(() => {
    if (!stale || locked) {
      return;
    }
    const timer = window.setTimeout(() => {
      setStale(false);
      onRefreshRef.current?.();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [locked, stale]);

  return {
    state,
    stale,
    clearStale: () => setStale(false)
  };
};
