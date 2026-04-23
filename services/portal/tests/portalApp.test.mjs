import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.NODE_ENV = "test";

const {createPortalApp} = await import("../lib/createPortalApp.mjs");
const {createFollowNotifier} = await import("../lib/followNotifier.mjs");

const withPortalEnv = async (overrides, handler) => {
  const keys = [
    "SCRIPTARR_SAGE_BASE_URL",
    "SCRIPTARR_SERVICE_TOKEN",
    "SCRIPTARR_PORTAL_SERVICE_TOKEN",
    "SCRIPTARR_PUBLIC_BASE_URL",
    "DISCORD_TOKEN",
    "SCRIPTARR_DISCORD_TOKEN",
    "SCRIPTARR_DISCORD_CLIENT_ID",
    "SCRIPTARR_DISCORD_GUILD_ID",
    "SCRIPTARR_DISCORD_SUPERUSER_ID",
    "SCRIPTARR_ONBOARDING_TEMPLATE"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) {
    if (Object.hasOwn(overrides, key)) {
      process.env[key] = overrides[key];
    } else {
      delete process.env[key];
    }
  }

  try {
    await handler();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const createJsonServer = async (routes) => {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : null;
    hits.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body
    });

    const key = `${req.method} ${url.pathname}`;
    const route = routes[key];
    if (!route) {
      res.writeHead(404, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: `No route for ${key}`}));
      return;
    }

    const result = await route({req, url, body, hits});
    res.writeHead(result.status || 200, {"Content-Type": "application/json"});
    res.end(JSON.stringify(result.body ?? null));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => error ? reject(error) : resolve());
    })
  };
};

const createPortalServer = async (options = {}) => {
  const built = await createPortalApp(options);
  const server = built.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    runtime: built.runtime,
    close: async () => {
      await built.runtime.stop();
      await new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
};

test("portal HTTP surface covers command inventory, request routing, chat routing, and onboarding helpers", async () => {
  await withPortalEnv({}, async () => {
    const portal = await createPortalServer();
    try {
      const runtime = await fetch(`${portal.baseUrl}/api/runtime`).then((response) => response.json());
      assert.equal(runtime.mode, "disabled");
      assert.equal(runtime.connected, false);
      assert.deepEqual(
        runtime.commands.map((command) => command.name),
        ["ding", "status", "chat", "search", "request", "subscribe", "downloadall"]
      );
    } finally {
      await portal.close();
    }
  });

  const richSage = await createJsonServer({
    "GET /api/internal/portal/discord/settings": async () => ({
      body: {
        guildId: "guild-1",
        superuserId: "owner-1",
        onboarding: {
          channelId: "channel-1",
          template: "Welcome to Scriptarr, {username}."
        },
        commands: {
          request: {enabled: true, roleId: "role-request"}
        }
      }
    }),
    "POST /api/internal/vault/users/upsert-discord": async ({body}) => ({body}),
    "POST /api/internal/portal/requests/from-discord": async ({req, body}) => {
      assert.equal(req.headers.authorization, "Bearer portal-service-token");
      assert.equal(body.discordUserId, "253987219969146890");
      assert.equal(body.title, "Dandadan");
      assert.equal(body.selectedMetadata.providerSeriesId, "md-1");
      assert.equal(body.selectedDownload, undefined);
      return {
        status: 201,
        body: {
          id: "req_123",
          title: "Dandadan",
          status: "pending"
        }
      };
    },
    "POST /api/internal/oracle/chat": async ({req, body}) => {
      assert.equal(req.headers.authorization, "Bearer portal-service-token");
      assert.deepEqual(body, {message: "how is scriptarr doing?"});
      return {
        body: {
          ok: true,
          reply: "Noona says the stack looks healthy."
        }
      };
    }
  });

  await withPortalEnv({
    SCRIPTARR_SAGE_BASE_URL: richSage.baseUrl,
    SCRIPTARR_SERVICE_TOKEN: "portal-service-token",
    SCRIPTARR_PUBLIC_BASE_URL: "https://pax-kun.com"
  }, async () => {
    const portal = await createPortalServer();
    try {
      const commands = await fetch(`${portal.baseUrl}/api/commands`).then((response) => response.json());
      assert.equal(commands.discord.mode, "disabled");
      assert.ok(commands.commands.some((command) => command.name === "request"));

      const requestResponse = await fetch(`${portal.baseUrl}/api/requests/from-discord`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          discordUserId: "253987219969146890",
          username: "CaptainPax",
          query: "Dandadan",
          selectedMetadata: {
            provider: "mangadex",
            providerSeriesId: "md-1",
            title: "Dandadan"
          }
        })
      });
      assert.equal(requestResponse.status, 201);
      assert.deepEqual(await requestResponse.json(), {
        id: "req_123",
        title: "Dandadan",
        status: "pending"
      });

      const chatResponse = await fetch(`${portal.baseUrl}/api/chat`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({message: "how is scriptarr doing?"})
      });
      assert.equal(chatResponse.status, 200);
      assert.equal((await chatResponse.json()).reply, "Noona says the stack looks healthy.");

      const render = await fetch(`${portal.baseUrl}/api/onboarding/render`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({username: "CaptainPax"})
      }).then((response) => response.json());
      assert.equal(render.rendered, "Welcome to Scriptarr, CaptainPax.");

      const onboardingTest = await fetch(`${portal.baseUrl}/api/onboarding/test`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({username: "CaptainPax"})
      });
      assert.equal(onboardingTest.status, 409);
      assert.match((await onboardingTest.json()).error, /not connected/i);
    } finally {
      await portal.close();
    }
  });

  await richSage.close();

  const legacySage = await createJsonServer({
    "GET /api/internal/portal/discord/settings": async () => ({body: {commands: {}}}),
    "POST /api/internal/vault/users/upsert-discord": async ({body}) => ({body}),
    "POST /api/internal/vault/requests": async ({body}) => ({
      status: 201,
      body: {
        id: "req_legacy",
        ...body,
        status: "pending"
      }
    })
  });

  await withPortalEnv({
    SCRIPTARR_SAGE_BASE_URL: legacySage.baseUrl,
    SCRIPTARR_SERVICE_TOKEN: "portal-service-token"
  }, async () => {
    const portal = await createPortalServer();
    try {
      const response = await fetch(`${portal.baseUrl}/api/requests/from-discord`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          discordUserId: "discord-123",
          username: "Reader",
          title: "Blacksad",
          notes: "legacy path"
        })
      });

      assert.equal(response.status, 201);
      assert.equal((await response.json()).id, "req_legacy");
    } finally {
      await portal.close();
    }
  });

  await legacySage.close();
});

