import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";

const {createPortalRuntime} = await import("../lib/portalRuntime.mjs");
const {createPortalCommands} = await import("../lib/discord/commands/index.mjs");
const {createRoleManager} = await import("../lib/discord/roleManager.mjs");
const {createInteractionHandler} = await import("../lib/discord/interactionRouter.mjs");
const {createTriviaRuntime} = await import("../lib/discord/triviaRuntime.mjs");

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
      getString: (name) => strings[name] || null,
      getBoolean: (name) => Object.hasOwn(strings, name) ? strings[name] : null,
      getInteger: (name) => Object.hasOwn(strings, name) ? strings[name] : null,
      getSubcommand: () => strings.__subcommand || null
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
    clientFactory: async (options = {}) => {
      fakeClient.options = options;
      return fakeClient;
    }
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
    assert.equal(fakeClient.options.intents.includes("GuildMessages"), true);
    assert.equal(fakeClient.options.intents.includes("DirectMessages"), true);
    assert.equal(fakeClient.options.intents.includes("MessageContent"), true);
    assert.equal(state.commands.find((command) => command.name === "subscribe").enabled, false);
    assert.equal(state.commands.find((command) => command.name === "request").status, "Registered");
    assert.equal(state.commands.find((command) => command.name === "downloadall").status, "Registered");
    assert.equal(state.registeredGlobalCount, 1);
    assert.equal(fakeClient.commandSets[0].guildId, undefined);
    assert.deepEqual(fakeClient.commandSets[0].definitions.map((definition) => definition.name), [
      "downloadall"
    ]);
    assert.equal(fakeClient.commandSets[1].guildId, "guild-1");
    assert.deepEqual(fakeClient.commandSets[1].definitions.map((definition) => definition.name), [
      "ding",
      "status",
      "chat",
      "search",
      "request",
      "trivia"
    ]);
  } finally {
    await runtime.stop();
  }
});

test("portal runtime queues forced trivia leaderboards without waiting on Discord send", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.channels.fetch = async (channelId) => ({
    send: async (payload) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      fakeClient.sentChannelMessages.push({channelId, payload});
      return {id: "leaderboard-message-1"};
    }
  });
  const acknowledged = [];
  const sage = {
    async getDiscordSettings() {
      return {
        ok: true,
        payload: {
          guildId: "guild-1",
          trivia: {
            enabled: true,
            channelId: "trivia-channel"
          }
        }
      };
    },
    async listFollowNotifications() {
      return {ok: true, payload: {notifications: []}};
    },
    async getTriviaLeaderboard(windowName) {
      return {
        ok: true,
        payload: {
          window: windowName,
          rows: [{discordUserId: "user-1", username: "CaptainPax", xp: 12, wins: 1}]
        }
      };
    },
    async acknowledgeTriviaLeaderboard(postId) {
      acknowledged.push(postId);
      return {ok: true};
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
    const result = await runtime.postTriviaLeaderboard({window: "all", defer: true});
    assert.equal(result.queued, true);
    assert.equal(result.channelId, "trivia-channel");
    assert.equal(fakeClient.sentChannelMessages.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fakeClient.sentChannelMessages.length, 1);
    assert.match(fakeClient.sentChannelMessages[0].payload.content, /CaptainPax/);
    assert.deepEqual(acknowledged, ["trivia-leaderboard:all:leaderboard-message-1"]);
  } finally {
    await runtime.stop();
  }
});

test("trivia runtime reacts with eyes before final guess verdict", async () => {
  const reactions = [];
  const sentMessages = [];
  const calls = {state: 0, guess: 0};
  const runtime = createTriviaRuntime({
    getSettings: () => ({
      trivia: {
        enabled: true,
        channelId: "trivia-channel",
        leaderboardAfterRound: false
      }
    }),
    logger: createLogger(),
    discord: {
      async sendChannelMessage(channelId, payload) {
        sentMessages.push({channelId, payload});
        return {id: "message-1"};
      }
    },
    sage: {
      async getTriviaState() {
        calls.state += 1;
        return {
          ok: true,
          payload: {
            activeRound: {id: "round-1", prompt: "clue", status: "open"}
          }
        };
      },
      async submitTriviaGuess(_roundId, payload) {
        calls.guess += 1;
        assert.deepEqual(reactions, ["👀"]);
        return {
          ok: true,
          payload: {
            ok: true,
            correct: true,
            round: {title: "Ancient Bakery"},
            guess: {discordUserId: payload.discordUserId},
            scoreEvent: {xp: 15}
          }
        };
      }
    }
  });

  try {
    await runtime.handleGuildMessage({
      id: "guess-message-1",
      channelId: "trivia-channel",
      content: "Ancient Bakery",
      author: {id: "user-1", username: "Reader", bot: false},
      react: async (reaction) => {
        reactions.push(reaction);
      }
    });

    assert.deepEqual(reactions, ["👀", "✅"]);
    assert.equal(calls.state, 1);
    assert.equal(calls.guess, 1);
    assert.match(sentMessages[0].payload.content, /Correct/);
  } finally {
    runtime.stop();
  }
});

