"use client";

/**
 * @file Client-side same-origin API helpers for Moon's Next admin app.
 */

import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";
import {beginGlobalLoadingActivity} from "./loadingActivity.js";

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
 * Normalize an admin return path for Moon auth routes.
 *
 * @param {string} [returnTo]
 * @returns {string}
 */
export const normalizeAdminReturnTo = (returnTo = "/admin") => {
  const trimmedReturnTo = typeof returnTo === "string" ? returnTo.trim() : "";
  if (!trimmedReturnTo || /[\\\u0000-\u001f\u007f]/.test(trimmedReturnTo)) {
    return "/admin";
  }
  let decoded = "";
  try {
    decoded = decodeURIComponent(trimmedReturnTo);
  } catch {
    return "/admin";
  }
  if (!decoded.startsWith("/admin") || decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded)) {
    return "/admin";
  }
  try {
    const parsed = new URL(decoded, "https://moon.local");
    return parsed.origin === "https://moon.local" && parsed.pathname.startsWith("/admin")
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/admin";
  } catch {
    return "/admin";
  }
};

/**
 * Build the local Moon route that starts Discord OAuth for admin pages.
 *
 * @param {string} [returnTo]
 * @returns {string}
 */
export const buildAdminLoginHref = (returnTo = "/admin") =>
  `/login?returnTo=${encodeURIComponent(normalizeAdminReturnTo(returnTo))}`;

/**
 * Fetch the collapsed admin chrome bootstrap payload.
 *
 * @param {string} [returnTo]
 * @returns {Promise<{branding: any, user: any, bootstrap: any, authError: string, bootstrapError: string, loginUrl: string}>}
 */
export const loadAdminChromeContext = async (returnTo = "/admin") => {
  const normalizedReturnTo = normalizeAdminReturnTo(returnTo);
  const chrome = await requestJson(`/api/moon/chrome/bootstrap?returnTo=${encodeURIComponent(normalizedReturnTo)}`);
  const payload = chrome.ok ? chrome.payload || {} : {};
  const user = payload.user || payload.auth?.user || (payload.auth?.authenticated ? payload.auth : null);

  return {
    branding: payload.branding || {siteName: "Scriptarr"},
    user,
    bootstrap: payload.bootstrap || null,
    authError: payload.errors?.auth || "",
    bootstrapError: payload.errors?.bootstrap || "",
    loginUrl: user ? "" : buildAdminLoginHref(normalizedReturnTo)
  };
};

/**
 * Resolve the same-origin Moon route that starts Discord OAuth.
 *
 * @param {string} [returnTo]
 * @returns {Promise<string>}
 */
export const loadAdminLoginUrl = async (returnTo = "/admin") => {
  return buildAdminLoginHref(returnTo);
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
 *   lastLoadedAt: string,
 *   lastRefreshError: string,
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
  const [lastLoadedAt, setLastLoadedAt] = useState("");
  const [lastRefreshError, setLastRefreshError] = useState("");
  const fallbackRef = useRef(fallback);
  const hasLoadedRef = useRef(false);
  const controllerRef = useRef(null);
  const requestIdRef = useRef(0);
  fallbackRef.current = fallback;

  const refresh = useCallback(async () => {
    const abortCurrent = () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };

    if (!enabled || !url) {
      requestIdRef.current += 1;
      abortCurrent();
      setLoading(false);
      setRefreshing(false);
      setError("");
      setStatus(0);
      setData(fallbackRef.current);
      setLastLoadedAt("");
      setLastRefreshError("");
      hasLoadedRef.current = false;
      return;
    }

    const initialLoad = !hasLoadedRef.current;
    if (!initialLoad && controllerRef.current) {
      return;
    }
    if (initialLoad) {
      setLoading(true);
      abortCurrent();
    } else {
      setRefreshing(true);
    }

    const controller = new AbortController();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    controllerRef.current = controller;
    const endLoadingActivity = initialLoad ? beginGlobalLoadingActivity("Loading admin data.") : () => {};

    const isCurrentRequest = () =>
      requestIdRef.current === requestId
      && controllerRef.current === controller
      && !controller.signal.aborted;

    try {
      const result = await requestJson(url, {signal: controller.signal});
      if (!isCurrentRequest()) {
        return;
      }

      controllerRef.current = null;
      setStatus(result.status);
      if (!result.ok) {
        setError(initialLoad ? result.payload?.error || "Moon could not finish loading this admin page." : "");
        setLastRefreshError(initialLoad ? "" : result.payload?.error || "Moon could not refresh this admin page.");
        setLoading(false);
        setRefreshing(false);
        return;
      }

      setData(result.payload);
      setError("");
      setLastRefreshError("");
      setLastLoadedAt(new Date().toISOString());
      hasLoadedRef.current = true;
      setLoading(false);
      setRefreshing(false);
    } finally {
      endLoadingActivity();
    }
  }, [enabled, url]);

  useEffect(() => {
    void refresh();
  }, [refresh, ...deps]);

  useEffect(() => () => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  return {loading, refreshing, error, status, data, lastLoadedAt, lastRefreshError, refresh, setData};
};

