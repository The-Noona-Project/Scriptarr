import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";

const {createPortalRuntime} = await import("../lib/portalRuntime.mjs");
const {createPortalCommands} = await import("../lib/discord/commands/index.mjs");
const {createRoleManager} = await import("../lib/discord/roleManager.mjs");
const {createInteractionHandler} = await import("../lib/discord/interactionRouter.mjs");

class FakeDiscordClient extends EventEmitter {
  constructor() {
    super();
    this.user = {tag: "Portal#0001"};
    this.destroyed = false;
    this.application = {
      commands: {
        set: async (definitions, guildId) => {
          this.commandSets.push({definitions, guildId});
          return definitions;
        }
      }
    };
    this.channels = {
      fetch: async () => ({
        send: async (payload) => {
          this.sentChannelMessages.push(payload);
          return payload;
        }
      })
    };
    this.users = {
      fetch: async (userId) => ({
        send: async (payload) => {
          this.sentDirectMessages.push({userId, payload});
          return payload;
        }
      })
    };
    this.commandSets = [];
    this.sentChannelMessages = [];
    this.sentDirectMessages = [];
  }

  async login() {
    queueMicrotask(() => {
      this.emit("ready", this);
    });
  }

  destroy() {
    this.destroyed = true;
  }
}

const createLogger = () => ({
  info() {},
  warn() {},
  error() {}
});

const createInteraction = ({commandName, guildId = "guild-1", roleIds = [], strings = {}, userId = "user-1"}) => {
  const calls = {reply: [], editReply: [], deferReply: []};
  const interaction = {
    commandName,
    guildId,
    user: {
      id: userId,
      username: "CaptainPax",
      globalName: "CaptainPax",
      displayAvatarURL: () => "https://cdn.example/avatar.png"
    },
    member: {
      roles: {
        cache: new Set(roleIds)
      }
    },
    options: {
      getString: (name) => strings[name] || null
    },
    isChatInputCommand: () => true,
    isButton: () => false,
    reply: async (payload) => {
      calls.reply.push(payload);
      return payload;
    },
    editReply: async (payload) => {
      calls.editReply.push(payload);
      return payload;
    },
    deferReply: async (payload) => {
      calls.deferReply.push(payload);
      interaction.deferred = true;
      return payload;
    },
    deferred: false,
    replied: false,
    __calls: calls
  };
  return interaction;
};

const createButtonInteraction = ({customId, userId = "user-1"}) => {
  const calls = {reply: [], editReply: []};
  return {
    customId,
    user: {
      id: userId,
      username: "CaptainPax",
      globalName: "CaptainPax",
      displayAvatarURL: () => "https://cdn.example/avatar.png"
    },
    isChatInputCommand: () => false,
    isButton: () => true,
    deferred: false,
    replied: false,
    reply: async (payload) => {
      calls.reply.push(payload);
      return payload;
    },
    editReply: async (payload) => {
      calls.editReply.push(payload);
      return payload;
    },
    __calls: calls
  };
};

const baseConfig = {
  publicBaseUrl: "https://pax-kun.com",
  discordToken: "discord-token",
  discordClientId: "discord-client-id",
  discordDefaults: {
    guildId: null,
    superuserId: null,
    onboarding: {
      channelId: null,
      template: "Welcome {username}"
    },
    commands: {
      ding: {enabled: true, roleId: null},
      status: {enabled: true, roleId: null},
      chat: {enabled: true, roleId: null},
      search: {enabled: true, roleId: null},
      request: {enabled: true, roleId: null},
      subscribe: {enabled: true, roleId: null},
      downloadall: {enabled: true, roleId: null}
    }
  }
};

