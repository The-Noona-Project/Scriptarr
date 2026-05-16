import {renderSearchResults} from "../commandHelpers.mjs";
import {sendInteractionReply} from "../utils.mjs";
import {createBrandNameGetter} from "../branding.mjs";

const option = (name, description, required = false) => ({
  type: 3,
  name,
  description,
  required
});

export const createSearchCommand = ({sage, publicBaseUrl, getBrandName}) => {
  const brandName = createBrandNameGetter(getBrandName);
  return {
  definition: {
    name: "search",
    description: "Search the current Scriptarr library.",
    options: [
      option("title", "Title to search for in Scriptarr.", true)
    ]
  },
  async execute(interaction) {
    await interaction.deferReply?.({flags: 64});
    const title = interaction.options?.getString?.("title") || "";
    const response = await sage.searchLibrary(title);
    const siteName = brandName();
    await sendInteractionReply(interaction, {
      content: response.ok
        ? renderSearchResults(title, response.payload?.results || response.payload?.titles || [], publicBaseUrl, siteName)
        : response.payload?.error || "Library search is unavailable right now.",
      ephemeral: true
    });
  }
  };
};
