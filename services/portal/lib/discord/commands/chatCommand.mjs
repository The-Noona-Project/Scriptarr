import {interactionAiPayload, queueStatusText} from "../aiChatMessages.mjs";
import {createAiResponseQueue, isAiResponseQueueCancelError} from "../aiResponseQueue.mjs";
import {normalizeString, sendInteractionReply} from "../utils.mjs";

const defaultChatAiQueue = createAiResponseQueue();

const option = (name, description, required = false) => ({
  type: 3,
  name,
  description,
  required
});

export const createChatCommand = ({sage, aiQueue = defaultChatAiQueue}) => ({
  definition: {
    name: "chat",
    description: "Talk to Noona.",
    options: [
      option("message", "What you want to ask Noona.", true)
    ]
  },
  async execute(interaction) {
    await interaction.deferReply?.({flags: 64});
    const message = interaction.options?.getString?.("message") || "";
    const userId = interaction.user?.id || interaction.member?.user?.id || "";
    const member = interaction.member || {};
    const user = interaction.user || member.user || {};
    let response;
    try {
      response = await aiQueue.run(
        ({signal}) => sage.noonaChat({
          message,
          rawMessage: message,
          guildId: normalizeString(interaction.guildId || interaction.guild?.id),
          channelId: normalizeString(interaction.channelId || interaction.channel?.id),
          interactionId: normalizeString(interaction.id),
          user: {
            discordUserId: userId,
            username: normalizeString(user.username || member.displayName || user.globalName, "Discord Reader"),
            globalName: normalizeString(user.globalName),
            displayName: normalizeString(member.displayName || user.globalName || user.username),
            avatarUrl: typeof user.displayAvatarURL === "function" ? normalizeString(user.displayAvatarURL()) : normalizeString(user.avatarUrl)
          },
          memoryEnabled: true,
          proposalMode: "conservative"
        }, {signal}),
        {
          onQueued: ({ahead}) => sendInteractionReply(interaction, interactionAiPayload(queueStatusText(ahead), {
            userId,
            ephemeral: true
          })),
          onStart: ({ahead}) => ahead > 0
            ? sendInteractionReply(interaction, interactionAiPayload("Thinking...", {
              userId,
              ephemeral: true
            }))
            : null
        }
      );
    } catch (error) {
      if (isAiResponseQueueCancelError(error)) {
        return;
      }
      throw error;
    }
    await sendInteractionReply(interaction, {
      ...interactionAiPayload(response.ok
        ? response.payload?.reply || "Noona did not return a response."
        : response.status === 403
          ? response.payload?.reply || "You do not have Noona chat access yet."
          : response.payload?.error || "Noona is unavailable right now.", {
        userId,
        fallback: "Noona is unavailable right now.",
        ephemeral: true
      }),
      ephemeral: true
    });
  }
});
