/**
 * @file Scriptarr Sage module: services/sage/lib/portalDiscordSettings.mjs.
 */

export const PORTAL_DISCORD_KEY = "portal.discord";

export const knownPortalDiscordCommands = Object.freeze([
  {id: "ding", name: "ding", description: "Simple bot health reply.", mode: "slash"},
  {id: "status", name: "status", description: "Read-only Scriptarr status summary.", mode: "slash"},
  {id: "chat", name: "chat", description: "Talk to Noona through Oracle.", mode: "slash"},
  {id: "search", name: "search", description: "Search the current Scriptarr library.", mode: "slash"},
  {id: "request", name: "request", description: "Create a moderated Scriptarr request from Discord.", mode: "slash"},
  {id: "subscribe", name: "subscribe", description: "Follow a title for release notifications.", mode: "slash"},
  {id: "trivia", name: "trivia", description: "Play and manage Scriptarr title trivia.", mode: "slash"},
  {id: "downloadall", name: "downloadall", description: "Owner-only DM-only WeebCentral downloadall run command.", mode: "dm"}
]);

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const normalizeBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const normalizeInteger = (value, fallback, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
};

/**
 * Build default Discord trivia settings.
 *
 * @returns {Record<string, unknown>}
 */
export const defaultPortalTriviaSettings = () => ({
  enabled: false,
  channelId: "",
  leaderboardChannelId: "",
  roundDurationMinutes: 20,
  cooldownMinMinutes: 30,
  cooldownMaxMinutes: 180,
  baseXp: 10,
  speedBonusMax: 5,
  streakBonusPerWin: 2,
  streakBonusMax: 10,
  hintsEnabled: true,
  hintMinutes: [7, 14],
  aiMatchingEnabled: true,
  leaderboardAfterRound: true,
  leaderboardSchedules: {
    daily: true,
    weekly: true,
    monthly: true,
    hour: 20
  }
});

/**
 * Build default Noona public mention-chat settings.
 *
 * @returns {Record<string, unknown>}
 */
export const defaultPortalNoonaChatSettings = () => ({
  enabled: false,
  allowedChannelIds: [],
  memoryEnabled: true,
  publicReplies: true,
  proposalMode: "conservative"
});

/**
 * Normalize persisted Discord trivia settings for Portal.
 *
 * @param {Record<string, unknown>} value
 * @returns {ReturnType<typeof defaultPortalTriviaSettings>}
 */
export const normalizePortalTriviaSettings = (value = {}) => {
  const defaults = defaultPortalTriviaSettings();
  const source = normalizeObject(value, {}) || {};
  const cooldownMin = normalizeInteger(source.cooldownMinMinutes, defaults.cooldownMinMinutes, {min: 1, max: 1440});
  const cooldownMax = Math.max(
    cooldownMin,
    normalizeInteger(source.cooldownMaxMinutes, defaults.cooldownMaxMinutes, {min: cooldownMin, max: 1440})
  );
  const schedules = normalizeObject(source.leaderboardSchedules, {}) || {};
  const hintMinutes = Array.isArray(source.hintMinutes)
    ? source.hintMinutes
      .map((entry) => normalizeInteger(entry, 0, {min: 1, max: 240}))
      .filter(Boolean)
      .slice(0, 4)
    : defaults.hintMinutes;
  return {
    enabled: normalizeBoolean(source.enabled, defaults.enabled),
    channelId: normalizeString(source.channelId),
    leaderboardChannelId: normalizeString(source.leaderboardChannelId),
    roundDurationMinutes: normalizeInteger(source.roundDurationMinutes, defaults.roundDurationMinutes, {min: 1, max: 240}),
    cooldownMinMinutes: cooldownMin,
    cooldownMaxMinutes: cooldownMax,
    baseXp: normalizeInteger(source.baseXp, defaults.baseXp, {min: 1, max: 10000}),
    speedBonusMax: normalizeInteger(source.speedBonusMax, defaults.speedBonusMax, {min: 0, max: 10000}),
    streakBonusPerWin: normalizeInteger(source.streakBonusPerWin, defaults.streakBonusPerWin, {min: 0, max: 10000}),
    streakBonusMax: normalizeInteger(source.streakBonusMax, defaults.streakBonusMax, {min: 0, max: 10000}),
    hintsEnabled: normalizeBoolean(source.hintsEnabled, defaults.hintsEnabled),
    hintMinutes,
    aiMatchingEnabled: normalizeBoolean(source.aiMatchingEnabled, defaults.aiMatchingEnabled),
    leaderboardAfterRound: normalizeBoolean(source.leaderboardAfterRound, defaults.leaderboardAfterRound),
    leaderboardSchedules: {
      daily: normalizeBoolean(schedules.daily, defaults.leaderboardSchedules.daily),
      weekly: normalizeBoolean(schedules.weekly, defaults.leaderboardSchedules.weekly),
      monthly: normalizeBoolean(schedules.monthly, defaults.leaderboardSchedules.monthly),
      hour: normalizeInteger(schedules.hour, defaults.leaderboardSchedules.hour, {min: 0, max: 23})
    }
  };
};

/**
 * Normalize Noona mention-chat settings from the shared Discord settings row.
 *
 * @param {unknown} value
 * @returns {ReturnType<typeof defaultPortalNoonaChatSettings>}
 */