test("trivia runtime caches active round state and ignores duplicate messages", async () => {
  const reactions = [];
  const calls = {state: 0, guess: 0};
  const runtime = createTriviaRuntime({
    getSettings: () => ({
      trivia: {
        enabled: true,
        channelId: "trivia-channel",
        leaderboardAfterRound: false
      }
    }),
    logger: createLogger(),
    discord: {
      async sendChannelMessage() {
        return {id: "message-1"};
      }
    },
    sage: {
      async getTriviaState() {
        calls.state += 1;
        return {
          ok: true,
          payload: {
            activeRound: {id: "round-1", prompt: "clue", status: "open"}
          }
        };
      },
      async submitTriviaGuess() {
        calls.guess += 1;
        return {
          ok: true,
          payload: {ok: true, correct: false, close: false}
        };
      }
    }
  });
  const message = (id) => ({
    id,
    channelId: "trivia-channel",
    content: "wrong",
    author: {id: "user-1", username: "Reader", bot: false},
    react: async (reaction) => {
      reactions.push(`${id}:${reaction}`);
    }
  });

  try {
    await runtime.handleGuildMessage(message("guess-message-1"));
    await runtime.handleGuildMessage(message("guess-message-1"));
    await runtime.handleGuildMessage(message("guess-message-2"));

    assert.equal(calls.state, 1);
    assert.equal(calls.guess, 2);
    assert.deepEqual(reactions, [
      "guess-message-1:👀",
      "guess-message-1:❌",
      "guess-message-2:👀",
      "guess-message-2:❌"
    ]);
  } finally {
    runtime.stop();
  }
});