test("portal notifier delivers follow, approval, denial, and completion DMs once", async () => {
  const sent = [];
  const acknowledged = [];
  const ackedIds = new Set();
  const notifier = createFollowNotifier({
    pollMs: 5,
    publicBaseUrl: "https://pax-kun.com",
    logger: {error() {}},
    discord: {
      async sendDirectMessage(discordUserId, payload) {
        sent.push({discordUserId, payload});
      }
    },
    sage: {
      async listFollowNotifications() {
        return {
          ok: true,
          payload: {
            notifications: ackedIds.has("follow-1") ? [] : [{
              id: "follow-1",
              discordUserId: "user-1",
              titleName: "Dandadan",
              titleUrl: "https://pax-kun.com/title/webtoon/dan-da-dan",
              coverUrl: "https://images.example/dandadan.jpg"
            }]
          }
        };
      },
      async acknowledgeFollowNotification(notificationId) {
        ackedIds.add(notificationId);
        acknowledged.push(`follow:${notificationId}`);
        return {ok: true};
      },
      async listRequestNotifications() {
        return {
          ok: true,
          payload: {
            notifications: [
              ackedIds.has("request-1")
                ? null
                : {
                  id: "request-1",
                  requestId: "request-1",
                  discordUserId: "user-1",
                  titleName: "Solo Leveling",
                  titleUrl: "https://pax-kun.com/title/manhwa/solo-leveling",
                  coverUrl: "https://images.example/solo.jpg"
                },
              ackedIds.has("request-2:approved")
                ? null
                : {
                  requestId: "request-2",
                  decisionType: "approved",
                  discordUserId: "user-1",
                  titleName: "One Piece",
                  coverUrl: "https://images.example/one-piece.jpg",
                  moderatorNote: "Approved from Moon admin."
                },
              ackedIds.has("request-3:denied")
                ? null
                : {
                  requestId: "request-3",
                  decisionType: "denied",
                  discordUserId: "user-1",
                  titleName: "Chainsaw Man",
                  note: "Already available elsewhere."
                },
              ackedIds.has("request-4:blocked:user-2")
                ? null
                : {
                  id: "request-4:blocked:user-2",
                  requestId: "request-4",
                  decisionType: "blocked",
                  discordUserId: "user-2",
                  titleName: "Tomb Raider King"
                },
              ackedIds.has("request-5:ready:user-3")
                ? null
                : {
                  id: "request-5:ready:user-3",
                  requestId: "request-5",
                  decisionType: "ready",
                  discordUserId: "user-3",
                  titleName: "Absolute Duo",
                  titleUrl: "https://pax-kun.com/title/manga/absolute-duo"
                },
              ackedIds.has("request-6:source-found")
                ? null
                : {
                  id: "request-6:source-found",
                  requestId: "request-6",
                  decisionType: "source-found",
                  discordUserId: "user-4",
                  titleName: "Unmatched Title",
                  sourceFoundOptions: [{
                    providerId: "weebcentral",
                    titleUrl: "https://weebcentral.com/series/unmatched-title"
                  }]
                },
              ackedIds.has("request-7:expired")
                ? null
                : {
                  id: "request-7:expired",
                  requestId: "request-7",
                  decisionType: "expired",
                  discordUserId: "user-5",
                  titleName: "No Source Title"
                }
            ].filter(Boolean)
          }
        };
      },
      async acknowledgeRequestNotification(requestId) {
        ackedIds.add(requestId);
        acknowledged.push(`request:${requestId}`);
        return {ok: true};
      }
    },
    requestCommand: {
      buildSourceFoundDirectMessage() {
        return null;
      }
    }
  });

  notifier.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  notifier.stop();

  assert.equal(sent.length >= 4, true);
  assert.ok(sent.some((entry) => entry.payload?.content.includes("Dandadan")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("Solo Leveling")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("was approved")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("was denied")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("Approved from Moon admin.")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("already tracking **Tomb Raider King**")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("**Absolute Duo**, is ready")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("moved it back into admin review")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("expired after 90 days")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("https://pax-kun.com/myrequests")));
  assert.ok(sent.some((entry) => entry.payload?.embeds?.[0]?.image?.url === "https://images.example/solo.jpg"));
  assert.deepEqual(acknowledged.sort(), [
    "follow:follow-1",
    "request:request-1",
    "request:request-2:approved",
    "request:request-3:denied",
    "request:request-4:blocked:user-2",
    "request:request-5:ready:user-3",
    "request:request-6:source-found",
    "request:request-7:expired"
  ]);
});
