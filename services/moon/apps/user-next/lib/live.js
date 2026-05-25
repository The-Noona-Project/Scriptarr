"use client";

/**
 * @file Quiet Moon user-surface live invalidation helpers.
 */

export const LIVE_INVALIDATE_EVENT = "scriptarr:live-invalidate";

const USER_LIVE_DOMAINS = Object.freeze(["library", "requests", "follow", "reader"]);

const requestLiveTicket = async () => {
  const response = await fetch("/api/moon/live/ticket", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      client: "user",
      domains: USER_LIVE_DOMAINS
    }),
    cache: "no-store"
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
};

const liveSocketUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/moon/live/ws`;
};

/**
 * Check if one Moon JSON URL should refresh for a live invalidation.
 *
 * @param {string | null} url
 * @param {string[]} domains
 * @returns {boolean}
 */
export const shouldRefreshUrlForLiveDomains = (url, domains = []) => {
  const target = String(url || "");
  const domainSet = new Set(domains);
  if (!target) {
    return false;
  }
  if (domainSet.has("library") && /\/api\/moon-v3\/user\/(home|library|title)\b/.test(target)) {
    return true;
  }
  if (domainSet.has("requests") && /\/api\/moon-v3\/user\/(home|profile|requests|title\/[^/]+\/requests)\b/.test(target)) {
    return true;
  }
  if (domainSet.has("follow") && /\/api\/moon-v3\/user\/(home|profile|following|title)\b/.test(target)) {
    return true;
  }
  return domainSet.has("reader") && /\/api\/moon-v3\/user\/(home|profile|title|reader)\b/.test(target);
};

/**
 * Start a best-effort user live invalidation socket.
 *
 * @returns {() => void}
 */
export const startUserLiveInvalidation = () => {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") {
    return () => {};
  }
  let socket = null;
  let closed = false;
  void requestLiveTicket().then((ticket) => {
    if (closed || !ticket?.ticket) {
      return;
    }
    socket = new WebSocket(liveSocketUrl());
    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify({
        type: "hello",
        ticket: ticket.ticket,
        client: "user",
        domains: USER_LIVE_DOMAINS,
        latestOnly: true
      }));
    });
    socket.addEventListener("message", (message) => {
      try {
        const payload = JSON.parse(message.data || "{}");
        if (payload.type === "invalidate" && Array.isArray(payload.domains)) {
          window.dispatchEvent(new CustomEvent(LIVE_INVALIDATE_EVENT, {detail: payload}));
        }
      } catch {
        // Live invalidation is best-effort and must not disrupt navigation.
      }
    });
  }).catch(() => {});
  return () => {
    closed = true;
    socket?.close();
  };
};

export default {
  LIVE_INVALIDATE_EVENT,
  shouldRefreshUrlForLiveDomains,
  startUserLiveInvalidation
};
