import {interactionAiPayload, queueStatusText} from "../aiChatMessages.mjs";
import {createAiResponseQueue, isAiResponseQueueCancelError} from "../aiResponseQueue.mjs";
import {sendInteractionReply} from "../utils.mjs";

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
    let response;
    try {
      response = await aiQueue.run(
        ({signal}) => sage.chat({message}, {signal}),
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
        : response.payload?.error || "Noona is unavailable right now.", {
        userId,
        fallback: "Noona is unavailable right now.",
        ephemeral: true
      }),
      ephemeral: true
    });
  }
});