test("portal runtime syncs enabled commands and exposes Discord runtime state", async () => {
  const fakeClient = new FakeDiscordClient();
  const sage = {
    async getDiscordSettings() {
      return {
        ok: true,
        payload: {
          guildId: "guild-1",
          commands: {
            search: {enabled: true, roleId: "role-search"},
            request: {enabled: true, roleId: "role-request"},
            subscribe: {enabled: false}
          }
        }
      };
    },
    async listFollowNotifications() {
      return {ok: true, payload: {notifications: []}};
    }
  };

  const runtime = createPortalRuntime({
    config: baseConfig,
    sage,
    logger: createLogger(),
    clientFactory: async () => fakeClient
  });

  try {
    await runtime.start();
    const state = runtime.getState();
    assert.equal(state.mode, "ready");
    assert.equal(state.connected, true);
    assert.equal(state.guildId, "guild-1");
    assert.equal(state.registeredGuildId, "guild-1");
    assert.equal(state.capabilities.commandSync.status, "available");
    assert.equal(state.capabilities.directMessages.status, "available");
    assert.equal(state.capabilities.onboarding.status, "disabled");
    assert.equal(state.commands.find((command) => command.name === "subscribe").enabled, false);
    assert.equal(state.commands.find((command) => command.name === "request").status, "Registered");
    assert.equal(fakeClient.commandSets.at(-1).guildId, "guild-1");
    assert.deepEqual(fakeClient.commandSets.at(-1).definitions.map((definition) => definition.name), [
      "ding",
      "status",
      "chat",
      "search",
      "request"
    ]);
  } finally {
    await runtime.stop();
  }
});

test("portal runtime falls back to minimal intents when guild member intent is disallowed", async () => {
  const createdClients = [];
  const sage = {
    async getDiscordSettings() {
      return {
        ok: true,
        payload: {
          guildId: "guild-1",
          onboarding: {
            channelId: "channel-1",
            template: "Welcome {username}"
          }
        }
      };
    },
    async listFollowNotifications() {
      return {ok: true, payload: {notifications: []}};
    }
  };

  const runtime = createPortalRuntime({
    config: baseConfig,
    sage,
    logger: createLogger(),
    clientFactory: async (options = {}) => {
      const fakeClient = new FakeDiscordClient();
      fakeClient.options = options;
      fakeClient.login = async () => {
        if (options.intents?.includes("GuildMembers")) {
          const error = new Error("Discord gateway closed with code 4014: disallowed intents.");
          error.code = 4014;
          throw error;
        }
        queueMicrotask(() => {
          fakeClient.emit("ready", fakeClient);
        });
      };
      createdClients.push(fakeClient);
      return fakeClient;
    }
  });

  try {
    await runtime.start();
    const state = runtime.getState();
    assert.equal(createdClients.length, 2);
    assert.equal(createdClients[0].options.intents.includes("GuildMembers"), true);
    assert.equal(createdClients[1].options.intents.includes("GuildMembers"), false);
    assert.equal(createdClients[0].destroyed, true);
    assert.equal(state.mode, "ready");
    assert.equal(state.connected, true);
    assert.equal(state.warning?.includes("Server Members intent"), true);
    assert.equal(state.capabilities.commandSync.status, "available");
    assert.equal(state.capabilities.onboarding.status, "degraded");
    assert.match(state.capabilities.onboarding.detail, /Server Members intent/i);
  } finally {
    await runtime.stop();
  }
});

