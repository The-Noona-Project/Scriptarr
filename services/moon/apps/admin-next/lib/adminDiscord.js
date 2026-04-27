/**
 * @file Discord admin settings helpers.
 */

import {formatDisplayValue, normalizeString} from "./format.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = {}) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

export const DEFAULT_COMMANDS = ["ding", "status", "chat", "search", "request", "subscribe", "downloadall"];

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
      releaseChannelId: normalizeString(notifications.releaseChannelId)
    },
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
  normalizeDiscordSettings
};
