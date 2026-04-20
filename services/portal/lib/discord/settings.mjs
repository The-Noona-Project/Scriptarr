import {PORTAL_COMMAND_NAMES} from "../config.mjs";

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeOptionalString = (value) => {
  const normalized = normalizeString(value);
  return normalized || null;
};

const normalizeCommandSetting = (value = {}, fallback = {}) => ({
  enabled: value?.enabled ?? fallback?.enabled ?? true,
  roleId: normalizeOptionalString(value?.roleId ?? fallback.roleId)
});

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