test("portal runtime surfaces disconnect reasons after connecting", async () => {
  const fakeClient = new FakeDiscordClient();
  const sage = {
    async getDiscordSettings() {
      return {
        ok: true,
        payload: {
          guildId: "guild-1"
        }
      };
    },
    async listFollowNotifications() {
      return {ok: true, payload: {notifications: []}};
    }
  };

  const runtime = createPortalRuntime({
    config: baseConfig,
    sage,
    logger: createLogger(),
    clientFactory: async () => fakeClient
  });

  try {
    await runtime.start();
    fakeClient.emit("shardDisconnect", {code: 4014, reason: "Disallowed intents"}, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = runtime.getState();
    assert.equal(state.connected, false);
    assert.equal(state.connectionState, "degraded");
    assert.match(state.error, /4014/);
    assert.match(state.error, /Disallowed intents/i);
  } finally {
    await runtime.stop();
  }
});

test("interaction router enforces guild and role gates and formats search results", async () => {
  const settings = {
    guildId: "guild-1",
    commands: {
      search: {enabled: true, roleId: "role-search"}
    }
  };
  const commands = createPortalCommands({
    sage: {
      async searchLibrary(query) {
        return {
          ok: true,
          payload: {
            results: [
              {
                id: "title-1",
                title: "Dandadan",
                libraryTypeSlug: "manga",
                libraryTypeLabel: "Manga",
                latestChapter: "166",
                status: "active"
              }
            ],
            query
          }
        };
      }
    },
    publicBaseUrl: "https://pax-kun.com"
  });

  const handler = createInteractionHandler({
    commandMap: commands,
    roleManager: createRoleManager({
      getSettings: () => settings
    }),
    logger: createLogger()
  });

  const denied = createInteraction({
    commandName: "search",
    guildId: "guild-2",
    roleIds: ["role-search"],
    strings: {title: "Dandadan"}
  });
  await handler(denied);
  assert.match(denied.__calls.reply[0].content, /configured Discord server/i);

  const allowed = createInteraction({
    commandName: "search",
    guildId: "guild-1",
    roleIds: ["role-search"],
    strings: {title: "Dandadan"}
  });
  await handler(allowed);
  assert.match(allowed.__calls.editReply[0].content, /https:\/\/pax-kun\.com\/title\/manga\/title-1/);
});

test("request and subscribe commands drive interactive Sage-backed selections", async () => {
  const settings = {
    guildId: "guild-1",
    commands: {
      request: {enabled: true},
      subscribe: {enabled: true}
    }
  };
  const createdRequests = [];
  const sage = {
    async searchRequestMetadata() {
      return {
        ok: true,
        payload: [
          {
            provider: "mangadex",
            providerName: "MangaDex",
            providerSeriesId: "md-1",
            title: "One Piece (Official Colored)",
            aliases: ["One Piece"],
            summary: "Luffy sails the Grand Line.",
            type: "manga",
            url: "https://mangadex.org/title/md-1",
            tags: ["Action", "Adventure"]
          }
        ]
      };
    },
    async searchLibrary() {
      return {
        ok: true,
        payload: {
          results: [
            {
              id: "title-1",
              title: "Dandadan",
              mediaType: "manga",
              libraryTypeLabel: "Manga",
              libraryTypeSlug: "manga",
              latestChapter: "166"
            }
          ]
        }
      };
    },
    async upsertDiscordUser(payload) {
      return {ok: true, payload, status: 200};
    },
    async createDiscordRequest(payload) {
      createdRequests.push(payload);
      return {
        ok: true,
        payload: {
          id: "req-1",
          title: "One Piece (Official Colored)",
          status: "pending"
        },
        status: 201
      };
    },
    async addFollowing(payload) {
      return {
        ok: true,
        payload: {
          following: [payload]
        },
        status: 201
      };
    }
  };

  const commands = createPortalCommands({
    sage,
    publicBaseUrl: "https://pax-kun.com"
  });
  const handler = createInteractionHandler({
    commandMap: commands,
    roleManager: createRoleManager({
      getSettings: () => settings
    }),
    logger: createLogger()
  });

  const requestInteraction = createInteraction({
    commandName: "request",
    strings: {query: "One Piece", notes: "Please add this"}
  });
  await handler(requestInteraction);
  const requestReply = requestInteraction.__calls.editReply[0];
  assert.match(requestReply.content, /Pick the exact metadata result/i);
  assert.match(requestReply.content, /Official Colored/);
  assert.match(requestReply.content, /https:\/\/mangadex\.org\/title\/md-1/);
  const metadataButtonId = requestReply.components[0].components[0].custom_id;

  const metadataButton = createButtonInteraction({customId: metadataButtonId});
  await handler(metadataButton);
  assert.match(metadataButton.__calls.reply[0].content, /Request saved as \*\*pending\*\*/);
  assert.equal(createdRequests[0].title, "One Piece (Official Colored)");
  assert.equal(createdRequests[0].selectedMetadata.providerSeriesId, "md-1");
  assert.equal(Object.hasOwn(createdRequests[0], "selectedDownload"), false);

  const subscribeInteraction = createInteraction({
    commandName: "subscribe",
    strings: {title: "Dandadan"}
  });
  await handler(subscribeInteraction);
  const subscribeReply = subscribeInteraction.__calls.editReply[0];
  const subscribeButtonId = subscribeReply.components[0].components[0].custom_id;

  const subscribeButton = createButtonInteraction({customId: subscribeButtonId});
  await handler(subscribeButton);
  assert.match(subscribeButton.__calls.reply[0].content, /Following \*\*Dandadan\*\*/);
});
