import {extractEnabledDefinitions} from "./commandCatalog.mjs";
import {syncGuildCommands} from "./commandSynchronizer.mjs";
import {createInteractionHandler} from "./interactionRouter.mjs";

const DEFAULT_EVENT_NAMES = Object.freeze({
  ready: "ready",
  interactionCreate: "interactionCreate",
  messageCreate: "messageCreate",
  guildMemberAdd: "guildMemberAdd",
  shardDisconnect: "shardDisconnect",
  shardError: "shardError",
  error: "error"
});

const DEFAULT_GATEWAY_INTENTS = Object.freeze({
  Guilds: "Guilds",
  GuildMembers: "GuildMembers",
  DirectMessages: "DirectMessages"
});

const DEFAULT_PARTIALS = Object.freeze({
  Channel: "Channel",
  GuildMember: "GuildMember",
  User: "User"
});

const normalizeString = (value) => typeof value === "string" ? value.trim() : "";

const describeError = (error) => error instanceof Error ? error.message : String(error ?? "");

const createDiagnosticError = (prefix, error) => {
  const message = describeError(error);
  const diagnostic = new Error(message ? `${prefix}: ${message}` : prefix, {
    cause: error instanceof Error ? error : undefined
  });
  if (error && typeof error === "object") {
    if ("code" in error) {
      diagnostic.code = error.code;
    }
    if ("reason" in error) {
      diagnostic.reason = error.reason;
    }
    if ("status" in error) {
      diagnostic.status = error.status;
    }
  }
  return diagnostic;
};

const formatDisconnectMessage = (closeEvent, shardId) => {
  const code = closeEvent?.code ?? null;
  const reason = normalizeString(closeEvent?.reason);
  const shardSuffix = shardId == null ? "" : ` on shard ${shardId}`;
  return code != null
    ? `Discord gateway disconnected${shardSuffix} with code ${code}${reason ? `: ${reason}` : "."}`
    : `Discord gateway disconnected${shardSuffix}.`;
};

const resolveDiscordBindings = (discordModule) => {
  if (!discordModule) {
    return {
      events: DEFAULT_EVENT_NAMES,
      intents: DEFAULT_GATEWAY_INTENTS,
      partials: DEFAULT_PARTIALS
    };
  }

  return {
    events: {
      ready: discordModule.Events?.ClientReady || DEFAULT_EVENT_NAMES.ready,
      interactionCreate: discordModule.Events?.InteractionCreate || DEFAULT_EVENT_NAMES.interactionCreate,
      messageCreate: discordModule.Events?.MessageCreate || DEFAULT_EVENT_NAMES.messageCreate,
      guildMemberAdd: discordModule.Events?.GuildMemberAdd || DEFAULT_EVENT_NAMES.guildMemberAdd,
      shardDisconnect: discordModule.Events?.ShardDisconnect || DEFAULT_EVENT_NAMES.shardDisconnect,
      shardError: discordModule.Events?.ShardError || DEFAULT_EVENT_NAMES.shardError,
      error: DEFAULT_EVENT_NAMES.error
    },
    intents: {
      Guilds: discordModule.GatewayIntentBits?.Guilds ?? DEFAULT_GATEWAY_INTENTS.Guilds,
      GuildMembers: discordModule.GatewayIntentBits?.GuildMembers ?? DEFAULT_GATEWAY_INTENTS.GuildMembers,
      DirectMessages: discordModule.GatewayIntentBits?.DirectMessages ?? DEFAULT_GATEWAY_INTENTS.DirectMessages
    },
    partials: {
      Channel: discordModule.Partials?.Channel ?? DEFAULT_PARTIALS.Channel,
      GuildMember: discordModule.Partials?.GuildMember ?? DEFAULT_PARTIALS.GuildMember,
      User: discordModule.Partials?.User ?? DEFAULT_PARTIALS.User
    }
  };
};

