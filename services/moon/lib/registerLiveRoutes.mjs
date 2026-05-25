/**
 * @file Same-origin Moon live WebSocket ticketing and Sage bridge routes.
 */
import {createHash, randomBytes} from "node:crypto";
import {WebSocket, WebSocketServer} from "ws";
import {proxyJson, resolveProxyFetchUrl} from "./proxy.mjs";

const LIVE_WS_PATH = "/api/moon/live/ws";
const LIVE_TICKET_PATH = "/api/moon/live/ticket";
const INTERNAL_SAGE_LIVE_PATH = "/api/internal/moon/live/ws";
const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 500;
const MAX_PENDING_PER_IP = 30;
const MAX_CONNECTED_PER_SESSION = 6;
const MAX_INBOUND_BYTES = 16 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const HELLO_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 25_000;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const normalizeDomains = (value) => Array.from(new Set(normalizeArray(value)
  .map((entry) => normalizeString(entry))
  .filter(Boolean)
  .sort()));

const normalizeClient = (value) => {
  const normalized = normalizeString(value, "admin").toLowerCase();
  return ["admin", "user", "reader"].includes(normalized) ? normalized : "admin";
};

const sessionHash = (token) => createHash("sha256").update(normalizeString(token)).digest("hex");

const domainKey = (domains) => normalizeDomains(domains).join("|");

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

const toWebSocketUrl = (url) => {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
};

const sameHost = (left, right) => {
  if (!left || !right) {
    return false;
  }
  try {
    return new URL(left).host.toLowerCase() === new URL(right).host.toLowerCase();
  } catch {
    return false;
  }
};

const isAllowedOrigin = (request, config) => {
  const origin = normalizeString(request.headers.origin);
  const host = normalizeString(request.headers.host);
  if (!origin || !host) {
    return false;
  }
  if (sameHost(origin, `http://${host}`)) {
    return true;
  }
  return Boolean(config.publicBaseUrl && sameHost(origin, config.publicBaseUrl));
};

const clientIpFor = (request) => normalizeString(
  String(request.headers["x-forwarded-for"] || "").split(",")[0],
  request.socket.remoteAddress || "unknown"
);

/**
 * Register Moon live ticket routes and create a WebSocket attach hook.
 *
 * @param {import("express").Express} app
 * @param {{
 *   config: {sageBaseUrl: string, serviceToken: string, publicBaseUrl?: string},
 *   getSessionToken: (request: import("express").Request | import("node:http").IncomingMessage) => string,
 *   logger?: {warn?: Function, info?: Function}
 * }} options
 * @returns {(server: import("node:http").Server) => WebSocketServer}
 */