export const normalizePortalNoonaChatSettings = (value = {}) => {
  const defaults = defaultPortalNoonaChatSettings();
  const source = normalizeObject(value, {}) || {};
  const proposalMode = normalizeString(source.proposalMode, defaults.proposalMode).toLowerCase();
  return {
    enabled: normalizeBoolean(source.enabled, defaults.enabled),
    allowedChannelIds: (Array.isArray(source.allowedChannelIds) ? source.allowedChannelIds : defaults.allowedChannelIds)
      .map((entry) => normalizeString(entry))
      .filter(Boolean)
      .slice(0, 25),
    memoryEnabled: normalizeBoolean(source.memoryEnabled, defaults.memoryEnabled),
    publicReplies: true,
    proposalMode: proposalMode === "off" ? "off" : "conservative"
  };
};

/**
 * Build the default brokered Discord settings used by Portal and Moon admin.
 *
 * @returns {{
 *   key: string,
 *   guildId: string,
 *   superuserId: string,
 *   onboarding: {
 *     channelId: string,
 *     template: string
 *   },
 *   notifications: {
 *     releaseChannelId: string,
 *     updateChannelId: string
 *   },
 *   trivia: ReturnType<typeof defaultPortalTriviaSettings>,
 *   noonaChat: ReturnType<typeof defaultPortalNoonaChatSettings>,
 *   commands: Record<string, {enabled: boolean, roleId: string}>
 * }}
 */
export const defaultPortalDiscordSettings = () => ({
  key: PORTAL_DISCORD_KEY,
  guildId: "",
  superuserId: "",
  onboarding: {
    channelId: "",
    template: "Welcome to {guild_name}, {user_mention}! Start reading at {moon_url}"
  },
  notifications: {
    releaseChannelId: "",
    updateChannelId: ""
  },
  trivia: defaultPortalTriviaSettings(),
  noonaChat: defaultPortalNoonaChatSettings(),
  commands: Object.fromEntries(knownPortalDiscordCommands.map((command) => [
    command.id,
    {
      enabled: true,
      roleId: ""
    }
  ]))
});

/**
 * Normalize persisted or inbound Portal Discord settings into the stable
 * broker contract used by Sage, Vault, Moon, and Portal.
 *
 * @param {unknown} value
 * @returns {ReturnType<typeof defaultPortalDiscordSettings>}
 */
export const normalizePortalDiscordSettings = (value) => {
  const defaults = defaultPortalDiscordSettings();
  const source = normalizeObject(value, {}) || {};
  const onboarding = normalizeObject(source.onboarding, {}) || {};
  const notifications = normalizeObject(source.notifications, {}) || {};
  const requestedCommands = normalizeObject(source.commands, {}) || {};

  return {
    key: PORTAL_DISCORD_KEY,
    guildId: normalizeString(source.guildId),
    superuserId: normalizeString(source.superuserId),
    onboarding: {
      channelId: normalizeString(onboarding.channelId),
      template: normalizeString(onboarding.template, defaults.onboarding.template).slice(0, 1200)
    },
    notifications: {
      releaseChannelId: normalizeString(notifications.releaseChannelId),
      updateChannelId: normalizeString(notifications.updateChannelId)
    },
    trivia: normalizePortalTriviaSettings(source.trivia),
    noonaChat: normalizePortalNoonaChatSettings(source.noonaChat),
    commands: Object.fromEntries(knownPortalDiscordCommands.map((command) => {
      const requested = normalizeObject(requestedCommands[command.id], {}) || {};
      return [command.id, {
        enabled: typeof requested.enabled === "boolean" ? requested.enabled : defaults.commands[command.id].enabled,
        roleId: command.id === "downloadall" ? "" : normalizeString(requested.roleId)
      }];
    }))
  };
};

/**
 * Load the normalized Portal Discord settings from Vault through Sage.
 *
 * @param {{getSetting: (key: string) => Promise<{value?: unknown} | null>}} vaultClient
 * @returns {Promise<ReturnType<typeof defaultPortalDiscordSettings>>}
 */
export const readPortalDiscordSettings = async (vaultClient) => {
  const setting = await vaultClient.getSetting(PORTAL_DISCORD_KEY);
  return normalizePortalDiscordSettings(setting?.value ?? defaultPortalDiscordSettings());
};

/**
 * Render the brokered onboarding template for previews and test sends.
 *
 * @param {{
 *   template?: string,
 *   username?: string,
 *   userMention?: string,
 *   siteName?: string,
 *   guildName?: string,
 *   guildId?: string,
 *   moonUrl?: string
 * }} options
 * @returns {string}
 */
export const renderPortalOnboardingTemplate = ({
  template,
  username = "reader",
  userMention = "",
  siteName = "Scriptarr",
  guildName = "Your Discord Server",
  guildId = "",
  moonUrl = "https://your-scriptarr.example"
} = {}) => {
  const resolvedTemplate = normalizeString(template, defaultPortalDiscordSettings().onboarding.template);
  const resolvedMention = normalizeString(userMention, `<@${normalizeString(username, "reader")}>`);
  let rendered = resolvedTemplate
    .replaceAll("{siteName}", normalizeString(siteName, "Scriptarr"))
    .replaceAll("{username}", normalizeString(username, "reader"))
    .replaceAll("{user_mention}", resolvedMention)
    .replaceAll("{guild_name}", normalizeString(guildName, "Your Discord Server"))
    .replaceAll("{guild_id}", normalizeString(guildId))
    .replaceAll("{moon_url}", normalizeString(moonUrl, "https://your-scriptarr.example"));

  return rendered.trim();
};
