import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {EventEmitter} from "node:events";

process.env.NODE_ENV = "test";

const {createPortalApp} = await import("../lib/createPortalApp.mjs");
const {buildUpdateChannelPayload, createFollowNotifier} = await import("../lib/followNotifier.mjs");

const withPortalEnv = async (overrides, handler) => {
  const keys = [
    "SCRIPTARR_SAGE_BASE_URL",
    "SCRIPTARR_SERVICE_TOKEN",
    "SCRIPTARR_PORTAL_SERVICE_TOKEN",
    "SCRIPTARR_PUBLIC_BASE_URL",
    "DISCORD_TOKEN",
    "SCRIPTARR_DISCORD_TOKEN",
    "SCRIPTARR_DISCORD_CLIENT_ID",
    "SCRIPTARR_APPA_DISCORD_TOKEN",
    "SCRIPTARR_APPA_DISCORD_CLIENT_ID",
    "SCRIPTARR_DISCORD_BOT_PERSONA",
    "SCRIPTARR_DISCORD_AVATAR_MODE",
    "SCRIPTARR_DISCORD_GUILD_ID",
    "SCRIPTARR_DISCORD_SUPERUSER_ID",
    "SCRIPTARR_DISCORD_UPDATE_CHANNEL_ID",
    "SCRIPTARR_ONBOARDING_TEMPLATE",
    "SCRIPTARR_SERVICE_TOKENS",
    "SCRIPTARR_REQUIRE_SERVICE_AUTH"
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

class FakeDiscordClient extends EventEmitter {
  constructor(id) {
    super();
    this.user = {id, tag: `${id}#0001`};
    this.sentChannelMessages = [];
    this.application = {
      commands: {
        set: async (definitions) => definitions
      }
    };
    this.channels = {
      fetch: async (channelId) => ({
        id: channelId,
        send: async (payload) => {
          const posted = {id: `${id}-message-${this.sentChannelMessages.length + 1}`, ...payload};
          this.sentChannelMessages.push({channelId, payload});
          return posted;
        }
      })
    };
  }

  async login() {
    queueMicrotask(() => this.emit("ready", this));
  }

  destroy() {}
}

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

test("LAN deployment authenticates API reads and writes without blocking health", async () => {
  await withPortalEnv({SCRIPTARR_REQUIRE_SERVICE_AUTH: "true", SCRIPTARR_PORTAL_SERVICE_TOKEN: "portal-private"}, async () => {
    const portal = await createPortalServer();
    try {
      assert.equal((await fetch(`${portal.baseUrl}/health`)).status, 200);
      assert.equal((await fetch(`${portal.baseUrl}/api/runtime`)).status, 401);
      assert.equal((await fetch(`${portal.baseUrl}/api/runtime/discord/reload`, {method: "POST"})).status, 401);
      assert.equal((await fetch(`${portal.baseUrl}/api/runtime`, {headers: {Authorization: "Bearer wrong"}})).status, 401);
      assert.equal((await fetch(`${portal.baseUrl}/api/runtime`, {headers: {Authorization: "Bearer portal-private"}})).status, 200);
    } finally {
      await portal.close();
    }
  });
});

test("portal HTTP surface covers command inventory, request routing, chat routing, and onboarding helpers", async () => {
  await withPortalEnv({}, async () => {
    const portal = await createPortalServer();
    try {
      const runtime = await fetch(`${portal.baseUrl}/api/runtime`).then((response) => response.json());
      assert.equal(runtime.mode, "disabled");
      assert.equal(runtime.connected, false);
      assert.deepEqual(
        runtime.commands.map((command) => command.name),
        ["ding", "status", "chat", "search", "request", "subscribe", "trivia", "discord", "ingest", "downloadall"]
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
      assert.equal(body.selectedDownload, null);
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
      assert.equal(chatResponse.status, 410);
      assert.match((await chatResponse.json()).error, /Scriptarr Users permissions/i);

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

test("Noona smoke route is service-token gated and posts only to the smoke channel", async () => {
  const diagnostics = [];
  const noonaChats = [];
  const sage = await createJsonServer({
    "GET /api/internal/portal/discord/settings": async () => ({
      body: {
        guildId: "guild-1",
        noonaChat: {enabled: true, allowedChannelIds: []},
        commands: {chat: {enabled: true}},
        appa: {
          enabled: true,
          adminMentionChannelIds: ["1352387716259778570"],
          commands: {
            status: {enabled: true},
            discord: {enabled: true}
          }
        }
      }
    }),
    "POST /api/internal/portal/appa-discord-diagnostic": async ({body}) => {
      diagnostics.push(body);
      return {body: {ok: true}};
    },
    "POST /api/internal/portal/noona-chat": async ({body}) => {
      noonaChats.push(body);
      return {body: {ok: true, reply: "Noona smoke ok"}};
    }
  });

  try {
    await withPortalEnv({
      SCRIPTARR_SAGE_BASE_URL: sage.baseUrl,
      SCRIPTARR_SERVICE_TOKEN: "portal-service-token",
      SCRIPTARR_DISCORD_TOKEN: "noona-token",
      SCRIPTARR_DISCORD_CLIENT_ID: "noona-client",
      SCRIPTARR_APPA_DISCORD_TOKEN: "appa-token",
      SCRIPTARR_APPA_DISCORD_CLIENT_ID: "appa-client"
    }, async () => {
      const noonaClient = new FakeDiscordClient("noona-1");
      const appaClient = new FakeDiscordClient("appa-1");
      const clients = [noonaClient, appaClient];
      const portal = await createPortalServer({
        clientFactory: async () => clients.shift()
      });
      try {
        const unauthenticated = await fetch(`${portal.baseUrl}/api/runtime/discord/smoke/noona`, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({channelId: "1352387716259778570"})
        });
        assert.equal(unauthenticated.status, 401);

        await portal.runtime.start();

        const wrongChannel = await fetch(`${portal.baseUrl}/api/runtime/discord/smoke/noona`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer portal-service-token"
          },
          body: JSON.stringify({channelId: "wrong-channel"})
        });
        assert.equal(wrongChannel.status, 409);
        assert.match((await wrongChannel.json()).error, /restricted/i);

        const response = await fetch(`${portal.baseUrl}/api/runtime/discord/smoke/noona`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer portal-service-token"
          },
          body: JSON.stringify({channelId: "1352387716259778570"})
        });
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.ok, true);
        assert.equal(appaClient.sentChannelMessages.length, 1);
        assert.match(appaClient.sentChannelMessages[0].payload.content, /^<@noona-1> \[smoke:[a-f0-9-]+\] are you online\?$/i);
        assert.deepEqual(appaClient.sentChannelMessages[0].payload.allowedMentions, {
          users: ["noona-1"],
          repliedUser: false,
          parse: []
        });
        assert.equal(diagnostics[0].messageExcerpt, "Noona AI smoke ping");

        const replies = [];
        const edits = [];
        noonaClient.emit("messageCreate", {
          id: "appa-smoke-message-1",
          guildId: "guild-1",
          channelId: "1352387716259778570",
          content: appaClient.sentChannelMessages[0].payload.content,
          author: {id: "appa-1", username: "Appa", bot: true},
          member: {roles: {cache: new Set()}},
          mentions: {users: new Set(["noona-1"]), has: (id) => id === "noona-1"},
          channel: {id: "1352387716259778570", sendTyping: async () => {}},
          reply: async (replyPayload) => {
            replies.push(replyPayload);
            return {
              id: "noona-smoke-reply-1",
              edit: async (editPayload) => {
                edits.push(editPayload);
                return editPayload;
              }
            };
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(noonaChats[0].message, "are you online?");
        assert.equal(edits[0].content, "<@appa-1> Noona smoke ok");
      } finally {
        await portal.close();
      }
    });
  } finally {
    await sage.close();
  }
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
      },
      async sendChannelMessage(channelId, payload) {
        sent.push({channelId, payload});
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
      },
      async listSystemNotifications() {
        return {
          ok: true,
          payload: {
            notifications: ackedIds.has("localai:job-1:completed") ? [] : [{
              id: "localai:job-1:completed",
              discordUserId: "user-1",
              titleName: "LocalAI",
              message: "LocalAI startup completed. The runtime is ready for Oracle.",
              image: "localai/localai:latest-aio-cpu",
              linkUrl: "https://pax-kun.com/admin/system/ai"
            }]
          }
        };
      },
      async acknowledgeSystemNotification(notificationId) {
        ackedIds.add(notificationId);
        acknowledged.push(`system:${notificationId}`);
        return {ok: true};
      },
      async listUpdateNotifications() {
        return {
          ok: true,
          payload: {
            notifications: ackedIds.has("update:abc123def456") ? [] : [{
              id: "update:abc123def456",
              channelId: "updates-channel",
              repository: "The-Noona-Project/Scriptarr",
              branch: "main",
              summary: "Noona says a new update is ready. Ask me what changed.",
              compareUrl: "https://github.com/The-Noona-Project/Scriptarr/compare/base...main",
              commitCount: 2,
              latestSha: "abc123def456",
              commits: [{
                sha: "abc123def456",
                title: "Add update summaries",
                author: "Noona",
                date: "2026-05-16T00:00:00.000Z",
                url: "https://github.com/The-Noona-Project/Scriptarr/commit/abc123def456"
              }]
            }]
          }
        };
      },
      async acknowledgeUpdateNotification(notificationId) {
        ackedIds.add(notificationId);
        acknowledged.push(`update:${notificationId}`);
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
  assert.ok(sent.some((entry) => entry.payload?.content.includes("moved it back into staff review")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("expired after 90 days")));
  assert.ok(sent.some((entry) => entry.payload?.content.includes("LocalAI startup completed")));
  assert.ok(sent.some((entry) => entry.channelId === "updates-channel" && entry.payload?.content.includes("New Scriptarr update is ready.")));
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
    "request:request-7:expired",
    "system:localai:job-1:completed",
    "update:update:abc123def456"
  ]);
});

test("portal notifier skips overlapping polls and stops before stale Discord sends", async () => {
  let activeLists = 0;
  let maxActiveLists = 0;
  let releaseList;
  const sent = [];
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
        activeLists += 1;
        maxActiveLists = Math.max(maxActiveLists, activeLists);
        await new Promise((resolve) => {
          releaseList = resolve;
        });
        activeLists -= 1;
        return {
          ok: true,
          payload: {
            notifications: [{
              id: "follow-stale",
              discordUserId: "user-1",
              titleName: "Late Title"
            }]
          }
        };
      },
      async acknowledgeFollowNotification() {
        return {ok: true};
      }
    }
  });

  notifier.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const stopPromise = notifier.stop();
  releaseList();
  await stopPromise;

  assert.equal(maxActiveLists, 1);
  assert.deepEqual(sent, []);
});

