"use client";

/**
 * @file Client-side Moon API helpers for the dedicated reader app.
 */

import {useCallback, useEffect, useRef, useState} from "react";

/**
 * Perform a same-origin JSON request through Moon.
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
 * Fetch a Moon JSON endpoint whenever dependencies change.
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
      setError(result.payload?.error || "Moon could not finish loading the reader.");
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

const normalizeReturnTo = (returnTo = "/reader") => {
  const trimmed = typeof returnTo === "string" ? returnTo.trim() : "";
  return trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/api/") ? trimmed : "/reader";
};

/**
 * Fetch the collapsed Moon chrome context without mounting user-app chrome.
 *
 * @param {string} [returnTo]
 * @returns {Promise<{branding: any, auth: any, bootstrap: any, loginUrl: string}>}
 */
export const loadMoonChromeContext = async (returnTo = "/reader") => {
  const chrome = await requestJson(`/api/moon/chrome/bootstrap?returnTo=${encodeURIComponent(normalizeReturnTo(returnTo))}`);
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
 * Fetch a Discord OAuth URL only for signed-out reader states.
 *
 * @param {string} [returnTo]
 * @returns {Promise<string>}
 */
export const loadMoonLoginUrl = async (returnTo = "/reader") => {
  const discordUrl = await requestJson(`/api/moon/auth/discord/url?returnTo=${encodeURIComponent(normalizeReturnTo(returnTo))}`);
  return discordUrl.ok ? String(discordUrl.payload?.oauthUrl || "").trim() : "";
};

export default {
  loadMoonChromeContext,
  loadMoonLoginUrl,
  requestJson,
  useMoonJson
};
