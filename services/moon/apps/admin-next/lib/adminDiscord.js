/**
 * @file Discord admin settings helpers.
 */

import {formatDisplayValue, normalizeString} from "./format.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = {}) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

export const DEFAULT_COMMANDS = ["ding", "status", "chat", "search", "request", "subscribe", "trivia", "downloadall"];
export const DEFAULT_APPA_COMMANDS = ["ding", "status", "trivia", "downloadall"];

const normalizeBoolean = (value, fallback = false) => typeof value === "boolean" ? value : fallback;
const normalizeInteger = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
};

/**
 * Normalize the public Noona mention-chat settings edited from `/admin/discord`.
 *
 * The server keeps `publicReplies` fixed for this version, so Moon renders the
 * value but never lets the browser switch to private replies.
 *
 * @param {unknown} value
 * @returns {{enabled: boolean, allowedChannelIds: string[], memoryEnabled: boolean, publicReplies: true, proposalMode: string}}
 */
export const normalizeNoonaChatSettings = (value = {}) => {
  const source = normalizeObject(value);
  return {
    enabled: normalizeBoolean(source.enabled, false),
    allowedChannelIds: normalizeArray(source.allowedChannelIds)
      .map((entry) => normalizeString(entry))
      .filter(Boolean),
    memoryEnabled: normalizeBoolean(source.memoryEnabled, true),
    publicReplies: true,
    proposalMode: normalizeString(source.proposalMode, "conservative") === "off" ? "off" : "conservative"
  };
};

export const normalizeAppaSettings = (value = {}) => {
  const source = normalizeObject(value);
  const commands = normalizeObject(source.commands);
  const commandIds = new Set([...DEFAULT_APPA_COMMANDS, ...Object.keys(commands)]);
  return {
    enabled: normalizeBoolean(source.enabled, false),
    adminMentionChannelIds: normalizeArray(source.adminMentionChannelIds)
      .map((entry) => normalizeString(entry))
      .filter(Boolean),
    reviewEnabled: normalizeBoolean(source.reviewEnabled, true),
    correctionMode: normalizeString(source.correctionMode, "serious") === "off" ? "off" : "serious",
    commands: Object.fromEntries(Array.from(commandIds).map((id) => {
      const command = normalizeObject(commands[id]);
      return [id, {
        enabled: command.enabled !== false,
        roleId: id === "downloadall" ? "" : normalizeString(command.roleId)
      }];
    }))
  };
};

export const normalizeTriviaSettings = (value = {}) => {
  const source = normalizeObject(value);
  const schedules = normalizeObject(source.leaderboardSchedules);
  const cooldownMin = normalizeInteger(source.cooldownMinMinutes, 30, 1, 1440);
  const cooldownMax = Math.max(cooldownMin, normalizeInteger(source.cooldownMaxMinutes, 180, cooldownMin, 1440));
  return {
    enabled: normalizeBoolean(source.enabled, false),
    channelId: normalizeString(source.channelId),
    leaderboardChannelId: normalizeString(source.leaderboardChannelId),
    roundDurationMinutes: normalizeInteger(source.roundDurationMinutes, 20, 1, 240),
    cooldownMinMinutes: cooldownMin,
    cooldownMaxMinutes: cooldownMax,
    baseXp: normalizeInteger(source.baseXp, 10, 1, 10000),
    speedBonusMax: normalizeInteger(source.speedBonusMax, 5, 0, 10000),
    streakBonusPerWin: normalizeInteger(source.streakBonusPerWin, 2, 0, 10000),
    streakBonusMax: normalizeInteger(source.streakBonusMax, 10, 0, 10000),
    hintsEnabled: normalizeBoolean(source.hintsEnabled, true),
    hintMinutes: (normalizeArray(source.hintMinutes).length ? normalizeArray(source.hintMinutes) : [7, 14])
      .map((entry) => normalizeInteger(entry, 0, 1, 240))
      .filter(Boolean)
      .slice(0, 4),
    aiMatchingEnabled: normalizeBoolean(source.aiMatchingEnabled, true),
    leaderboardAfterRound: normalizeBoolean(source.leaderboardAfterRound, true),
    leaderboardSchedules: {
      daily: normalizeBoolean(schedules.daily, true),
      weekly: normalizeBoolean(schedules.weekly, true),
      monthly: normalizeBoolean(schedules.monthly, true),
      hour: normalizeInteger(schedules.hour, 20, 0, 23)
    }
  };
};

