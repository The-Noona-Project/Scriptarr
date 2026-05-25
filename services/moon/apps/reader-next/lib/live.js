"use client";

/**
 * @file Quiet reader live invalidation helpers.
 */

const READER_LIVE_DOMAINS = Object.freeze(["library", "follow", "reader"]);

const requestLiveTicket = async () => {
  const response = await fetch("/api/moon/live/ticket", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      client: "reader",
      domains: READER_LIVE_DOMAINS
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
 * Start a best-effort reader invalidation socket.
 *
 * @param {{onInvalidate?: (payload: Record<string, unknown>) => void}} options
 * @returns {() => void}
 */
export const startReaderLiveInvalidation = ({onInvalidate} = {}) => {
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
        client: "reader",
        domains: READER_LIVE_DOMAINS,
        latestOnly: true
      }));
    });
    socket.addEventListener("message", (message) => {
      try {
        const payload = JSON.parse(message.data || "{}");
        if (payload.type === "invalidate" && Array.isArray(payload.domains)) {
          onInvalidate?.(payload);
        }
      } catch {
        // Reader live state is best-effort and never blocks page loading.
      }
    });
  }).catch(() => {});
  return () => {
    closed = true;
    socket?.close();
  };
};

export default {
  startReaderLiveInvalidation
};