const AdminEventStreamContext = createContext(null);

const normalizeDomains = (domains) => Array.isArray(domains)
  ? Array.from(new Set(domains.map((domain) => String(domain || "").trim()).filter(Boolean))).sort()
  : [];

const sequenceFromEvent = (event) => Number.parseInt(String(event?.sequence || 0), 10) || 0;

const openLiveSocketUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/moon/live/ws`;
};

const requestLiveTicket = async ({client, domains}) => requestJson("/api/moon/live/ticket", {
  method: "POST",
  json: {client, domains}
});

/**
 * Provide one shared Moon admin event stream for all admin page subscribers.
 *
 * @param {{children: import("react").ReactNode, user: any}} props
 * @returns {import("react").ReactNode}
 */
export const AdminEventStreamProvider = ({children, user}) => {
  const subscribers = useRef(new Map());
  const [version, setVersion] = useState(0);
  const [state, setState] = useState("idle");

  const register = useCallback((subscription) => {
    const id = Symbol("admin-event-subscriber");
    subscribers.current.set(id, {
      domains: normalizeDomains(subscription?.domains),
      onEvent: subscription?.onEvent
    });
    setVersion((current) => current + 1);
    return () => {
      subscribers.current.delete(id);
      setVersion((current) => current + 1);
    };
  }, []);

  const domainKey = useMemo(() => {
    const allDomains = new Set();
    let includesAllDomains = false;
    for (const subscription of subscribers.current.values()) {
      if (!subscription.domains.length) {
        includesAllDomains = true;
        break;
      }
      subscription.domains.forEach((domain) => allDomains.add(domain));
    }
    return includesAllDomains ? "*" : Array.from(allDomains).sort().join("|");
  }, [version]);

  useEffect(() => {
    if (!user || !subscribers.current.size) {
      setState("idle");
      return undefined;
    }

    let cancelled = false;
    let socket = null;
    let stream = null;
    let poller = 0;
    let fallbackStarted = false;
    const domains = domainKey === "*"
      ? []
      : domainKey.split("|").map((domain) => domain.trim()).filter(Boolean);
    const domainParams = domains.map((domain) => `domain=${encodeURIComponent(domain)}`);

    const notifySubscribers = (event) => {
      const eventDomain = String(event?.domain || "").trim();
      for (const subscription of subscribers.current.values()) {
        if (!subscription.domains.length || !eventDomain || subscription.domains.includes(eventDomain)) {
          subscription.onEvent?.(event);
        }
      }
    };

    const markAllSubscribersStale = () => {
      notifySubscribers({domain: "", eventType: "stream-degraded"});
    };

    const startPollingFallback = () => {
      setState("degraded");
      markAllSubscribersStale();
      if (!poller) {
        poller = window.setInterval(markAllSubscribersStale, 15000);
      }
    };

    const openSseStream = async () => {
      if (typeof EventSource === "undefined") {
        startPollingFallback();
        return;
      }
      setState("connecting");
      let afterSequence = 0;
      const controller = new AbortController();
      const preflightTimeout = window.setTimeout(() => controller.abort(), 2000);
      const latest = await requestJson(`/api/moon/v3/admin/events?${[...domainParams, "limit=1", "newestFirst=true"].join("&")}`, {
        signal: controller.signal
      });
      window.clearTimeout(preflightTimeout);
      if (cancelled) {
        return;
      }
      if (latest.ok) {
        afterSequence = sequenceFromEvent(latest.payload?.events?.[0]);
      } else {
        startPollingFallback();
      }
      const query = [
        ...domainParams,
        ...(afterSequence ? [`afterSequence=${encodeURIComponent(String(afterSequence))}`] : [])
      ].join("&");
      stream = new EventSource(`/api/moon/v3/admin/events/stream${query ? `?${query}` : ""}`);
      stream.addEventListener("open", () => {
        if (poller) {
          window.clearInterval(poller);
          poller = 0;
        }
        setState("live");
      });
      stream.addEventListener("admin-event", (message) => {
        try {
          notifySubscribers(JSON.parse(message.data || "{}"));
        } catch {
          markAllSubscribersStale();
        }
      });
      stream.addEventListener("error", () => {
        startPollingFallback();
      });
    };

    const startFallback = () => {
      if (cancelled || fallbackStarted) {
        return;
      }
      fallbackStarted = true;
      void openSseStream().catch(() => startPollingFallback());
    };

    const openWebSocket = async () => {
      if (typeof WebSocket === "undefined") {
        startFallback();
        return;
      }
      setState("connecting");
      const ticket = await requestLiveTicket({client: "admin", domains});
      if (!ticket.ok || !ticket.payload?.ticket || cancelled) {
        startFallback();
        return;
      }
      socket = new WebSocket(openLiveSocketUrl());
      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({
          type: "hello",
          ticket: ticket.payload.ticket,
          client: "admin",
          domains,
          latestOnly: true
        }));
      });
      socket.addEventListener("message", (message) => {
        try {
          const payload = JSON.parse(message.data || "{}");
          if (payload.type === "ready") {
            if (poller) {
              window.clearInterval(poller);
              poller = 0;
            }
            setState("live");
            return;
          }
          if (payload.type === "event") {
            notifySubscribers(payload.event);
            return;
          }
          if (payload.type === "invalidate" || payload.type === "resync-required") {
            markAllSubscribersStale();
          }
        } catch {
          markAllSubscribersStale();
        }
      });
      socket.addEventListener("error", startFallback);
      socket.addEventListener("close", startFallback);
    };

    void openWebSocket().catch(startFallback);

    return () => {
      cancelled = true;
      socket?.close();
      stream?.close();
      if (poller) {
        window.clearInterval(poller);
      }
    };
  }, [domainKey, user]);

  const value = useMemo(() => ({register, state}), [register, state]);

  return (
    <AdminEventStreamContext.Provider value={value}>
      {children}
    </AdminEventStreamContext.Provider>
  );
};

/**
 * Subscribe to the shared Moon admin event stream.
 *
 * @param {{domains?: string[], enabled?: boolean, onEvent: (event: any) => void}} options
 * @returns {{state: string}}
 */
export const useAdminEventSubscription = ({domains = [], enabled = true, onEvent}) => {
  const stream = useContext(AdminEventStreamContext);
  const onEventRef = useRef(onEvent);
  const domainsKey = normalizeDomains(domains).join("|");
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || !stream) {
      return undefined;
    }
    return stream.register({
      domains,
      onEvent: (event) => onEventRef.current?.(event)
    });
  }, [domainsKey, enabled, stream?.register]);

  return {
    state: enabled ? stream?.state || "idle" : "idle"
  };
};

/**
 * Subscribe to shared Moon admin events and mark local data stale.
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
  const [stale, setStale] = useState(false);
  const onStaleRef = useRef(onStale);
  const onRefreshRef = useRef(onRefresh);
  onStaleRef.current = onStale;
  onRefreshRef.current = onRefresh;

  const subscription = useAdminEventSubscription({
    domains,
    enabled,
    onEvent: () => {
      setStale(true);
      onStaleRef.current?.();
    }
  });

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
    state: subscription.state,
    stale,
    clearStale: () => setStale(false)
  };
};
