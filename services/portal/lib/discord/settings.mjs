import {PORTAL_COMMAND_NAMES} from "../config.mjs";

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeOptionalString = (value) => {
  const normalized = normalizeString(value);
  return normalized || null;
};
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
const normalizeInteger = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
};

const normalizeCommandSetting = (value = {}, fallback = {}) => ({
  enabled: value?.enabled ?? fallback?.enabled ?? true,
  roleId: normalizeOptionalString(value?.roleId ?? fallback.roleId)
});

const defaultTriviaSettings = Object.freeze({
  enabled: false,
  channelId: null,
  leaderboardChannelId: null,
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

const defaultNoonaChatSettings = Object.freeze({
  enabled: false,
  allowedChannelIds: [],
  memoryEnabled: true,
  publicReplies: true,
  proposalMode: "conservative"
});

const normalizeTriviaSettings = (value = {}, fallback = {}) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaults = {
    ...defaultTriviaSettings,
    ...(fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {}),
    leaderboardSchedules: {
      ...defaultTriviaSettings.leaderboardSchedules,
      ...(fallback?.leaderboardSchedules && typeof fallback.leaderboardSchedules === "object" ? fallback.leaderboardSchedules : {})
    }
  };
  const cooldownMin = normalizeInteger(source.cooldownMinMinutes, defaults.cooldownMinMinutes, 1, 1440);
  const cooldownMax = Math.max(cooldownMin, normalizeInteger(source.cooldownMaxMinutes, defaults.cooldownMaxMinutes, cooldownMin, 1440));
  const schedules = source.leaderboardSchedules && typeof source.leaderboardSchedules === "object" ? source.leaderboardSchedules : {};
  return {
    enabled: normalizeBoolean(source.enabled, defaults.enabled),
    channelId: normalizeOptionalString(source.channelId ?? defaults.channelId),
    leaderboardChannelId: normalizeOptionalString(source.leaderboardChannelId ?? defaults.leaderboardChannelId),
    roundDurationMinutes: normalizeInteger(source.roundDurationMinutes, defaults.roundDurationMinutes, 1, 240),
    cooldownMinMinutes: cooldownMin,
    cooldownMaxMinutes: cooldownMax,
    baseXp: normalizeInteger(source.baseXp, defaults.baseXp, 1, 10000),
    speedBonusMax: normalizeInteger(source.speedBonusMax, defaults.speedBonusMax, 0, 10000),
    streakBonusPerWin: normalizeInteger(source.streakBonusPerWin, defaults.streakBonusPerWin, 0, 10000),
    streakBonusMax: normalizeInteger(source.streakBonusMax, defaults.streakBonusMax, 0, 10000),
    hintsEnabled: normalizeBoolean(source.hintsEnabled, defaults.hintsEnabled),
    hintMinutes: (Array.isArray(source.hintMinutes) ? source.hintMinutes : defaults.hintMinutes)
      .map((entry) => normalizeInteger(entry, 0, 1, 240))
      .filter(Boolean)
      .slice(0, 4),
    aiMatchingEnabled: normalizeBoolean(source.aiMatchingEnabled, defaults.aiMatchingEnabled),
    leaderboardAfterRound: normalizeBoolean(source.leaderboardAfterRound, defaults.leaderboardAfterRound),
    leaderboardSchedules: {
      daily: normalizeBoolean(schedules.daily, defaults.leaderboardSchedules.daily),
      weekly: normalizeBoolean(schedules.weekly, defaults.leaderboardSchedules.weekly),
      monthly: normalizeBoolean(schedules.monthly, defaults.leaderboardSchedules.monthly),
      hour: normalizeInteger(schedules.hour, defaults.leaderboardSchedules.hour, 0, 23)
    }
  };
};

const normalizeNoonaChatSettings = (value = {}, fallback = {}) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaults = {
    ...defaultNoonaChatSettings,
    ...(fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {})
  };
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

export const normalizePortalDiscordSettings = (value = {}, defaults = {}) => {
  const nextCommands = {};
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalizedDefaults = defaults && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {};

  for (const commandName of PORTAL_COMMAND_NAMES) {
    nextCommands[commandName] = normalizeCommandSetting(
      source?.commands?.[commandName],
      normalizedDefaults?.commands?.[commandName]
    );
  }

  return {
    guildId: normalizeOptionalString(source?.guildId ?? normalizedDefaults?.guildId),
    superuserId: normalizeOptionalString(source?.superuserId ?? normalizedDefaults?.superuserId),
    onboarding: {
      channelId: normalizeOptionalString(source?.onboarding?.channelId ?? normalizedDefaults?.onboarding?.channelId),
      template: normalizeString(
        source?.onboarding?.template,
        normalizedDefaults?.onboarding?.template || "Welcome to Scriptarr, {username}."
      )
    },
    notifications: {
      releaseChannelId: normalizeOptionalString(source?.notifications?.releaseChannelId ?? normalizedDefaults?.notifications?.releaseChannelId),
      updateChannelId: normalizeOptionalString(source?.notifications?.updateChannelId ?? normalizedDefaults?.notifications?.updateChannelId)
    },
    trivia: normalizeTriviaSettings(source?.trivia, normalizedDefaults?.trivia),
    noonaChat: normalizeNoonaChatSettings(source?.noonaChat, normalizedDefaults?.noonaChat),
    commands: nextCommands
  };
};

export const buildCommandInventory = (settings, catalog = []) =>
  catalog.map((command) => ({
    name: command.name,
    description: command.description,
    enabled: settings?.commands?.[command.name]?.enabled !== false,
    roleId: settings?.commands?.[command.name]?.roleId || null
  }));