export const registerLiveRoutes = (app, {config, getSessionToken, logger}) => {
  const tickets = new Map();
  const pendingByIp = new Map();
  const connectedBySession = new Map();

  const pruneTickets = () => {
    const now = Date.now();
    for (const [ticket, entry] of tickets.entries()) {
      if (!entry || entry.expiresAt <= now) {
        tickets.delete(ticket);
      }
    }
    while (tickets.size > MAX_TICKETS) {
      tickets.delete(tickets.keys().next().value);
    }
  };

  const issueTicket = ({client, domains, token}) => {
    pruneTickets();
    const ticket = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + TICKET_TTL_MS;
    tickets.set(ticket, {
      client,
      domains: normalizeDomains(domains),
      domainKey: domainKey(domains),
      sessionHash: sessionHash(token),
      expiresAt
    });
    return {ticket, expiresAt};
  };

  const consumeTicket = ({ticket, token, client, domains}) => {
    pruneTickets();
    const entry = tickets.get(normalizeString(ticket));
    tickets.delete(normalizeString(ticket));
    if (!entry || entry.expiresAt <= Date.now()) {
      return false;
    }
    return entry.sessionHash === sessionHash(token)
      && entry.client === client
      && entry.domainKey === domainKey(domains);
  };

  app.post(LIVE_TICKET_PATH, async (req, res) => {
    const token = getSessionToken(req);
    if (!token) {
      res.status(401).json({error: "Missing session token."});
      return;
    }
    const client = normalizeClient(req.body?.client);
    const domains = normalizeDomains(req.body?.domains);
    const status = await proxyJson({
      baseUrl: config.sageBaseUrl,
      path: "/api/auth/status",
      sessionToken: token,
      signal: AbortSignal.timeout(5000)
    });
    if (!status.status || status.status >= 400) {
      res.status(status.status || 503).json({
        error: status.payload?.error || "Could not validate the current session."
      });
      return;
    }
    const ticket = issueTicket({client, domains, token});
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ticket: ticket.ticket,
      expiresAt: new Date(ticket.expiresAt).toISOString(),
      client,
      domains
    });
  });

  return (server) => {
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_INBOUND_BYTES
    });
    let webSocketServerClosing = false;

    const closeWebSocketServer = () => {
      if (webSocketServerClosing) {
        return;
      }
      webSocketServerClosing = true;
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      pendingByIp.clear();
      connectedBySession.clear();
      try {
        webSocketServer.close();
      } catch {
        // The HTTP server close path can race explicit test/runtime cleanup.
      }
    };

    webSocketServer.once("close", () => {
      webSocketServerClosing = true;
      pendingByIp.clear();
      connectedBySession.clear();
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

    const connectToSage = async () => toWebSocketUrl(await resolveProxyFetchUrl(
      config.sageBaseUrl,
      INTERNAL_SAGE_LIVE_PATH
    ));

    webSocketServer.on("connection", (browserSocket, request) => {
      const ip = clientIpFor(request);
      const token = getSessionToken(request);
      const tokenHash = sessionHash(token);
      let initialized = false;
      let sageSocket = null;
      let alive = true;

      const cleanup = () => {
        decrement(pendingByIp, ip);
        if (initialized) {
          decrement(connectedBySession, tokenHash);
        }
        sageSocket?.close();
      };

      const heartbeat = setInterval(() => {
        if (!alive) {
          browserSocket.terminate();
          return;
        }
        alive = false;
        browserSocket.ping();
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();

      const helloTimer = setTimeout(() => {
        if (!initialized) {
          browserSocket.close(1008, "Live hello timed out.");
        }
      }, HELLO_TIMEOUT_MS);
      helloTimer.unref?.();

      browserSocket.on("pong", () => {
        alive = true;
      });
      browserSocket.once("close", () => {
        clearTimeout(helloTimer);
        clearInterval(heartbeat);
        cleanup();
      });
      browserSocket.on("message", async (message) => {
        if (initialized) {
          const payload = parseJsonMessage(message);
          if (payload?.type === "ping") {
            sendJson(browserSocket, {type: "pong"});
          }
          return;
        }

        const payload = parseJsonMessage(message);
        const client = normalizeClient(payload?.client);
        const domains = normalizeDomains(payload?.domains);
        if (payload?.type !== "hello" || !consumeTicket({
          ticket: payload.ticket,
          token,
          client,
          domains
        })) {
          browserSocket.close(1008, "Invalid live ticket.");
          return;
        }
        initialized = true;
        connectedBySession.set(tokenHash, Number(connectedBySession.get(tokenHash) || 0) + 1);

        try {
          sageSocket = new WebSocket(await connectToSage(), {
            headers: {
              "Authorization": `Bearer ${config.serviceToken}`
            },
            maxPayload: MAX_INBOUND_BYTES
          });
        } catch (error) {
          logger?.warn?.("Moon could not create Sage live socket.", {
            error: error instanceof Error ? error.message : String(error)
          });
          browserSocket.close(1011, "Live broker unavailable.");
          return;
        }

        sageSocket.on("open", () => {
          sageSocket.send(JSON.stringify({
            type: "subscribe",
            sessionToken: token,
            client,
            domains,
            afterSequence: Math.max(0, Number.parseInt(String(payload.afterSequence || 0), 10) || 0),
            latestOnly: payload.latestOnly !== false
          }));
        });
        sageSocket.on("message", (sageMessage) => {
          if (browserSocket.readyState !== WebSocket.OPEN) {
            return;
          }
          if (browserSocket.bufferedAmount > MAX_BUFFERED_BYTES) {
            browserSocket.close(1013, "Live stream is falling behind.");
            return;
          }
          browserSocket.send(Buffer.isBuffer(sageMessage) ? sageMessage.toString("utf8") : String(sageMessage || ""));
        });
        sageSocket.once("close", () => {
          if (browserSocket.readyState === WebSocket.OPEN) {
            browserSocket.close(1011, "Live broker closed.");
          }
        });
        sageSocket.on("error", (error) => {
          logger?.warn?.("Moon Sage live socket failed.", {
            error: error instanceof Error ? error.message : String(error)
          });
          if (browserSocket.readyState === WebSocket.OPEN) {
            browserSocket.close(1011, "Live broker failed.");
          }
        });
      });
    });

    server.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url || "/", "http://moon.local");
      if (requestUrl.pathname !== LIVE_WS_PATH) {
        return;
      }
      if (requestUrl.search) {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      const token = getSessionToken(request);
      if (!token || !isAllowedOrigin(request, config)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      const ip = clientIpFor(request);
      const pending = Number(pendingByIp.get(ip) || 0);
      const connected = Number(connectedBySession.get(sessionHash(token)) || 0);
      if (pending >= MAX_PENDING_PER_IP || connected >= MAX_CONNECTED_PER_SESSION) {
        rejectUpgrade(socket, 429, "Too Many Requests");
        return;
      }
      pendingByIp.set(ip, pending + 1);
      webSocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
        webSocketServer.emit("connection", upgradedSocket, request);
      });
    });

    return webSocketServer;
  };
};

export default registerLiveRoutes;