/**
 * Normalize the Portal Discord settings draft.
 *
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
export const normalizeDiscordSettings = (value = {}) => {
  const source = normalizeObject(value);
  const onboarding = normalizeObject(source.onboarding);
  const notifications = normalizeObject(source.notifications);
  const commands = normalizeObject(source.commands);
  const commandIds = new Set([...DEFAULT_COMMANDS, ...Object.keys(commands)]);
  return {
    key: "portal.discord",
    guildId: normalizeString(source.guildId),
    superuserId: normalizeString(source.superuserId),
    onboarding: {
      channelId: normalizeString(onboarding.channelId),
      template: normalizeString(onboarding.template, "Welcome to {guild_name}, {user_mention}! Start reading at {moon_url}")
    },
    notifications: {
      releaseChannelId: normalizeString(notifications.releaseChannelId),
      updateChannelId: normalizeString(notifications.updateChannelId)
    },
    noonaChat: normalizeNoonaChatSettings(source.noonaChat),
    appa: normalizeAppaSettings(source.appa),
    trivia: normalizeTriviaSettings(source.trivia),
    commands: Object.fromEntries(Array.from(commandIds).map((id) => {
      const command = normalizeObject(commands[id]);
      return [id, {
        enabled: command.enabled !== false,
        roleId: id === "downloadall" ? "" : normalizeString(command.roleId)
      }];
    }))
  };
};

/**
 * Merge command catalog, runtime inventory, and draft settings into rows.
 *
 * @param {Record<string, any>} settings
 * @param {Array<Record<string, any>>} catalog
 * @param {Array<Record<string, any>>} inventory
 * @returns {Array<Record<string, any>>}
 */
export const buildDiscordCommandRows = (settings = {}, catalog = [], inventory = []) => {
  const byId = new Map();
  for (const entry of normalizeArray(catalog)) {
    const id = normalizeString(entry.id || entry.name);
    if (id) {
      byId.set(id, {...entry, id});
    }
  }
  for (const entry of normalizeArray(inventory)) {
    const id = normalizeString(entry.id || entry.name);
    if (id) {
      byId.set(id, {...byId.get(id), ...entry, id});
    }
  }
  for (const id of Object.keys(normalizeObject(settings.commands))) {
    if (!byId.has(id)) {
      byId.set(id, {id, name: id, label: `/${id}`});
    }
  }

  return Array.from(byId.values()).map((command) => {
    const id = normalizeString(command.id || command.name);
    const setting = normalizeObject(settings.commands?.[id]);
    const appaSetting = normalizeObject(settings.appa?.commands?.[id]);
    const roleManaged = command.roleManaged !== false && id !== "downloadall";
    return {
      id,
      name: normalizeString(command.name, id),
      label: normalizeString(command.label, `/${id}`),
      description: formatDisplayValue(command.description, "Discord command"),
      mode: normalizeString(command.mode, "slash"),
      scope: normalizeString(command.scope || command.registrationScope, "Guild slash command"),
      status: formatDisplayValue(command.status, command.registered ? "Registered" : "Pending"),
      registered: Boolean(command.registered),
      roleManaged,
      ownerOnly: Boolean(command.ownerOnly),
      owner: normalizeString(command.owner, command.splitOwner || "noona"),
      appaRoleManaged: Boolean(command.owner === "appa" || command.splitOwner === "appa" || command.owner === "both" || command.splitOwner === "both") && id !== "downloadall",
      appaEnabled: appaSetting.enabled !== false && command.appaEnabled !== false,
      appaRoleId: normalizeString(appaSetting.roleId || command.appaRoleId),
      enabled: setting.enabled !== false,
      roleId: roleManaged ? normalizeString(setting.roleId || command.roleId) : ""
    };
  }).sort((left, right) => {
    if (left.ownerOnly !== right.ownerOnly) {
      return left.ownerOnly ? 1 : -1;
    }
    return left.label.localeCompare(right.label);
  });
};

export default {
  buildDiscordCommandRows,
  normalizeAppaSettings,
  normalizeNoonaChatSettings,
  normalizeDiscordSettings
};
