"use client";

/**
 * @file Client-side Moon API helpers for the dedicated reader app.
 */

import {useCallback, useEffect, useRef, useState} from "react";
import {readerTelemetryNow, recordReaderTelemetry} from "./readerTelemetry.js";

/**
 * Perform a same-origin JSON request through Moon.
 *
 * @param {string} url
 * @param {RequestInit & {json?: unknown, telemetry?: Record<string, unknown>}} [options]
 * @returns {Promise<{ok: boolean, status: number, payload: any}>}
 */
export const requestJson = async (url, options = {}) => {
  const startedAt = readerTelemetryNow();
  const telemetry = options.telemetry || null;
  try {
    const {json, telemetry: _telemetry, ...fetchOptions} = options;
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

    const result = {
      ok: response.ok,
      status: response.status,
      payload
    };
    if (telemetry) {
      recordReaderTelemetry({
        ...telemetry,
        ok: result.ok,
        status: result.status,
        durationMs: readerTelemetryNow() - startedAt
      });
    }
    return result;
  } catch (error) {
    if (telemetry) {
      recordReaderTelemetry({
        ...telemetry,
        ok: false,
        status: 0,
        durationMs: readerTelemetryNow() - startedAt,
        reason: error instanceof Error ? error.name || error.message : "request_error"
      });
    }
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        status: 0,
        payload: {
          aborted: true,
          error: "This reader request was cancelled because a newer one started."
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
 * Fetch a Moon JSON endpoint whenever dependencies change.
 *
 * @template T
 * @param {string | null} url
 * @param {{enabled?: boolean, fallback?: T, deps?: unknown[], keepPreviousData?: boolean, telemetry?: Record<string, unknown>}} [options]
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
export const useMoonJson = (url, {enabled = true, fallback = /** @type {T} */ (null), deps = [], keepPreviousData = false, telemetry = null} = {}) => {
  const [loading, setLoading] = useState(Boolean(enabled && url));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(0);
  const [data, setData] = useState(fallback);
  const fallbackRef = useRef(fallback);
  const telemetryRef = useRef(telemetry);
  const controllerRef = useRef(null);
  const requestSeqRef = useRef(0);
  const hasLoadedRef = useRef(false);
  fallbackRef.current = fallback;
  telemetryRef.current = telemetry;

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
    const shouldRefresh = keepPreviousData && hasLoadedRef.current;
    setLoading(!shouldRefresh);
    setRefreshing(shouldRefresh);
    const result = await requestJson(url, {signal: controller.signal, telemetry: telemetryRef.current});
    if (requestSeq !== requestSeqRef.current) {
      return;
    }
    if (result.payload?.aborted) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (!result.ok) {
      setError(result.payload?.error || "Scriptarr could not finish loading the reader.");
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
  }, [enabled, keepPreviousData, url]);

  useEffect(() => {
    void fetchValue();
    return () => {
      controllerRef.current?.abort?.();
    };
  }, [fetchValue, ...deps]);

  return {loading, refreshing, error, status, data, refresh: fetchValue, setData};
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