test("update channel payload keeps Noona summary clean and traceability behind buttons", () => {
  const payload = buildUpdateChannelPayload({
    repository: "The-Noona-Project/Scriptarr",
    branch: "main",
    summary: "Noona tuned the reader so pages are ready before you turn them.",
    compareUrl: "https://github.com/The-Noona-Project/Scriptarr/compare/base...main",
    commitCount: 2,
    latestSha: "abc123def456",
    commits: [{
      sha: "abc123def456",
      title: "Preload reader pages",
      url: "https://github.com/The-Noona-Project/Scriptarr/commit/abc123def456"
    }]
  }, "https://pax-kun.com", "Scriptarr");

  assert.match(payload.content, /New Scriptarr update is ready/);
  assert.doesNotMatch(payload.content, /pages are ready before you turn them/);
  assert.equal(payload.embeds[0].title, "Scriptarr update");
  assert.equal(payload.embeds[0].description, "Noona tuned the reader so pages are ready before you turn them.");
  assert.deepEqual(payload.embeds[0].fields, []);
  assert.equal(payload.embeds[0].footer.text, "2 changes included");
  assert.equal(payload.components[0].components[0].label, "View changes");
  assert.equal(payload.embeds[0].fields.some((field) => field.name === "Recent commits"), false);
  assert.equal(payload.embeds[0].fields.some((field) => field.name === "Included commits"), false);
  assert.doesNotMatch(JSON.stringify(payload), /abc123def456/);
  assert.doesNotMatch(JSON.stringify(payload), /admin\/system\/updates/);
});
