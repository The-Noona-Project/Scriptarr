/**
 * Sync Portal's active slash-command definitions to the configured guild.
 */

/**
 * @param {{
 *   commandManager?: {set?: Function},
 *   guildId?: string,
 *   definitions?: unknown[],
 *   clearGlobalBeforeRegister?: boolean,
 *   clearBeforeRegister?: boolean
 * }} options
 * @returns {Promise<{clearedGlobal: boolean, cleared: boolean, registered: number, guildId: string}>}
 */
export const syncGuildCommands = async ({
  commandManager,
  guildId,
  definitions = [],
  clearGlobalBeforeRegister = true,
  clearBeforeRegister = true
} = {}) => {
  if (!commandManager || typeof commandManager.set !== "function") {
    throw new Error("Discord application command manager is unavailable.");
  }

  if (clearGlobalBeforeRegister) {
    await commandManager.set([]);
  }

  if (guildId && clearBeforeRegister) {
    await commandManager.set([], guildId);
  }

  const normalizedDefinitions = Array.isArray(definitions) ? definitions.filter(Boolean) : [];
  if (guildId && normalizedDefinitions.length > 0) {
    await commandManager.set(normalizedDefinitions, guildId);
  }

  return {
    clearedGlobal: clearGlobalBeforeRegister,
    cleared: clearBeforeRegister,
    registered: normalizedDefinitions.length,
    guildId: guildId || ""
  };
};

export default syncGuildCommands;
