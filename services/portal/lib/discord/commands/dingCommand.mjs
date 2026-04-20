export const createDingCommand = () => ({
  definition: {
    name: "ding",
    description: "Check if the Scriptarr Discord bot is awake."
  },
  async execute(interaction) {
    await interaction.reply?.({
      content: "Dong! Scriptarr is online.",
      flags: 64
    });
  }
});
