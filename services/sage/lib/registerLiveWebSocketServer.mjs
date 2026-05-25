/**
 * @file Internal Moon-to-Sage WebSocket bridge for live event invalidation.
 */
import {createHash} from "node:crypto";
import {WebSocket, WebSocketServer} from "ws";
import {eventSequence} from "./liveEventHub.mjs";
import {resolveReadableEventDomains} from "./eventAccess.mjs";
import {sanitizeAdminEvent} from "./liveEventPayloads.mjs";

const LIVE_WS_PATH = "/api/internal/moon/live/ws";
const MAX_INBOUND_BYTES = 16 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_REPLAY_EVENTS = 500;
const MAX_ACTIVE_PER_REMOTE = 100;
const MAX_ACTIVE_PER_SESSION = 20;
const HEARTBEAT_INTERVAL_MS = 25_000;
const REVALIDATE_INTERVAL_MS = 60_000;
const PUBLIC_USER_DOMAINS = Object.freeze(["library", "requests", "follow", "reader"]);
const PUBLIC_READER_DOMAINS = Object.freeze(["library", "follow", "reader"]);

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const sessionHash = (token) => createHash("sha256").update(normalizeString(token)).digest("hex");
const remoteKeyFor = (request) => normalizeString(request.socket.remoteAddress, "unknown");

const normalizeDomains = (value) => Array.from(new Set(normalizeArray(value)
  .map((entry) => normalizeString(entry))
  .filter(Boolean)));

const normalizeClient = (value) => {
  const normalized = normalizeString(value, "admin").toLowerCase();
  return ["admin", "user", "reader"].includes(normalized) ? normalized : "admin";
};

const getBearerToken = (header) => {
  if (!header) {
    return "";
  }
  const [scheme, token] = String(header).split(" ");
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
};

const resolveServiceName = (config, authorization) => {
  const token = getBearerToken(authorization);
  return Object.entries(config.serviceTokens || {}).find(([, expected]) => expected && expected === token)?.[0] || "";
};