export const createDiscordClient = async ({
  token,
  clientId,
  commandMap,
  roleManager,
  getSettings,
  directMessageHandler,
  guildMemberAddHandler,
  enableGuildMemberEvents = false,
  onRuntimeEvent,
  logger,
  clientFactory
} = {}) => {
  if (!token) {
    throw new Error("Discord token is required.");
  }
  if (!clientId) {
    throw new Error("Discord client id is required.");
  }

  let discordModule = null;
  if (!clientFactory) {
    try {
      discordModule = await import("discord.js");
    } catch (error) {
      throw new Error(`discord.js is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const {events, intents, partials} = resolveDiscordBindings(discordModule);
  const requestedIntents = [
    intents.Guilds,
    intents.DirectMessages,
    ...(enableGuildMemberEvents ? [intents.GuildMembers] : [])
  ];
  const requestedPartials = [
    partials.Channel,
    partials.User,
    ...(enableGuildMemberEvents ? [partials.GuildMember] : [])
  ];
  const client = typeof clientFactory === "function"
    ? await clientFactory({
      intents: requestedIntents,
      partials: requestedPartials,
      enableGuildMemberEvents
    })
    : new discordModule.Client({
      intents: requestedIntents,
      partials: requestedPartials
    });

  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});

  client.once(events.ready, (bot) => {
    onRuntimeEvent?.({
      type: "ready",
      userTag: bot?.user?.tag || client?.user?.tag || ""
    });
    readyResolve(bot || client);
  });

  client.on(events.error, (error) => {
    onRuntimeEvent?.({
      type: "client-error",
      error,
      message: describeError(error)
    });
    logger?.error?.("Portal Discord client error.", {error});
  });

  client.on(events.shardError, (error, shardId) => {
    onRuntimeEvent?.({
      type: "shard-error",
      error,
      shardId,
      message: describeError(error)
    });
    logger?.error?.("Portal Discord shard error.", {error, shardId});
  });

  client.on(events.shardDisconnect, (closeEvent, shardId) => {
    const message = formatDisconnectMessage(closeEvent, shardId);
    onRuntimeEvent?.({
      type: "disconnect",
      shardId,
      code: closeEvent?.code ?? null,
      reason: normalizeString(closeEvent?.reason),
      message
    });
    logger?.warn?.("Portal Discord gateway disconnected.", {
      shardId,
      code: closeEvent?.code ?? null,
      reason: normalizeString(closeEvent?.reason)
    });
  });

  client.on(events.interactionCreate, createInteractionHandler({
    commandMap,
    roleManager,
    logger
  }));

  if (typeof directMessageHandler === "function") {
    client.on(events.messageCreate, (message) => {
      Promise.resolve(directMessageHandler(message)).catch((error) => {
        logger?.error?.("Portal DM handler failed.", {error});
      });
    });
  }

  if (typeof guildMemberAddHandler === "function") {
    client.on(events.guildMemberAdd, (member) => {
      Promise.resolve(guildMemberAddHandler(member)).catch((error) => {
        logger?.error?.("Portal onboarding handler failed.", {error});
      });
    });
  }

  const registerCommands = async () => {
    const settings = getSettings();
    const guildId = settings?.guildId;
    if (!guildId) {
      return {guildId: null, registered: 0};
    }
    const definitions = extractEnabledDefinitions(commandMap, settings);
    try {
      return await syncGuildCommands({
        commandManager: client.application?.commands,
        guildId,
        definitions
      });
    } catch (error) {
      const diagnostic = createDiagnosticError("Discord command registration failed", error);
      onRuntimeEvent?.({
        type: "command-sync-error",
        error: diagnostic,
        message: diagnostic.message
      });
      throw diagnostic;
    }
  };

  const login = async () => {
    try {
      await client.login(token);
      await ready;
      return registerCommands();
    } catch (error) {
      readyReject?.(error);
      const diagnostic = error instanceof Error && /^Discord command registration failed:/i.test(error.message)
        ? error
        : createDiagnosticError("Discord login failed", error);
      diagnostic.portalClient = client;
      onRuntimeEvent?.({
        type: "login-error",
        error: diagnostic,
        message: diagnostic.message
      });
      throw diagnostic;
    }
  };

  const fetchChannel = async (channelId) => {
    if (!channelId) {
      throw new Error("Discord channel id is required.");
    }
    await ready;
    return client.channels.fetch(channelId);
  };

  const sendChannelMessage = async (channelId, payload) => {
    const channel = await fetchChannel(channelId);
    return channel.send(typeof payload === "string" ? {content: payload} : payload);
  };

  const sendDirectMessage = async (userId, payload) => {
    if (!userId) {
      throw new Error("Discord user id is required.");
    }
    await ready;
    const user = await client.users.fetch(userId);
    return user.send(typeof payload === "string" ? {content: payload} : payload);
  };

  const destroy = () => {
    client.destroy?.();
  };

  return {
    client,
    login,
    registerCommands,
    sendChannelMessage,
    sendDirectMessage,
    waitUntilReady: () => ready,
    requestedIntents,
    requestedPartials,
    guildMemberEventsEnabled: enableGuildMemberEvents,
    destroy
  };
};
