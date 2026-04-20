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
  {id: "downloadall", name: "downloadall", description: "Bulk queue titles through a DM-only admin command.", mode: "dm"}
]);

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

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
  const requestedCommands = normalizeObject(source.commands, {}) || {};

  return {
    key: PORTAL_DISCORD_KEY,
    guildId: normalizeString(source.guildId),
    superuserId: normalizeString(source.superuserId),
    onboarding: {
      channelId: normalizeString(onboarding.channelId),
      template: normalizeString(onboarding.template, defaults.onboarding.template).slice(0, 1200)
    },
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
