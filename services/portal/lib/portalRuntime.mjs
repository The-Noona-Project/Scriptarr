import {createDiscordClient} from "./discord/client.mjs";
import {resolveDiscordBotIdentity} from "./discord/botIdentity.mjs";
import {buildCommandInventory, filterCommandMap} from "./discord/commandCatalog.mjs";
import {createPortalCommands} from "./discord/commands/index.mjs";
import {createAppaMentionHandler} from "./discord/appaMentionChat.mjs";
import {createDirectMessageHandler} from "./discord/directMessageRouter.mjs";
import {normalizeBrandName} from "./discord/branding.mjs";
import {createNoonaMentionHandler} from "./discord/noonaMentionChat.mjs";
import {createRoleManager} from "./discord/roleManager.mjs";
import {normalizePortalDiscordSettings} from "./discord/settings.mjs";
import {createTriviaRuntime} from "./discord/triviaRuntime.mjs";
import {normalizeString} from "./discord/utils.mjs";
import {buildReleaseChannelPayload, buildUpdateChannelPayload, createFollowNotifier} from "./followNotifier.mjs";

const renderTemplate = (template, values) => Object.entries(values).reduce(
  (current, [key, value]) => current.replaceAll(`{${key}}`, normalizeString(value)),
  normalizeString(template)
);

const describeError = (error) => error instanceof Error ? error.message : String(error ?? "");
const DOWNLOADALL_APPROVE_REACTION = "✅";
const DOWNLOADALL_DENY_REACTION = "❌";

const NOONA_SPLIT_COMMANDS = Object.freeze(["search", "request", "subscribe", "trivia"]);
const APPA_SPLIT_COMMANDS = Object.freeze(["ding", "status", "trivia", "discord", "downloadall"]);

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
  const triviaConfigured = Boolean(settings.trivia?.enabled && settings.trivia?.channelId);
  const noonaChatConfigured = Boolean(settings.noonaChat?.enabled);
  const updatePostsConfigured = Boolean(settings.notifications?.updateChannelId);
  const appaConfigured = Boolean(settings.appa?.enabled);
  const appaConnected = Boolean(state.appa?.connected);
  const appaAuthConfigured = Boolean(state.appa?.authConfigured);

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
        detail: "Portal can receive direct messages, including the owner-only DM-only WeebCentral /downloadall command."
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

  const trivia = !triviaConfigured
    ? {
      status: settings.trivia?.enabled ? "pending" : "disabled",
      detail: settings.trivia?.enabled
        ? "Set a trivia channel id to let Noona post trivia rounds."
        : "Discord trivia is disabled."
    }
    : !authConfigured
      ? {
        status: "missing",
        detail: "Configure the Discord bot token and client id before enabling trivia."
      }
      : connected
        ? {
          status: "available",
          detail: `Trivia rounds can post in channel ${settings.trivia.channelId}.`
        }
        : {
          status: state.mode === "starting" ? "pending" : "disconnected",
          detail: state.error || "Portal is not connected to Discord."
        };

  const noonaChat = !noonaChatConfigured
    ? {
      status: "disabled",
      detail: "Noona mention chat is disabled."
    }
    : !authConfigured
      ? {
        status: "missing",
        detail: "Configure the Discord bot token and client id before enabling Noona mention chat."
      }
    : connected
      ? {
        status: "available",
        detail: settings.noonaChat?.allowedChannelIds?.length
          ? `Noona can answer public mentions in ${settings.noonaChat.allowedChannelIds.length} configured channel(s). Message Content intent must also be enabled in Discord.`
          : "Noona can answer public mentions in any configured guild channel. Message Content intent must also be enabled in Discord."
      }
      : {
        status: state.mode === "starting" ? "pending" : "disconnected",
          detail: state.error || "Portal is not connected to Discord."
        };

  return {
    commandSync,
    directMessages,
    onboarding,
    trivia,
    noonaChat,
    appa: !appaConfigured
      ? {
        status: "disabled",
        detail: "Appa admin bot is disabled, so Noona keeps the admin command fallback."
      }
      : !appaAuthConfigured
        ? {
          status: "missing",
          detail: "Configure the Appa Discord token and client id before enabling the split admin bot."
        }
        : appaConnected
          ? {
            status: "available",
            detail: "Appa is connected for admin slash commands, admin mentions, downloadall DMs, and Noona review corrections."
          }
          : {
            status: state.appa?.mode === "starting" ? "pending" : "degraded",
            detail: state.appa?.error || "Appa is not connected to Discord."
          },
    updatePosts: !updatePostsConfigured
      ? {
        status: "disabled",
        detail: "Set an update channel id to let Noona post GitHub update summaries."
      }
      : connected
        ? {
          status: "available",
          detail: `Noona can post update summaries in channel ${settings.notifications.updateChannelId}.`
        }
        : {
          status: state.mode === "starting" ? "pending" : "disconnected",
          detail: state.error || "Portal is not connected to Discord."
        }
  };
};