const rejectUpgrade = (socket, statusCode = 401, message = "Unauthorized") => {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

const parseJsonMessage = (message) => {
  try {
    return JSON.parse(Buffer.isBuffer(message) ? message.toString("utf8") : String(message || ""));
  } catch {
    return null;
  }
};

const sendJson = (socket, payload) => {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.close(1013, "Live stream is falling behind.");
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
};

const eventMentionsUser = (event, user) => {
  const userId = normalizeString(user?.discordUserId);
  if (!userId) {
    return false;
  }
  if ([event.actorId, event.targetId].some((value) => normalizeString(value) === userId)) {
    return true;
  }
  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
  return [
    metadata.discordUserId,
    metadata.userDiscordUserId,
    metadata.requestedByDiscordUserId,
    metadata.requesterDiscordUserId,
    metadata.userId
  ].some((value) => normalizeString(value) === userId);
};

const canSendPublicInvalidation = (event, user) => {
  const domain = normalizeString(event?.domain);
  const eventType = normalizeString(event?.eventType);
  if (domain === "library") {
    return true;
  }
  if (domain === "reader" && eventType === "reader-performance-slow") {
    return false;
  }
  return ["requests", "follow", "reader"].includes(domain) && eventMentionsUser(event, user);
};

const resolveLiveDomains = (user, client, requestedDomains) => {
  if (client === "admin") {
    return resolveReadableEventDomains(user, requestedDomains);
  }
  const allowed = client === "reader" ? PUBLIC_READER_DOMAINS : PUBLIC_USER_DOMAINS;
  const requested = normalizeDomains(requestedDomains);
  if (!requested.length) {
    return [...allowed];
  }
  return requested.every((domain) => allowed.includes(domain)) ? requested : null;
};

const toOutboundLiveMessage = ({client, event, user}) => {
  if (client === "admin") {
    return {
      type: "event",
      event: sanitizeAdminEvent(event)
    };
  }
  if (!canSendPublicInvalidation(event, user)) {
    return null;
  }
  return {
    type: "invalidate",
    sequence: eventSequence(event),
    domains: [normalizeString(event.domain)],
    reason: "event"
  };
};

/**
 * Attach Sage's internal live WebSocket upgrade route to the HTTP server.
 *
 * @param {import("node:http").Server} server
 * @param {{
 *   config: {serviceTokens?: Record<string, string>},
 *   vaultClient: {getSessionUser: Function, listEvents: Function},
 *   liveEventHub: ReturnType<import("./liveEventHub.mjs").createLiveEventHub>,
 *   logger?: {warn?: Function, info?: Function}
 * }} options
 * @returns {WebSocketServer}
 */
export const registerSageLiveWebSocketServer = (server, {config, vaultClient, liveEventHub, logger}) => {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INBOUND_BYTES
  });
  const activeByRemote = new Map();
  const activeBySession = new Map();
  let webSocketServerClosing = false;

  const closeWebSocketServer = () => {
    if (webSocketServerClosing) {
      return;
    }
    webSocketServerClosing = true;
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    activeByRemote.clear();
    activeBySession.clear();
    try {
      webSocketServer.close();
    } catch {
      // The HTTP server close path can race explicit test/runtime cleanup.
    }
  };

  webSocketServer.once("close", () => {
    webSocketServerClosing = true;
    activeByRemote.clear();
    activeBySession.clear();
  });
  server.once("close", closeWebSocketServer);

  const decrement = (map, key) => {
    const next = Math.max(0, Number(map.get(key) || 0) - 1);
    if (next) {
      map.set(key, next);
    } else {
      map.delete(key);
    }
  };

  const handleConnection = (socket, request) => {
    const remoteKey = remoteKeyFor(request);
    let initialized = false;
    let closed = false;
    let liveUser = null;
    let liveClient = "admin";
    let liveDomains = [];
    let liveCursor = 0;
    let sessionToken = "";
    let liveSessionHash = "";
    let unsubscribe = null;
    let alive = true;

    const cleanup = () => {
      closed = true;
      decrement(activeByRemote, remoteKey);
      if (liveSessionHash) {
        decrement(activeBySession, liveSessionHash);
      }
      unsubscribe?.();
      unsubscribe = null;
    };

    const revalidate = async () => {
      const nextUser = await vaultClient.getSessionUser(sessionToken);
      if (!nextUser) {
        socket.close(4003, "Session expired.");
        return false;
      }
      const nextDomains = resolveLiveDomains(nextUser, liveClient, liveDomains);
      if (!nextDomains || !nextDomains.length) {
        socket.close(4003, "Live access revoked.");
        return false;
      }
      liveUser = nextUser;
      liveDomains = nextDomains;
      return true;
    };

    const sendEvent = async (event) => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const sequence = eventSequence(event);
      const domain = normalizeString(event.domain);
      if (!sequence || sequence <= liveCursor) {
        return;
      }
      if (["auth", "users", "access"].includes(domain) && !(await revalidate())) {
        return;
      }
      if (!liveDomains.includes(domain)) {
        return;
      }
      const outbound = toOutboundLiveMessage({client: liveClient, event, user: liveUser});
      liveCursor = Math.max(liveCursor, sequence);
      if (outbound) {
        sendJson(socket, outbound);
      }
    };

    const sendReplay = async (afterSequence) => {
      const events = normalizeArray(await vaultClient.listEvents({
        domains: liveDomains,
        afterSequence,
        limit: MAX_REPLAY_EVENTS,
        newestFirst: false
      }));
      for (const event of events) {
        await sendEvent(event);
      }
      if (events.length >= MAX_REPLAY_EVENTS) {
        sendJson(socket, {
          type: "resync-required",
          reason: "replay-limit",
          sequence: liveCursor
        });
      }
    };

    const initialize = async (message) => {
      const payload = parseJsonMessage(message);
      if (payload?.type !== "subscribe") {
        socket.close(1008, "Live subscription required.");
        return;
      }
      sessionToken = normalizeString(payload.sessionToken);
      liveSessionHash = sessionHash(sessionToken);
      const activeForSession = Number(activeBySession.get(liveSessionHash) || 0);
      if (activeForSession >= MAX_ACTIVE_PER_SESSION) {
        socket.close(1013, "Too many live subscriptions.");
        return;
      }
      activeBySession.set(liveSessionHash, activeForSession + 1);
      liveClient = normalizeClient(payload.client);
      liveUser = sessionToken ? await vaultClient.getSessionUser(sessionToken) : null;
      if (!liveUser) {
        socket.close(4003, "Session required.");
        return;
      }
      const requestedDomains = normalizeDomains(payload.domains);
      liveDomains = resolveLiveDomains(liveUser, liveClient, requestedDomains) || [];
      if (!liveDomains.length) {
        socket.close(4003, "Live access denied.");
        return;
      }

      initialized = true;
      const afterSequence = Math.max(0, Number.parseInt(String(payload.afterSequence || 0), 10) || 0);
      if (afterSequence > 0) {
        liveCursor = afterSequence;
      } else {
        const latest = normalizeArray(await vaultClient.listEvents({
          domains: liveDomains,
          limit: 1,
          newestFirst: true
        }));
        liveCursor = eventSequence(latest[0]);
      }
      unsubscribe = liveEventHub.subscribe((event) => {
        void sendEvent(event).catch((error) => {
          logger?.warn?.("Sage live event send failed.", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      });
      sendJson(socket, {
        type: "ready",
        transport: "websocket",
        client: liveClient,
        domains: liveDomains,
        sequence: liveCursor
      });
      if (afterSequence > 0) {
        await sendReplay(afterSequence);
      }
    };

    const pendingTimer = setTimeout(() => {
      if (!initialized) {
        socket.close(1008, "Live subscription timed out.");
      }
    }, 3000);
    pendingTimer.unref?.();

    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    const revalidator = setInterval(() => {
      if (initialized) {
        void revalidate().catch(() => socket.close(4003, "Session check failed."));
      }
    }, REVALIDATE_INTERVAL_MS);
    revalidator.unref?.();

    socket.on("pong", () => {
      alive = true;
    });
    socket.once("close", () => {
      clearTimeout(pendingTimer);
      clearInterval(heartbeat);
      clearInterval(revalidator);
      cleanup();
    });
    socket.on("message", (message) => {
      if (!initialized) {
        void initialize(message).catch((error) => {
          logger?.warn?.("Sage live subscription failed.", {
            error: error instanceof Error ? error.message : String(error)
          });
          socket.close(1011, "Live subscription failed.");
        });
        return;
      }
      const payload = parseJsonMessage(message);
      if (payload?.type === "ping") {
        sendJson(socket, {type: "pong"});
      }
    });
  };

  webSocketServer.on("connection", handleConnection);
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url || "/", "http://sage.local");
    if (requestUrl.pathname !== LIVE_WS_PATH) {
      return;
    }
    if (requestUrl.search) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (resolveServiceName(config, request.headers.authorization) !== "scriptarr-moon") {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    const remoteKey = remoteKeyFor(request);
    const activeForRemote = Number(activeByRemote.get(remoteKey) || 0);
    if (activeForRemote >= MAX_ACTIVE_PER_REMOTE) {
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    activeByRemote.set(remoteKey, activeForRemote + 1);
    webSocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      webSocketServer.emit("connection", upgradedSocket, request);
    });
  });

  return webSocketServer;
};

export default registerSageLiveWebSocketServer;
