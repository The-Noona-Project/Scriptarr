import {createBrandNameGetter} from "../branding.mjs";

export const createDingCommand = ({getBrandName} = {}) => {
  const brandName = createBrandNameGetter(getBrandName);
  return {
  definition: {
    name: "ding",
    description: "Check if the Scriptarr Discord bot is awake."
  },
  async execute(interaction) {
    await interaction.reply?.({
      content: `Dong! ${brandName()} is online.`,
      flags: 64
    });
  }
  };
};