export const createPortalRuntime = ({
  config,
  sage,
  logger,
  clientFactory
}) => {
  let settings = normalizePortalDiscordSettings({}, config.discordDefaults);
  let discord = null;
  let appaDiscord = null;
  let followNotifier = null;
  let triviaRuntime = null;
  const legacyBotIdentity = resolveDiscordBotIdentity(config.discordBotPersona);
  const noonaBotIdentity = resolveDiscordBotIdentity("noona");
  const appaBotIdentity = resolveDiscordBotIdentity("appa");
  let state = {
    mode: config.discordToken && config.discordClientId ? "idle" : "disabled",
    connected: false,
    authConfigured: Boolean(config.discordToken && config.discordClientId),
    splitEnabled: false,
    appa: {
      mode: config.appaDiscordToken && config.appaDiscordClientId ? "idle" : "disabled",
      connected: false,
      authConfigured: Boolean(config.appaDiscordToken && config.appaDiscordClientId),
      enabled: false,
      registeredGuildId: "",
      registeredCount: 0,
      registeredGlobalCount: 0,
      registeredGuildCount: 0,
      error: null,
      syncError: null,
      requestedIntents: [],
      requestedPartials: [],
      lastMentionAt: null,
      lastMentionChannelId: null,
      lastMentionUserId: null,
      lastMentionError: null,
      lastReviewAt: null,
      lastReviewVerdict: null,
      lastReviewSeverity: null,
      lastCorrectionAt: null,
      lastCorrectionError: null,
      lastBotAvatarSyncAt: null,
      lastBotAvatarSyncStatus: null,
      lastBotAvatarSyncError: null
    },
    guildId: settings.guildId,
    registeredGuildId: "",
    error: null,
    syncError: null,
    warning: null,
    lastSyncAt: null,
    registeredCount: 0,
    registeredGlobalCount: 0,
    registeredGuildCount: 0,
    guildMemberEventsEnabled: false,
    requestedIntents: [],
    requestedPartials: [],
    lastDirectMessageReceivedAt: null,
    lastDownloadAllHandledAt: null,
    lastDownloadAllError: null,
    lastDownloadAllSource: null,
    botIdentity: legacyBotIdentity.id,
    lastBotAvatarSyncAt: null,
    lastBotAvatarSyncStatus: null,
    lastBotAvatarSyncError: null,
    lastNoonaMentionAt: null,
    lastNoonaMentionChannelId: null,
    lastNoonaMentionUserId: null,
    lastNoonaMentionError: null
  };
  let brandName = "Scriptarr";

  const createCommands = (triviaSubcommandScope = "all") => createPortalCommands({
    sage,
    publicBaseUrl: config.publicBaseUrl,
    getBrandName: () => brandName,
    getSettings: () => settings,
    logger,
    onRuntimeEvent: (event) => recordRuntimeEvent(event),
    onTriviaStart: (payload) => triviaRuntime?.startRoundNow(payload),
    onTriviaStop: (payload) => triviaRuntime?.stopRound(payload),
    onTriviaLeaderboard: (windowName) => triviaRuntime?.postLeaderboard(windowName),
    triviaSubcommandScope
  });
  const commands = createCommands("all");
  const noonaCommands = filterCommandMap(createCommands("reader"), NOONA_SPLIT_COMMANDS);
  const appaCommands = filterCommandMap(createCommands("admin"), APPA_SPLIT_COMMANDS);

  const roleManager = createRoleManager({
    getSettings: () => settings
  });
  const appaRoleManager = createRoleManager({
    getSettings: () => settings,
    getCommandSettings: (currentSettings, commandName) => currentSettings?.appa?.commands?.[commandName] || {}
  });

  const isAppaSplitEnabled = () =>
    settings.appa?.enabled === true && Boolean(config.appaDiscordToken && config.appaDiscordClientId);

  const appaSettings = () => ({
    ...settings,
    commands: settings.appa?.commands || {}
  });

  const handleNoonaReviewCandidate = async (candidate = {}) => {
    if (!isAppaSplitEnabled() || settings.appa?.reviewEnabled === false || settings.appa?.correctionMode === "off" || !appaDiscord) {
      return;
    }
    const {message: _message, ...reviewPayload} = candidate;
    const result = await sage.reviewNoonaReply?.({
      ...reviewPayload,
      reviewEnabled: settings.appa.reviewEnabled,
      correctionMode: settings.appa.correctionMode
    });
    const payload = result?.payload || {};
    const decision = payload.decision || {};
    let corrected = false;
    let correctionError = "";
    if (result?.ok && payload.shouldCorrect && normalizeString(payload.correctionText || decision.correctionText)) {
      try {
        const correctionMessage = await appaDiscord.sendChannelMessage(candidate.channelId, {
          content: normalizeString(payload.correctionText || decision.correctionText),
          allowedMentions: {parse: [], repliedUser: false},
          ...(candidate.replyMessageId || candidate.messageId ? {messageReference: {messageId: candidate.replyMessageId || candidate.messageId}} : {})
        });
        await sage.recordNoonaReviewDelivery?.({
          guildId: candidate.guildId,
          channelId: candidate.channelId,
          messageId: candidate.messageId,
          replyMessageId: candidate.replyMessageId,
          correctionMessageId: normalizeString(correctionMessage?.id),
          delivered: true
        }).catch(() => null);
        corrected = true;
      } catch (error) {
        correctionError = describeError(error);
        await sage.recordNoonaReviewDelivery?.({
          guildId: candidate.guildId,
          channelId: candidate.channelId,
          messageId: candidate.messageId,
          replyMessageId: candidate.replyMessageId,
          delivered: false,
          error: correctionError
        }).catch(() => null);
        logger?.warn?.("Portal Appa correction post failed.", {error});
      }
    }
    recordRuntimeEvent({
      type: "appa-review",
      at: new Date().toISOString(),
      verdict: normalizeString(decision.verdict, payload.verdict),
      severity: normalizeString(decision.severity, payload.severity),
      corrected,
      error: correctionError || normalizeString(payload.error)
    });
  };

  const recordRuntimeEvent = (event = {}) => {
    if (!event?.type) {
      return;
    }

    if (event.type === "dm-message-received") {
      state = {
        ...state,
        lastDirectMessageReceivedAt: event.at || new Date().toISOString()
      };
      return;
    }

    if (event.type === "downloadall-handled") {
      state = {
        ...state,
        lastDownloadAllHandledAt: event.at || new Date().toISOString(),
        lastDownloadAllSource: normalizeString(event.source),
        ...(event.status === "started" ? {} : {lastDownloadAllError: null})
      };
      return;
    }

    if (event.type === "downloadall-error") {
      state = {
        ...state,
        lastDownloadAllHandledAt: event.at || new Date().toISOString(),
        lastDownloadAllSource: normalizeString(event.source),
        lastDownloadAllError: normalizeString(event.message)
      };
      return;
    }

    if (event.type === "downloadall-reaction") {
      state = {
        ...state,
        lastDownloadAllHandledAt: event.at || new Date().toISOString(),
        lastDownloadAllSource: "reaction",
        lastDownloadAllError: null
      };
      return;
    }

    if (event.type === "trivia-round-started") {
      state = {
        ...state,
        lastTriviaRoundStartedAt: event.at || new Date().toISOString(),
        lastTriviaRoundId: normalizeString(event.roundId)
      };
      return;
    }

    if (event.type === "avatar-sync") {
      if (event.clientIdentity === "appa") {
        state = {
          ...state,
          appa: {
            ...state.appa,
            lastBotAvatarSyncAt: event.at || new Date().toISOString(),
            lastBotAvatarSyncStatus: normalizeString(event.status),
            lastBotAvatarSyncError: event.status === "failed" ? normalizeString(event.reason) : null
          }
        };
        return;
      }
      state = {
        ...state,
        botIdentity: normalizeString(event.identity, legacyBotIdentity.id),
        lastBotAvatarSyncAt: event.at || new Date().toISOString(),
        lastBotAvatarSyncStatus: normalizeString(event.status),
        lastBotAvatarSyncError: event.status === "failed" ? normalizeString(event.reason) : null
      };
      return;
    }

    if (event.type === "appa-chat-handled") {
      state = {
        ...state,
        appa: {
          ...state.appa,
          lastMentionAt: event.at || new Date().toISOString(),
          lastMentionChannelId: normalizeString(event.channelId),
          lastMentionUserId: normalizeString(event.authorId),
          lastMentionError: null
        }
      };
      return;
    }

    if (event.type === "appa-chat-error") {
      state = {
        ...state,
        appa: {
          ...state.appa,
          lastMentionAt: event.at || new Date().toISOString(),
          lastMentionChannelId: normalizeString(event.channelId),
          lastMentionUserId: normalizeString(event.authorId),
          lastMentionError: normalizeString(event.message)
        }
      };
      return;
    }

    if (event.type === "appa-review") {
      state = {
        ...state,
        appa: {
          ...state.appa,
          lastReviewAt: event.at || new Date().toISOString(),
          lastReviewVerdict: normalizeString(event.verdict),
          lastReviewSeverity: normalizeString(event.severity),
          lastCorrectionAt: event.corrected ? event.at || new Date().toISOString() : state.appa.lastCorrectionAt,
          lastCorrectionError: event.error ? normalizeString(event.error) : null
        }
      };
      return;
    }

    if (event.type === "noona-chat-handled" || event.type === "noona-chat-rate-limited") {
      state = {
        ...state,
        lastNoonaMentionAt: event.at || new Date().toISOString(),
        lastNoonaMentionChannelId: normalizeString(event.channelId),
        lastNoonaMentionUserId: normalizeString(event.authorId),
        lastNoonaMentionError: null
      };
      return;
    }

    if (event.type === "noona-chat-error") {
      state = {
        ...state,
        lastNoonaMentionAt: event.at || new Date().toISOString(),
        lastNoonaMentionChannelId: normalizeString(event.channelId),
        lastNoonaMentionUserId: normalizeString(event.authorId),
        lastNoonaMentionError: normalizeString(event.message)
      };
      return;
    }

    if (event.type === "disconnect" || event.type === "login-error") {
      if (event.clientIdentity === "appa") {
        state = {
          ...state,
          appa: {
            ...state.appa,
            connected: false,
            mode: "degraded",
            error: normalizeString(event.message || describeError(event.error)),
            syncError: null
          }
        };
        return;
      }
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
      if (event.clientIdentity === "appa") {
        state = {
          ...state,
          appa: {
            ...state.appa,
            syncError: normalizeString(event.message || describeError(event.error))
          }
        };
        return;
      }
      state = {
        ...state,
        syncError: normalizeString(event.message || describeError(event.error))
      };
      return;
    }

    if (event.type === "client-error" || event.type === "shard-error") {
      const message = normalizeString(event.message || describeError(event.error));
      if (event.clientIdentity === "appa") {
        state = {
          ...state,
          appa: state.appa.connected
            ? {
              ...state.appa,
              warning: message || state.appa.warning
            }
            : {
              ...state.appa,
              mode: "degraded",
              error: message || state.appa.error
            }
        };
        return;
      }
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
    const [settingsResponse, brandingResponse] = await Promise.allSettled([
      sage.getDiscordSettings(),
      typeof sage.getBranding === "function" ? sage.getBranding() : Promise.resolve({ok: false, payload: null})
    ]);
    if (settingsResponse.status === "fulfilled" && settingsResponse.value.ok) {
      settings = normalizePortalDiscordSettings(settingsResponse.value.payload, config.discordDefaults);
    }
    if (brandingResponse.status === "fulfilled" && brandingResponse.value.ok) {
      brandName = normalizeBrandName(brandingResponse.value.payload?.siteName);
    }
    state = {
      ...state,
      guildId: settings.guildId
    };
    if (discord && state.connected) {
      try {
        const sync = await discord.registerCommands();
        let appaSync = null;
        if (appaDiscord && state.appa?.connected) {
          appaSync = await appaDiscord.registerCommands();
        }
        await triviaRuntime?.refreshSettings?.();
        state = {
          ...state,
          lastSyncAt: new Date().toISOString(),
          registeredCount: sync.registered,
          registeredGlobalCount: sync.registeredGlobal || 0,
          registeredGuildCount: sync.registeredGuild || 0,
          registeredGuildId: sync.guildId || settings.guildId || "",
          syncError: null,
          splitEnabled: isAppaSplitEnabled(),
          appa: {
            ...state.appa,
            enabled: settings.appa?.enabled === true,
            ...(appaSync ? {
              mode: "ready",
              connected: true,
              registeredCount: appaSync.registered,
              registeredGlobalCount: appaSync.registeredGlobal || 0,
              registeredGuildCount: appaSync.registeredGuild || 0,
              registeredGuildId: appaSync.guildId || settings.guildId || "",
              syncError: null
            } : {})
          }
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

  const startDiscordClient = async ({enableGuildMemberEvents, splitOverride = null}) => {
    let nextDiscord;
    const splitEnabled = splitOverride == null ? isAppaSplitEnabled() : Boolean(splitOverride);
    const noonaMentionHandler = createNoonaMentionHandler({
      getSettings: () => settings,
      getBotUserId: () => normalizeString(nextDiscord?.client?.user?.id),
      sage,
      roleManager,
      logger,
      onRuntimeEvent: recordRuntimeEvent,
      onReviewCandidate: handleNoonaReviewCandidate
    });
    nextDiscord = await createDiscordClient({
      token: config.discordToken,
      clientId: config.discordClientId,
      commandMap: splitEnabled ? noonaCommands : commands,
      roleManager,
      getSettings: () => settings,
      directMessageHandler: splitEnabled ? null : createDirectMessageHandler({
        getSettings: () => settings,
        sage,
        logger,
        onRuntimeEvent: recordRuntimeEvent
      }),
      guildMessageHandler: async (message) => {
        const handledByNoona = await noonaMentionHandler(message);
        if (!handledByNoona) {
          await triviaRuntime?.handleGuildMessage?.(message);
        }
      },
      reactionHandler: splitEnabled ? null : async (reaction, user) => {
        const emoji = normalizeString(reaction?.emoji?.name || reaction?.emoji || "");
        if (![DOWNLOADALL_APPROVE_REACTION, DOWNLOADALL_DENY_REACTION].includes(emoji)) {
          return;
        }
        const userId = normalizeString(user?.id);
        if (!userId || user?.bot || userId !== normalizeString(settings.superuserId)) {
          return;
        }
        const messageId = normalizeString(reaction?.message?.id || reaction?.messageId);
        if (!messageId) {
          return;
        }
        const result = await sage.decideDownloadAllPrompt({
          messageId,
          userId,
          emoji
        });
        const payload = result?.payload || {};
        if (payload.message) {
          await nextDiscord.sendDirectMessage(userId, {content: payload.message});
        }
        recordRuntimeEvent({
          type: "downloadall-reaction",
          requestedBy: userId,
          status: payload.status || (result?.ok ? "handled" : "failed"),
          message: payload.message || payload.error || ""
        });
      },
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
      botIdentity: splitEnabled ? noonaBotIdentity : legacyBotIdentity,
      avatarMode: config.discordAvatarMode,
      onRuntimeEvent: (event) => recordRuntimeEvent({...event, clientIdentity: "noona"}),
      logger,
      clientFactory
    });

    const sync = await nextDiscord.login();
    return {nextDiscord, sync};
  };

  const startAppaClient = async () => {
    let nextAppa;
    const appaMentionHandler = createAppaMentionHandler({
      getSettings: () => settings,
      getBotUserId: () => normalizeString(nextAppa?.client?.user?.id),
      sage,
      roleManager: appaRoleManager,
      logger,
      onRuntimeEvent: recordRuntimeEvent
    });
    nextAppa = await createDiscordClient({
      token: config.appaDiscordToken,
      clientId: config.appaDiscordClientId,
      commandMap: appaCommands,
      roleManager: appaRoleManager,
      getSettings: appaSettings,
      directMessageHandler: createDirectMessageHandler({
        getSettings: appaSettings,
        sage,
        logger,
        onRuntimeEvent: recordRuntimeEvent
      }),
      guildMessageHandler: appaMentionHandler,
      reactionHandler: async (reaction, user) => {
        const emoji = normalizeString(reaction?.emoji?.name || reaction?.emoji || "");
        if (![DOWNLOADALL_APPROVE_REACTION, DOWNLOADALL_DENY_REACTION].includes(emoji)) {
          return;
        }
        const userId = normalizeString(user?.id);
        if (!userId || user?.bot || userId !== normalizeString(settings.superuserId)) {
          return;
        }
        const messageId = normalizeString(reaction?.message?.id || reaction?.messageId);
        if (!messageId) {
          return;
        }
        const result = await sage.decideDownloadAllPrompt({
          messageId,
          userId,
          emoji
        });
        const payload = result?.payload || {};
        if (payload.message) {
          await nextAppa.sendDirectMessage(userId, {content: payload.message});
        }
        recordRuntimeEvent({
          type: "downloadall-reaction",
          requestedBy: userId,
          status: payload.status || (result?.ok ? "handled" : "failed"),
          message: payload.message || payload.error || ""
        });
      },
      enableGuildMemberEvents: false,
      botIdentity: appaBotIdentity,
      avatarMode: config.discordAvatarMode,
      onRuntimeEvent: (event) => recordRuntimeEvent({...event, clientIdentity: "appa"}),
      logger,
      clientFactory
    });
    const sync = await nextAppa.login();
    return {nextAppa, sync};
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
      splitEnabled: false,
      error: null,
      syncError: null,
      warning: null,
      registeredCount: 0,
      registeredGlobalCount: 0,
      registeredGuildCount: 0,
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
        let splitEnabled = isAppaSplitEnabled();
        let started = await startDiscordClient({...attempt, splitOverride: splitEnabled});
        discord = started.nextDiscord;
        let appaStarted = null;
        let appaStartError = "";
        if (splitEnabled) {
          try {
            appaStarted = await startAppaClient();
            appaDiscord = appaStarted.nextAppa;
          } catch (error) {
            appaStartError = describeError(error);
            error?.portalClient?.destroy?.();
            appaDiscord = null;
            logger?.warn?.("Portal Appa Discord runtime degraded while Noona stayed online.", {error});
            state = {
              ...state,
              appa: {
                ...state.appa,
                enabled: true,
                mode: "degraded",
                connected: false,
                error: appaStartError,
                syncError: null
              }
            };
            discord?.destroy?.();
            discord = null;
            splitEnabled = false;
            started = await startDiscordClient({...attempt, splitOverride: false});
            discord = started.nextDiscord;
          }
        }
        followNotifier = createFollowNotifier({
          sage,
          discord,
          adminDiscord: appaDiscord || null,
          logger,
          publicBaseUrl: config.publicBaseUrl,
          getBrandName: () => brandName,
          requestCommand: (splitEnabled ? noonaCommands : commands).get("request")
        });
        followNotifier.start();
        triviaRuntime = createTriviaRuntime({
          sage,
          discord,
          getSettings: () => settings,
          logger,
          onRuntimeEvent: recordRuntimeEvent
        });
        await triviaRuntime.start();
        state = {
          ...state,
          mode: "ready",
          connected: true,
          error: null,
          syncError: null,
          warning: attempt.warning,
          lastSyncAt: new Date().toISOString(),
          registeredCount: started.sync.registered,
          registeredGlobalCount: started.sync.registeredGlobal || 0,
          registeredGuildCount: started.sync.registeredGuild || 0,
          registeredGuildId: started.sync.guildId || settings.guildId || "",
          guildMemberEventsEnabled: attempt.enableGuildMemberEvents,
          requestedIntents: Array.isArray(started.nextDiscord.requestedIntents) ? [...started.nextDiscord.requestedIntents] : [],
          requestedPartials: Array.isArray(started.nextDiscord.requestedPartials) ? [...started.nextDiscord.requestedPartials] : [],
          splitEnabled,
          appa: {
            ...state.appa,
            enabled: settings.appa?.enabled === true,
            mode: appaStartError
              ? "degraded"
              : !splitEnabled
              ? (config.appaDiscordToken && config.appaDiscordClientId ? "idle" : "disabled")
              : appaStarted
                ? "ready"
                : state.appa.mode,
            connected: Boolean(appaStarted),
            authConfigured: Boolean(config.appaDiscordToken && config.appaDiscordClientId),
            registeredCount: appaStarted?.sync?.registered || 0,
            registeredGlobalCount: appaStarted?.sync?.registeredGlobal || 0,
            registeredGuildCount: appaStarted?.sync?.registeredGuild || 0,
            registeredGuildId: appaStarted?.sync?.guildId || (splitEnabled ? settings.guildId || "" : ""),
            requestedIntents: Array.isArray(appaStarted?.nextAppa?.requestedIntents) ? [...appaStarted.nextAppa.requestedIntents] : [],
            requestedPartials: Array.isArray(appaStarted?.nextAppa?.requestedPartials) ? [...appaStarted.nextAppa.requestedPartials] : [],
            error: appaStarted ? null : appaStartError || state.appa.error,
            syncError: appaStarted ? null : state.appa.syncError
          }
        };
        return state;
      } catch (error) {
        await followNotifier?.stop?.();
        followNotifier = null;
        triviaRuntime?.stop?.();
        triviaRuntime = null;
        error?.portalClient?.destroy?.();
        appaDiscord?.destroy?.();
        appaDiscord = null;
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
    triviaRuntime?.stop?.();
    triviaRuntime = null;
    appaDiscord?.destroy?.();
    appaDiscord = null;
    discord?.destroy?.();
    discord = null;
    state = {
      ...state,
      connected: false,
      guildMemberEventsEnabled: false,
      mode: state.authConfigured ? "idle" : "disabled",
      splitEnabled: false,
      appa: {
        ...state.appa,
        connected: false,
        mode: state.appa.authConfigured ? "idle" : "disabled"
      }
    };
  };

  const renderOnboarding = (payload = {}) => renderTemplate(
    normalizeString(payload.template || payload.settings?.onboarding?.template, settings.onboarding.template),
    {
      siteName: normalizeBrandName(payload.siteName || payload.branding?.siteName, brandName),
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

  const sendReleaseNotificationTest = async (payload = {}) => {
    const notification = payload.notification || {};
    const channelId = normalizeString(
      notification.channelId
      || payload.settings?.notifications?.releaseChannelId,
      settings.notifications?.releaseChannelId || ""
    );
    if (!channelId) {
      throw new Error("A release notification channel id is required.");
    }
    if (!discord || !state.connected) {
      throw new Error("Portal Discord runtime is not connected.");
    }
    const messagePayload = buildReleaseChannelPayload({
      ...notification,
      channelId
    }, config.publicBaseUrl);
    await discord.sendChannelMessage(channelId, messagePayload);
    return {
      channelId,
      notification: {
        ...notification,
        channelId
      }
    };
  };

  const sendUpdateNotificationTest = async (payload = {}) => {
    const notification = payload.notification || {};
    const channelId = normalizeString(
      notification.channelId
      || payload.settings?.notifications?.updateChannelId,
      settings.notifications?.updateChannelId || ""
    );
    if (!channelId) {
      throw new Error("An update notification channel id is required.");
    }
    if (!discord || !state.connected) {
      throw new Error("Portal Discord runtime is not connected.");
    }
    const messagePayload = buildUpdateChannelPayload({
      ...notification,
      channelId
    }, config.publicBaseUrl);
    await discord.sendChannelMessage(channelId, messagePayload);
    return {
      channelId,
      notification: {
        ...notification,
        channelId
      }
    };
  };

  const startTriviaRound = async (payload = {}) => {
    if (!triviaRuntime) {
      throw new Error("Portal Discord runtime is not connected.");
    }
    return triviaRuntime.startRoundNow(payload);
  };

  const stopTriviaRound = async (payload = {}) => {
    if (!triviaRuntime) {
      throw new Error("Portal Discord runtime is not connected.");
    }
    return triviaRuntime.stopRound(payload);
  };

  const postTriviaLeaderboard = async (payload = {}) => {
    if (!triviaRuntime) {
      throw new Error("Portal Discord runtime is not connected.");
    }
    const overrideSettings = payload.settings?.trivia || payload.settings || null;
    const targetChannelId = normalizeString(
      payload.channelId
      || overrideSettings?.leaderboardChannelId
      || overrideSettings?.channelId
      || settings.trivia?.leaderboardChannelId
      || settings.trivia?.channelId
    );
    if (!targetChannelId) {
      throw new Error("A trivia leaderboard channel id is required.");
    }
    const windowName = normalizeString(payload.window, "all");
    if (payload.defer === true) {
      void triviaRuntime.postLeaderboard(windowName, targetChannelId, {settings: overrideSettings || settings.trivia})
        .catch((error) => logger?.warn?.("Deferred trivia leaderboard post failed.", {windowName, error}));
      return {
        ok: true,
        accepted: true,
        queued: true,
        channelId: targetChannelId,
        window: windowName
      };
    }
    return triviaRuntime.postLeaderboard(windowName, targetChannelId, {settings: overrideSettings || settings.trivia});
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
        registeredGlobalCount: state.registeredGlobalCount || 0,
        connectionState,
        commandSyncState: createCapabilities(state, settings).commandSync.status,
        splitEnabled: state.splitEnabled,
        registeredAppaGuildId: state.appa?.registeredGuildId || settings.guildId || "",
        registeredAppaGlobalCount: state.appa?.registeredGlobalCount || 0,
        appaCommandSyncState: state.appa?.syncError ? "degraded" : state.appa?.connected ? "available" : "pending"
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
    sendOnboardingTest,
    sendReleaseNotificationTest,
    sendUpdateNotificationTest,
    startTriviaRound,
    stopTriviaRound,
    postTriviaLeaderboard
  };
};

export default createPortalRuntime;
