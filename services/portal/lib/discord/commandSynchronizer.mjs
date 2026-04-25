/**
 * Sync Portal's slash-command definitions across global DM and guild scopes.
 */

/**
 * @param {unknown[]} definitions
 * @returns {unknown[]}
 */
const normalizeDefinitions = (definitions = []) => Array.isArray(definitions) ? definitions.filter(Boolean) : [];

/**
 * @param {{
 *   commandManager?: {set?: Function},
 *   guildId?: string,
 *   guildDefinitions?: unknown[],
 *   globalDefinitions?: unknown[]
 * }} options
 * @returns {Promise<{registered: number, registeredGuild: number, registeredGlobal: number, guildId: string}>}
 */
export const syncPortalCommands = async ({
  commandManager,
  guildId,
  guildDefinitions = [],
  globalDefinitions = []
} = {}) => {
  if (!commandManager || typeof commandManager.set !== "function") {
    throw new Error("Discord application command manager is unavailable.");
  }

  const normalizedGlobalDefinitions = normalizeDefinitions(globalDefinitions);
  const normalizedGuildDefinitions = normalizeDefinitions(guildDefinitions);

  await commandManager.set(normalizedGlobalDefinitions);
  if (guildId) {
    await commandManager.set(normalizedGuildDefinitions, guildId);
  }

  return {
    registered: normalizedGlobalDefinitions.length + (guildId ? normalizedGuildDefinitions.length : 0),
    registeredGlobal: normalizedGlobalDefinitions.length,
    registeredGuild: guildId ? normalizedGuildDefinitions.length : 0,
    guildId: guildId || ""
  };
};

export const syncGuildCommands = async ({
  commandManager,
  guildId,
  definitions = []
} = {}) => syncPortalCommands({
  commandManager,
  guildId,
  guildDefinitions: definitions,
  globalDefinitions: []
});

export default syncPortalCommands;
