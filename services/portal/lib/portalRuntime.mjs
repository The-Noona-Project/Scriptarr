import {createDiscordClient} from "./discord/client.mjs";
import {buildCommandInventory} from "./discord/commandCatalog.mjs";
import {createPortalCommands} from "./discord/commands/index.mjs";
import {createDirectMessageHandler} from "./discord/directMessageRouter.mjs";
import {createRoleManager} from "./discord/roleManager.mjs";
import {normalizePortalDiscordSettings} from "./discord/settings.mjs";
import {normalizeString} from "./discord/utils.mjs";
import {createFollowNotifier} from "./followNotifier.mjs";

const renderTemplate = (template, values) => Object.entries(values).reduce(
  (current, [key, value]) => current.replaceAll(`{${key}}`, normalizeString(value)),
  normalizeString(template)
);

const describeError = (error) => error instanceof Error ? error.message : String(error ?? "");

const collectErrorText = (error) => {
  const fragments = [];
  let current = error;
  while (current) {
    if (current instanceof Error) {
      fragments.push(current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      if (current?.message) {
        fragments.push(String(current.message));
      }
      if (current?.reason) {
        fragments.push(String(current.reason));
      }
      current = current?.cause;
      continue;
    }
    fragments.push(String(current));
    break;
  }
  return fragments.filter(Boolean).join(" | ");
};

const isGuildMemberIntentFailure = (error) => /4014|disallowed intent|privileged intent|guild[_ ]members|server members/i.test(collectErrorText(error).toLowerCase());

const resolveConnectionState = (state) => {
  if (state.connected) {
    return "connected";
  }
  if (state.mode === "degraded") {
    return "degraded";
  }
  if (state.authConfigured) {
    return "disconnected";
  }
  return "missing";
};

const createCapabilities = (state, settings) => {
  const authConfigured = Boolean(state.authConfigured);
  const connected = Boolean(state.connected);
  const onboardingConfigured = Boolean(settings.onboarding?.channelId);

  const commandSync = !authConfigured
    ? {
      status: "missing",
      detail: "Configure the Discord bot token and client id to register slash commands."
    }
    : state.syncError
      ? {
        status: "degraded",
        detail: state.syncError
      }
      : connected && settings.guildId
        ? {
          status: "available",
          detail: `Portal is connected and synced against guild ${settings.guildId}.`
        }
        : connected
          ? {
            status: "pending",
            detail: "Portal is connected, but slash commands will stay unsynced until a guild id is saved."
          }
          : {
            status: state.mode === "starting" ? "pending" : "disconnected",
            detail: state.error || "Portal is not connected to Discord."
          };

  const directMessages = !authConfigured
    ? {
      status: "missing",
      detail: "Configure the Discord bot token and client id to enable direct messages."
    }
    : connected
      ? {
        status: "available",
        detail: "Portal can receive direct messages, including the DM-only downloadall command."
      }
      : {
        status: state.mode === "starting" ? "pending" : "disconnected",
        detail: state.error || "Portal is not connected to Discord."
      };

  const onboarding = !onboardingConfigured
    ? {
      status: "disabled",
      detail: "Set an onboarding channel id to enable guild-join welcome posts."
    }
    : !authConfigured
      ? {
        status: "missing",
        detail: "Configure the Discord bot token and client id before enabling onboarding posts."
      }
      : connected && state.guildMemberEventsEnabled
        ? {
          status: "available",
          detail: "Portal can post the saved onboarding message when a guild member joins."
        }
        : connected
          ? {
            status: "degraded",
            detail: state.warning || "Portal connected without the Server Members intent, so automatic guild-join onboarding is unavailable."
          }
          : {
            status: state.mode === "starting" ? "pending" : "disconnected",
            detail: state.error || "Portal is not connected to Discord."
          };

  return {
    commandSync,
    directMessages,
    onboarding
  };
};

export const createPortalRuntime = ({
  config,
  sage,
  logger,
  clientFactory
}) => {
  const commands = createPortalCommands({
    sage,
    publicBaseUrl: config.publicBaseUrl
  });
  let settings = normalizePortalDiscordSettings({}, config.discordDefaults);
  let discord = null;
  let followNotifier = null;
  let state = {
    mode: config.discordToken && config.discordClientId ? "idle" : "disabled",
    connected: false,
    authConfigured: Boolean(config.discordToken && config.discordClientId),
    guildId: settings.guildId,
    registeredGuildId: "",
    error: null,
    syncError: null,
    warning: null,
    lastSyncAt: null,
    registeredCount: 0,
    guildMemberEventsEnabled: false
  };

  const roleManager = createRoleManager({
    getSettings: () => settings
  });

  const recordRuntimeEvent = (event = {}) => {
    if (!event?.type) {
      return;
    }

    if (event.type === "disconnect" || event.type === "login-error") {
      state = {
        ...state,
        connected: false,
        mode: "degraded",
        error: normalizeString(event.message || describeError(event.error)),
        syncError: null
      };
      return;
    }

    if (event.type === "command-sync-error") {
      state = {
        ...state,
        syncError: normalizeString(event.message || describeError(event.error))
      };
      return;
    }

    if (event.type === "client-error" || event.type === "shard-error") {
      const message = normalizeString(event.message || describeError(event.error));
      state = state.connected
        ? {
          ...state,
          warning: message || state.warning
        }
        : {
          ...state,
          mode: "degraded",
          error: message || state.error
        };
    }
  };

  const refreshSettings = async () => {
    const response = await sage.getDiscordSettings();
    if (response.ok) {
      settings = normalizePortalDiscordSettings(response.payload, config.discordDefaults);
    }
    state = {
      ...state,
      guildId: settings.guildId
    };
    if (discord && state.connected) {
      try {
        const sync = await discord.registerCommands();
        state = {
          ...state,
          lastSyncAt: new Date().toISOString(),
          registeredCount: sync.registered,
          registeredGuildId: sync.guildId || settings.guildId || "",
          syncError: null
        };
      } catch (error) {
        state = {
          ...state,
          syncError: describeError(error),
          registeredGuildId: settings.guildId || ""
        };
      }
    }
    return settings;
  };

  const startDiscordClient = async ({enableGuildMemberEvents}) => {
    const nextDiscord = await createDiscordClient({
      token: config.discordToken,
      clientId: config.discordClientId,
      commandMap: commands,
      roleManager,
      getSettings: () => settings,
      directMessageHandler: createDirectMessageHandler({
        getSettings: () => settings,
        sage,
        logger
      }),
      guildMemberAddHandler: enableGuildMemberEvents ? async (member) => {
        const channelId = settings.onboarding.channelId;
        if (!channelId) {
          return;
        }
        const content = renderTemplate(settings.onboarding.template, {
          username: member?.user?.username || "reader",
          user_mention: member?.user?.id ? `<@${member.user.id}>` : "",
          guild_name: member?.guild?.name || "",
          guild_id: member?.guild?.id || "",
          moon_url: config.publicBaseUrl
        });
        if (content) {
          await nextDiscord.sendChannelMessage(channelId, {content});
        }
      } : null,
      enableGuildMemberEvents,
      onRuntimeEvent: recordRuntimeEvent,
      logger,
      clientFactory
    });

    const sync = await nextDiscord.login();
    return {nextDiscord, sync};
  };

  const start = async () => {
    if (!config.discordToken || !config.discordClientId) {
      state = {
        ...state,
        mode: "disabled",
        connected: false,
        error: null,
        syncError: null,
        warning: null,
        guildMemberEventsEnabled: false
      };
      return state;
    }

    state = {
      ...state,
      mode: "starting",
      error: null,
      syncError: null,
      warning: null,
      registeredCount: 0,
      registeredGuildId: ""
    };
    await refreshSettings().catch(() => settings);

    const wantsGuildMemberEvents = Boolean(settings.onboarding.channelId);
    const attempts = wantsGuildMemberEvents
      ? [
        {enableGuildMemberEvents: true, warning: null},
        {
          enableGuildMemberEvents: false,
          warning: "Portal connected without the Server Members intent, so automatic guild-join onboarding is unavailable."
        }
      ]
      : [{enableGuildMemberEvents: false, warning: null}];

    for (const attempt of attempts) {
      try {
        const started = await startDiscordClient(attempt);
        discord = started.nextDiscord;
        followNotifier = createFollowNotifier({
          sage,
          discord,
          logger,
          publicBaseUrl: config.publicBaseUrl,
          requestCommand: commands.get("request")
        });
        followNotifier.start();
        state = {
          ...state,
          mode: "ready",
          connected: true,
          error: null,
          syncError: null,
          warning: attempt.warning,
          lastSyncAt: new Date().toISOString(),
          registeredCount: started.sync.registered,
          registeredGuildId: started.sync.guildId || settings.guildId || "",
          guildMemberEventsEnabled: attempt.enableGuildMemberEvents
        };
        return state;
      } catch (error) {
        await followNotifier?.stop?.();
        followNotifier = null;
        error?.portalClient?.destroy?.();
        discord?.destroy?.();
        discord = null;

        if (attempt.enableGuildMemberEvents && isGuildMemberIntentFailure(error)) {
          logger?.warn?.("Portal Discord runtime could not enable guild member events. Retrying in minimal Discord mode.", {
            error
          });
          state = {
            ...state,
            warning: "Portal connected without the Server Members intent, so automatic guild-join onboarding is unavailable."
          };
          continue;
        }

        state = {
          ...state,
          mode: "degraded",
          connected: false,
          error: error instanceof Error ? error.message : String(error),
          syncError: null,
          registeredGuildId: settings.guildId || "",
          guildMemberEventsEnabled: false
        };
        logger?.warn?.("Portal Discord runtime degraded into API-only mode.", {error});
        return state;
      }
    }

    return state;
  };

  const stop = async () => {
    followNotifier?.stop?.();
    followNotifier = null;
    discord?.destroy?.();
    discord = null;
    state = {
      ...state,
      connected: false,
      guildMemberEventsEnabled: false,
      mode: state.authConfigured ? "idle" : "disabled"
    };
  };

  const renderOnboarding = (payload = {}) => renderTemplate(
    normalizeString(payload.template || payload.settings?.onboarding?.template, settings.onboarding.template),
    {
      siteName: payload.siteName || payload.branding?.siteName || "Scriptarr",
      username: payload.username || "reader",
      user_mention: payload.userMention || payload.user_mention || "",
      guild_name: payload.guildName || payload.guild_name || "",
      guild_id: payload.guildId || payload.guild_id || payload.settings?.guildId || settings.guildId || "",
      moon_url: payload.moonUrl || payload.moon_url || config.publicBaseUrl
    }
  );

  const sendOnboardingTest = async (payload = {}) => {
    const channelId = normalizeString(payload.channelId || payload.settings?.onboarding?.channelId, settings.onboarding.channelId || "");
    if (!channelId) {
      throw new Error("An onboarding channel id is required.");
    }
    if (!discord || !state.connected) {
      throw new Error("Portal Discord runtime is not connected.");
    }
    const rendered = normalizeString(payload.rendered, renderOnboarding(payload));
    await discord.sendChannelMessage(channelId, {content: rendered});
    return {
      channelId,
      rendered
    };
  };

  return {
    start,
    stop,
    refreshSettings,
    getState() {
      const connectionState = resolveConnectionState(state);
      const commandInventory = buildCommandInventory({
        settings,
        registeredGuildId: state.registeredGuildId || settings.guildId || "",
        connectionState,
        commandSyncState: createCapabilities(state, settings).commandSync.status
      });
      return {
        ...state,
        settings,
        connectionState,
        capabilities: createCapabilities(state, settings),
        commands: commandInventory
      };
    },
    renderOnboarding,
    sendOnboardingTest
  };
};

export default createPortalRuntime;
