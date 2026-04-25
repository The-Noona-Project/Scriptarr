/**
 * Portal's Discord command catalog and registration helpers.
 */

export const portalCommandCatalog = Object.freeze([
  {name: "ding", label: "/ding", description: "Quick bot health reply.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild"},
  {name: "status", label: "/status", description: "Read-only Scriptarr runtime summary.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild"},
  {name: "chat", label: "/chat", description: "Portal chat bridge into Oracle.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild"},
  {name: "search", label: "/search", description: "Search the current Scriptarr library.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild"},
  {name: "request", label: "/request", description: "Search intake matches and file a moderated request.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild"},
  {name: "subscribe", label: "/subscribe", description: "Follow a library title for Discord notifications.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild"},
  {
    name: "downloadall",
    label: "/downloadall",
    description: "Owner-only DM bulk queue command.",
    scope: "Global DM slash command",
    mode: "slash",
    roleManaged: false,
    ownerOnly: true,
    dmOnly: true,
    legacyTextAlias: true,
    registrationScope: "global"
  }
]);

const commandByName = new Map(portalCommandCatalog.map((command) => [command.name, command]));

const isCommandEnabled = (settings, name) =>
  settings?.commands?.[name]?.enabled !== false;

/**
 * Normalize any supported command collection shape into a stable map.
 *
 * @param {Map<string, any> | Array<[string, any]> | Record<string, any>} commands
 * @returns {Map<string, any>}
 */
export const normalizeCommandMap = (commands = new Map()) => {
  if (commands instanceof Map) {
    return new Map(commands.entries());
  }
  if (Array.isArray(commands)) {
    return new Map(commands);
  }
  if (commands && typeof commands === "object") {
    return new Map(Object.entries(commands));
  }
  return new Map();
};

/**
 * Extract slash-command definitions from the command map, filtered through the
 * live Portal Discord settings.
 *
 * @param {Map<string, any>} commandMap
 * @param {{commands?: Record<string, {enabled?: boolean}>}} settings
 * @returns {any[]}
 */
export const extractCommandDefinitions = (commandMap = new Map(), settings = {}, registrationScope = "guild") =>
  Array.from(commandMap.entries())
    .filter(([name, command]) => {
      const descriptor = commandByName.get(name);
      return descriptor?.mode === "slash"
        && descriptor?.registrationScope === registrationScope
        && isCommandEnabled(settings, name);
    })
    .map(([, command]) => command?.definition)
    .filter(Boolean);

export const extractGuildDefinitions = (commandMap = new Map(), settings = {}) =>
  extractCommandDefinitions(commandMap, settings, "guild");

export const extractGlobalDefinitions = (commandMap = new Map(), settings = {}) =>
  extractCommandDefinitions(commandMap, settings, "global");

export const extractEnabledDefinitions = extractGuildDefinitions;

export const describeCommands = (commandMap = new Map()) =>
  Array.from(normalizeCommandMap(commandMap).entries()).map(([name, command]) => ({
    name,
    description: command?.definition?.description || commandByName.get(name)?.description || ""
  }));

/**
 * Build a user-facing runtime inventory for Moon admin and Portal health.
 *
 * @param {{
 *   settings?: {guildId?: string, commands?: Record<string, {enabled?: boolean, roleId?: string}>},
 *   registeredGuildId?: string,
 *   registeredGlobalCount?: number,
 *   connectionState?: string,
 *   commandSyncState?: string
 * }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export const buildCommandInventory = ({
  settings = {},
  registeredGuildId = "",
  registeredGlobalCount = 0,
  connectionState = "missing",
  commandSyncState = "pending"
} = {}) =>
  portalCommandCatalog.map((command) => ({
    ...command,
    enabled: isCommandEnabled(settings, command.name),
    roleId: command.roleManaged ? (settings?.commands?.[command.name]?.roleId || "") : "",
    registered: command.registrationScope === "global"
      ? isCommandEnabled(settings, command.name) && registeredGlobalCount > 0 && commandSyncState === "available"
      : isCommandEnabled(settings, command.name) && Boolean(registeredGuildId) && commandSyncState === "available",
    status: command.registrationScope === "global"
      ? registeredGlobalCount > 0
        ? "Registered"
        : commandSyncState === "degraded"
          ? "Sync issue"
          : connectionState === "connected"
            ? "Pending"
            : "Pending"
      : commandSyncState === "available" && Boolean(registeredGuildId)
        ? "Registered"
        : commandSyncState === "degraded"
          ? "Sync issue"
          : "Pending",
    guildId: command.registrationScope === "guild" ? registeredGuildId || settings?.guildId || "" : ""
  }));

export default {
  portalCommandCatalog,
  normalizeCommandMap,
  extractCommandDefinitions,
  extractGuildDefinitions,
  extractGlobalDefinitions,
  buildCommandInventory
};
