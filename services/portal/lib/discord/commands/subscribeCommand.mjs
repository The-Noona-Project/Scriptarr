import {
  createPickerMessage,
  ensureDiscordIdentity,
  handleSessionButton
} from "../commandHelpers.mjs";
import {REQUEST_SESSION_TTL_MS} from "../constants.mjs";
import {createSessionStore} from "../sessionStore.mjs";
import {normalizeString, sendInteractionReply} from "../utils.mjs";

const option = (name, description, required = false) => ({
  type: 3,
  name,
  description,
  required
});

export const createSubscribeCommand = ({sage}) => {
  const store = createSessionStore({ttlMs: REQUEST_SESSION_TTL_MS});

  return {
    definition: {
      name: "subscribe",
      description: "Follow a Scriptarr title for Discord notifications.",
      options: [
        option("title", "Library title to follow.", true)
      ]
    },
    async execute(interaction) {
      await interaction.deferReply?.({flags: 64});
      const query = normalizeString(interaction.options?.getString?.("title"));
      if (!query) {
        await sendInteractionReply(interaction, {
          content: "Provide a title to follow.",
          ephemeral: true
        });
        return;
      }

      const response = await sage.searchLibrary(query);
      if (!response.ok) {
        await sendInteractionReply(interaction, {
          content: response.payload?.error || "Library lookup is unavailable right now.",
          ephemeral: true
        });
        return;
      }

      const results = Array.isArray(response.payload?.results)
        ? response.payload.results
        : Array.isArray(response.payload?.titles)
          ? response.payload.titles
          : [];
      if (!results.length) {
        await sendInteractionReply(interaction, {
          content: `No library titles found for "${query}".`,
          ephemeral: true
        });
        return;
      }

      const sessionId = store.create({
        discordUserId: interaction.user?.id,
        query,
        results
      });
      await sendInteractionReply(interaction, createPickerMessage({
        heading: `Select the Scriptarr title to follow for "${query}":`,
        sessionId,
        action: "subscribe",
        results: results.map((entry) => ({...entry, availability: "available"})),
        kind: "available"
      }));
    },
    async handleComponent(interaction) {
      return handleSessionButton({
        interaction,
        prefix: "portal:subscribe:",
        store,
        onSelect: async ({interaction: component, choice}) => {
          const identity = await ensureDiscordIdentity({
            sage,
            interactionOrMessage: component
          });
          if (!identity.ok) {
            await sendInteractionReply(component, {
              content: identity.payload?.error || "Unable to resolve your Discord identity.",
              ephemeral: true,
              components: []
            });
            return;
          }

          const response = await sage.addFollowing({
            discordUserId: component.user?.id,
            titleId: normalizeString(choice.id || choice.titleId),
            title: normalizeString(choice.title),
            latestChapter: normalizeString(choice.latestChapter),
            mediaType: normalizeString(choice.mediaType || choice.requestType, "manga"),
            libraryTypeLabel: normalizeString(choice.libraryTypeLabel || choice.mediaType, "Manga"),
            libraryTypeSlug: normalizeString(choice.libraryTypeSlug || choice.mediaType, "manga")
          });

          await sendInteractionReply(component, {
            content: response.ok
              ? `Following **${normalizeString(choice.title, "Untitled")}** for Discord updates.`
              : response.payload?.error || "Unable to follow that title right now.",
            ephemeral: true,
            components: []
          });
        }
      });
    }
  };
};
