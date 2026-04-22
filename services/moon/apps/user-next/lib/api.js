"use client";

/**
 * @file Client-side Moon API helpers and hooks for the Next user app.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from "react";

/**
 * Perform a same-origin JSON request against Moon.
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
 * Clear Moon's local auth session cookie.
 *
 * @returns {Promise<{ok: boolean, status: number, payload: any}>}
 */
export const logoutMoonSession = () => requestJson("/api/moon/auth/logout", {
  method: "POST"
});

/**
 * Fetch a Moon JSON endpoint whenever its dependencies change.
 *
 * @template T
 * @param {string | null} url
 * @param {{enabled?: boolean, fallback?: T, deps?: unknown[]}} [options]
 * @returns {{
 *   loading: boolean,
 *   error: string,
 *   status: number,
 *   data: T,
 *   refresh: () => Promise<void>,
 *   setData: import("react").Dispatch<import("react").SetStateAction<T>>
 * }}
 */
export const useMoonJson = (url, {enabled = true, fallback = /** @type {T} */ (null), deps = []} = {}) => {
  const [loading, setLoading] = useState(Boolean(enabled && url));
  const [error, setError] = useState("");
  const [status, setStatus] = useState(0);
  const [data, setData] = useState(fallback);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  const fetchValue = useCallback(async () => {
    if (!enabled || !url) {
      setLoading(false);
      setError("");
      setStatus(0);
      setData(fallbackRef.current);
      return;
    }

    setLoading(true);
    const result = await requestJson(url);
    if (!result.ok) {
      setError(result.payload?.error || "Moon could not finish loading this page.");
      setStatus(result.status);
      setLoading(false);
      return;
    }

    setData(result.payload);
    setError("");
    setStatus(result.status);
    setLoading(false);
  }, [enabled, url]);

  useEffect(() => {
    void fetchValue();
  }, [fetchValue, ...deps]);

  return {loading, error, status, data, refresh: fetchValue, setData};
};

/**
 * Build the static Moon chrome bootstrap requests.
 *
 * @returns {Promise<{
 *   branding: any,
 *   auth: any,
 *   bootstrap: any,
 *   loginUrl: string
 * }>}
 */
export const loadMoonChromeContext = async () => {
  const [branding, auth, bootstrap, discordUrl] = await Promise.all([
    requestJson("/api/moon/v3/public/branding"),
    requestJson("/api/moon/auth/status"),
    requestJson("/api/moon/auth/bootstrap-status"),
    requestJson("/api/moon/auth/discord/url")
  ]);

  return {
    branding: branding.ok ? branding.payload : {siteName: "Scriptarr"},
    auth: auth.ok ? auth.payload?.user || auth.payload || null : null,
    bootstrap: bootstrap.ok ? bootstrap.payload : null,
    loginUrl: discordUrl.ok ? String(discordUrl.payload?.oauthUrl || "").trim() : ""
  };
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
  logoutMoonSession,
  requestJson,
  useMoonJson,
  useSearchKey
};
