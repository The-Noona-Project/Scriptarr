/**
 * Portal's Discord command catalog and registration helpers.
 */

export const portalCommandCatalog = Object.freeze([
  {name: "ding", label: "/ding", description: "Quick bot health reply.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild", splitOwner: "appa"},
  {name: "status", label: "/status", description: "Read-only Scriptarr runtime summary.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild", splitOwner: "appa"},
  {name: "chat", label: "/chat", description: "Legacy single-bot Noona chat.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild", splitOwner: "legacy"},
  {name: "search", label: "/search", description: "Search the current Scriptarr library.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild", splitOwner: "noona"},
  {name: "request", label: "/request", description: "Search intake matches and file a moderated request.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild", splitOwner: "noona"},
  {name: "subscribe", label: "/subscribe", description: "Follow a library title for Discord notifications.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild", splitOwner: "noona"},
  {name: "trivia", label: "/trivia", description: "Play and manage Scriptarr title trivia.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild", splitOwner: "both"},
  {name: "discord", label: "/discord", description: "Appa-owned Discord channel diagnostics.", scope: "Guild slash command", mode: "slash", roleManaged: true, registrationScope: "guild", splitOwner: "appa"},
  {
    name: "downloadall",
    label: "/downloadall",
    description: "Owner-only DM-only WeebCentral downloadall run command.",
    scope: "Global DM slash command",
    mode: "slash",
    roleManaged: false,
    ownerOnly: true,
    dmOnly: true,
    legacyTextAlias: true,
    registrationScope: "global",
    splitOwner: "appa"
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

export const filterCommandMap = (commands = new Map(), names = []) => {
  const source = normalizeCommandMap(commands);
  const allowed = new Set(names);
  return new Map(Array.from(source.entries()).filter(([name]) => allowed.has(name)));
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
  commandSyncState = "pending",
  splitEnabled = false,
  registeredAppaGuildId = "",
  registeredAppaGlobalCount = 0,
  appaCommandSyncState = "pending"
} = {}) =>
  portalCommandCatalog.map((command) => {
    const noonaEnabled = isCommandEnabled(settings, command.name);
    const appaEnabled = settings?.appa?.commands?.[command.name]?.enabled !== false;
    const owner = splitEnabled ? command.splitOwner : "noona";
    const legacyHidden = splitEnabled && command.splitOwner === "legacy";
    const appaOwned = splitEnabled && command.splitOwner === "appa";
    const bothOwned = splitEnabled && command.splitOwner === "both";
    const noonaGuildRegistered = noonaEnabled && Boolean(registeredGuildId) && commandSyncState === "available";
    const appaGuildRegistered = appaEnabled && Boolean(registeredAppaGuildId) && appaCommandSyncState === "available";
    const noonaGlobalRegistered = noonaEnabled && registeredGlobalCount > 0 && commandSyncState === "available";
    const appaGlobalRegistered = appaEnabled && registeredAppaGlobalCount > 0 && appaCommandSyncState === "available";
    const noonaRegistered = command.registrationScope === "global" ? noonaGlobalRegistered : noonaGuildRegistered;
    const appaRegistered = command.registrationScope === "global" ? appaGlobalRegistered : appaGuildRegistered;
    const syncDegraded = commandSyncState === "degraded" || (splitEnabled && appaCommandSyncState === "degraded");
    const registered = legacyHidden
      ? false
      : appaOwned
        ? appaRegistered
        : bothOwned
          ? noonaRegistered && appaRegistered
          : noonaRegistered;
    const status = legacyHidden
      ? "Not registered in split mode"
      : appaOwned
        ? appaRegistered
          ? "Registered to Appa"
          : appaCommandSyncState === "degraded"
            ? "Appa sync issue"
            : "Pending"
        : bothOwned
          ? noonaRegistered && appaRegistered
            ? "Registered to Noona + Appa"
            : syncDegraded
              ? "Sync issue"
              : noonaRegistered
                ? "Noona synced, Appa pending"
                : appaRegistered
                  ? "Appa synced, Noona pending"
                  : "Pending"
          : noonaRegistered
            ? splitEnabled ? "Registered to Noona" : "Registered"
            : commandSyncState === "degraded"
              ? "Sync issue"
              : connectionState === "connected"
                ? "Pending"
                : "Pending";

    return {
      ...command,
      enabled: noonaEnabled,
      owner,
      appaEnabled,
      appaRoleId: settings?.appa?.commands?.[command.name]?.roleId || "",
      roleId: command.roleManaged ? (settings?.commands?.[command.name]?.roleId || "") : "",
      registered,
      status,
      guildId: command.registrationScope === "guild"
        ? appaOwned
          ? registeredAppaGuildId || settings?.guildId || ""
          : bothOwned && registeredAppaGuildId
            ? `${registeredGuildId || settings?.guildId || ""} / ${registeredAppaGuildId}`
            : registeredGuildId || settings?.guildId || ""
        : ""
    };
  });

export default {
  portalCommandCatalog,
  normalizeCommandMap,
  filterCommandMap,
  extractCommandDefinitions,
  extractGuildDefinitions,
  extractGlobalDefinitions,
  buildCommandInventory
};
