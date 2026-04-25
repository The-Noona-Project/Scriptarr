import {respondWithError, sendInteractionReply} from "./utils.mjs";

export const createInteractionHandler = ({
  commandMap,
  roleManager,
  logger
}) => async (interaction) => {
  if (interaction?.isButton?.()) {
    for (const [commandName, command] of commandMap.entries()) {
      if (typeof command?.handleComponent !== "function") {
        continue;
      }

      try {
        const handled = await command.handleComponent(interaction);
        if (handled) {
          return;
        }
      } catch (error) {
        logger?.error?.("Portal component handler failed.", {commandName, error});
        await sendInteractionReply(interaction, {
          content: "Something went wrong while processing that action.",
          ephemeral: true,
          components: []
        }).catch(() => {});
        return;
      }
    }
    return;
  }

  if (!interaction?.isChatInputCommand?.()) {
    return;
  }

  const commandName = interaction.commandName;
  const command = commandMap.get(commandName);
  if (!command?.execute) {
    await respondWithError(interaction, `/${commandName || "unknown"} is not available right now.`);
    return;
  }

  const access = roleManager.checkAccess(interaction, commandName, command);
  if (!access.allowed) {
    await respondWithError(interaction, access.message);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    logger?.error?.("Portal slash command failed.", {commandName, error});
    await respondWithError(interaction, "Something went wrong while processing that command.");
  }
};
