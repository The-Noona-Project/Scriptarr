import {renderSearchResults} from "../commandHelpers.mjs";
import {sendInteractionReply} from "../utils.mjs";

const option = (name, description, required = false) => ({
  type: 3,
  name,
  description,
  required
});

export const createSearchCommand = ({sage, publicBaseUrl}) => ({
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
    await sendInteractionReply(interaction, {
      content: response.ok
        ? renderSearchResults(title, response.payload?.results || response.payload?.titles || [], publicBaseUrl)
        : response.payload?.error || "Library search is unavailable right now.",
      ephemeral: true
    });
  }
});
