import {sendInteractionReply} from "../utils.mjs";

const option = (name, description, required = false) => ({
  type: 3,
  name,
  description,
  required
});

export const createChatCommand = ({sage}) => ({
  definition: {
    name: "chat",
    description: "Talk to Noona through Oracle.",
    options: [
      option("message", "What you want to ask Noona.", true)
    ]
  },
  async execute(interaction) {
    await interaction.deferReply?.({flags: 64});
    const message = interaction.options?.getString?.("message") || "";
    const response = await sage.chat({message});
    await sendInteractionReply(interaction, {
      content: response.ok
        ? response.payload?.reply || "Noona did not return a response."
        : response.payload?.error || "Noona is unavailable right now.",
      ephemeral: true
    });
  }
});
