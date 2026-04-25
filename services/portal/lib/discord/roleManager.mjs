/**
 * Apply guild and per-command role gates using the live brokered Portal
 * Discord settings.
 */

const normalizeString = (value) => typeof value === "string" ? value.trim() : "";

const resolveGuildId = (interaction) =>
  interaction?.guildId
  ?? interaction?.guild?.id
  ?? interaction?.member?.guild?.id
  ?? null;

const hasRoleInCollection = (collection, roleId) => {
  if (!collection || !roleId) {
    return false;
  }
  if (typeof collection.has === "function") {
    try {
      return collection.has(roleId);
    } catch {
      return false;
    }
  }
  if (typeof collection.get === "function") {
    try {
      return collection.get(roleId) != null;
    } catch {
      return false;
    }
  }
  if (Array.isArray(collection)) {
    return collection.includes(roleId);
  }
  if (collection instanceof Set || collection instanceof Map) {
    return collection.has(roleId);
  }
  if (typeof collection === "object") {
    return Object.hasOwn(collection, roleId);
  }
  return false;
};

const memberHasRole = (member, roleId) => {
  if (!roleId) {
    return true;
  }
  if (!member) {
    return false;
  }
  const sources = [];
  if (member.roles) {
    sources.push(member.roles);
    if (member.roles.cache) {
      sources.push(member.roles.cache);
    }
  }
  if (Array.isArray(member?._roles)) {
    sources.push(member._roles);
  }
  sources.push(member);
  return sources.some((source) => hasRoleInCollection(source, roleId));
};

const resolveUserId = (interaction) =>
  interaction?.user?.id
  ?? interaction?.member?.user?.id
  ?? null;

/**
 * Create Portal's settings-backed Discord role manager.
 *
 * @param {{getSettings: () => {guildId?: string, superuserId?: string, commands?: Record<string, {enabled?: boolean, roleId?: string}>}}} options
 * @returns {{checkAccess: (interaction: any, commandName: string, command?: any) => {allowed: boolean, message?: string, reason?: string}}}
 */
export const createRoleManager = ({getSettings}) => ({
  checkAccess(interaction, commandName, command = {}) {
    const settings = typeof getSettings === "function" ? (getSettings() || {}) : {};
    const commandSettings = settings?.commands?.[commandName] || {};
    if (commandSettings.enabled === false) {
      return {
        allowed: false,
        reason: "disabled",
        message: "This command is currently disabled."
      };
    }

    const isDirectMessage = !resolveGuildId(interaction);
    if (command?.access?.dmOnly && !isDirectMessage) {
      return {
        allowed: false,
        reason: "dm",
        message: "This command only works in a direct message with Noona."
      };
    }

    if (command?.access?.ownerOnly) {
      const requiredOwnerId = normalizeString(settings?.superuserId);
      if (!requiredOwnerId || resolveUserId(interaction) !== requiredOwnerId) {
        return {
          allowed: false,
          reason: "owner",
          message: "This command is restricted to the configured Scriptarr owner."
        };
      }
    }

    if (command?.access?.dmOnly) {
      return {
        allowed: true,
        requiredGuildId: "",
        requiredRoleId: ""
      };
    }

    const requiredGuildId = normalizeString(settings?.guildId);
    if (requiredGuildId && resolveGuildId(interaction) !== requiredGuildId) {
      return {
        allowed: false,
        reason: "guild",
        message: "This command can only be used inside the configured Discord server."
      };
    }

    const requiredRoleId = normalizeString(commandSettings.roleId);
    if (requiredRoleId && !memberHasRole(interaction?.member, requiredRoleId)) {
      return {
        allowed: false,
        reason: "role",
        message: "You do not have permission to use this command."
      };
    }

    return {
      allowed: true,
      requiredGuildId,
      requiredRoleId
    };
  }
});

export default createRoleManager;