test("portal runtime forwards configured guild messages into trivia handling", async () => {
  const fakeClient = new FakeDiscordClient();
  const reactions = [];
  const calls = {guess: 0};
  const sage = {
    async getDiscordSettings() {
      return {
        ok: true,
        payload: {
          guildId: "guild-1",
          trivia: {
            enabled: true,
            channelId: "trivia-channel",
            leaderboardAfterRound: false
          }
        }
      };
    },
    async listFollowNotifications() {
      return {ok: true, payload: {notifications: []}};
    },
    async getTriviaState() {
      return {
        ok: true,
        payload: {
          activeRound: {id: "round-1", prompt: "clue", status: "open"}
        }
      };
    },
    async submitTriviaGuess() {
      calls.guess += 1;
      return {
        ok: true,
        payload: {ok: true, correct: false, close: false}
      };
    }
  };

  const runtime = createPortalRuntime({
    config: baseConfig,
    sage,
    logger: createLogger(),
    clientFactory: async (options = {}) => {
      fakeClient.options = options;
      return fakeClient;
    }
  });

  try {
    await runtime.start();
    assert.equal(fakeClient.options.intents.includes("GuildMessages"), true);
    fakeClient.emit("messageCreate", {
      id: "guild-message-1",
      guildId: "guild-1",
      channelId: "trivia-channel",
      content: "wrong",
      author: {id: "user-1", username: "Reader", bot: false},
      react: async (reaction) => {
        reactions.push(reaction);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.guess, 1);
    assert.deepEqual(reactions, ["\u{1F440}", "\u274C"]);
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
    assert.equal(createdClients[1].options.intents.includes("GuildMessages"), true);
    assert.equal(createdClients[1].options.intents.includes("MessageContent"), true);
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

test("downloadall slash command is DM-only and owner-only", async () => {
  const settings = {
    guildId: "guild-1",
    superuserId: "owner-1",
    commands: {
      downloadall: {enabled: true}
    }
  };
  const forwardedPayloads = [];
  const bulkRunActions = [];
  const commands = createPortalCommands({
    sage: {
      async bulkQueueDownload(payload) {
        forwardedPayloads.push(payload);
        return {
          ok: true,
          payload: {
            status: "queued",
            message: "Bulk queue submitted.",
            filters: payload,
            queuedCount: 1,
            matchedCount: 1,
            pagesScanned: 1,
            skippedActiveCount: 0,
            skippedAdultContentCount: 0,
            skippedNoMetadataCount: 0,
            skippedAmbiguousMetadataCount: 0,
            failedCount: 0
          }
        };
      },
      async createBulkRun(payload) {
        bulkRunActions.push({action: "create", payload});
        return {
          ok: true,
          payload: {
            runId: "bulk-run-1",
            status: "paused",
            message: "First batch queued.",
            filters: payload,
            counts: {
              completedBatches: 1,
              remainingBatches: 4,
              queued: 12,
              skipped: 0,
              failed: 0
            }
          }
        };
      },
      async getBulkRunStatus(runId) {
        bulkRunActions.push({action: "status", runId});
        return {
          ok: true,
          payload: {
            runId,
            status: "paused",
            message: "Waiting for owner continuation.",
            counts: {
              completedBatches: 1,
              remainingBatches: 4,
              queued: 12,
              skipped: 0,
              failed: 0
            }
          }
        };
      }
    },
    publicBaseUrl: "https://pax-kun.com",
    getSettings: () => settings,
    logger: createLogger()
  });
  const handler = createInteractionHandler({
    commandMap: commands,
    roleManager: createRoleManager({
      getSettings: () => settings
    }),
    logger: createLogger()
  });

  const deniedGuild = createInteraction({
    commandName: "downloadall",
    guildId: "guild-1",
    userId: "owner-1",
    strings: {__subcommand: "help"}
  });
  await handler(deniedGuild);
  assert.match(deniedGuild.__calls.reply[0].content, /only works in a direct message/i);

  const deniedOwner = createInteraction({
    commandName: "downloadall",
    guildId: null,
    userId: "user-2",
    strings: {__subcommand: "help"}
  });
  await handler(deniedOwner);
  assert.match(deniedOwner.__calls.reply[0].content, /configured Scriptarr owner/i);

  const helpInteraction = createInteraction({
    commandName: "downloadall",
    guildId: null,
    userId: "owner-1",
    strings: {__subcommand: "help"}
  });
  await handler(helpInteraction);
  assert.match(helpInteraction.__calls.reply[0].content, /\/downloadall run type:manga nsfw:false titlegroup:a/i);

  const runInteraction = createInteraction({
    commandName: "downloadall",
    guildId: null,
    userId: "owner-1",
    strings: {
      __subcommand: "run",
      type: "Manga",
      nsfw: false,
      titlegroup: "a",
      groupsize: 5
    }
  });
  await handler(runInteraction);
  assert.equal(runInteraction.__calls.deferReply.length, 1);
  assert.match(runInteraction.__calls.editReply[0].content, /Run ID: bulk-run-1/);
  assert.deepEqual(bulkRunActions[0], {
    action: "create",
    payload: {
      providerId: "weebcentral",
      type: "Manga",
      nsfw: false,
      titlePrefix: "a",
      batchesPerApproval: 5,
      groupsize: 5,
      requestedBy: "owner-1"
    }
  });

  const megaInteraction = createInteraction({
    commandName: "downloadall",
    guildId: null,
    userId: "owner-1",
    strings: {
      __subcommand: "run",
      type: "all",
      nsfw: false,
      titlegroup: "all"
    }
  });
  await handler(megaInteraction);
  assert.match(megaInteraction.__calls.editReply[0].content, /Run ID: bulk-run-1/);
  assert.deepEqual(bulkRunActions[1], {
    action: "create",
    payload: {
      providerId: "weebcentral",
      type: "all",
      nsfw: false,
      titlePrefix: "all",
      batchesPerApproval: 1,
      groupsize: 1,
      requestedBy: "owner-1"
    }
  });

  const statusInteraction = createInteraction({
    commandName: "downloadall",
    guildId: null,
    userId: "owner-1",
    strings: {
      __subcommand: "status",
      runid: "bulk-run-1"
    }
  });
  await handler(statusInteraction);
  assert.match(statusInteraction.__calls.editReply[0].content, /Waiting for owner continuation/);
  assert.deepEqual(bulkRunActions[2], {
    action: "status",
    runId: "bulk-run-1"
  });
});
