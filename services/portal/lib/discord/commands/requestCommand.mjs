import {
  createPickerMessage,
  ensureDiscordIdentity,
  handleSessionButton,
  resolveIntakeDownload,
  resolveIntakeMetadata,
  resolveIntakeRequestType,
  resolveIntakeTargetIdentity,
  resolveIntakeTitle
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

export const createRequestCommand = ({sage}) => {
  const store = createSessionStore({ttlMs: REQUEST_SESSION_TTL_MS});

  return {
    definition: {
      name: "request",
      description: "Search providers and create a moderated Scriptarr request.",
      options: [
        option("query", "Series title to request.", true),
        option("notes", "Optional request notes.", false)
      ]
    },
    async execute(interaction) {
      await interaction.deferReply?.({flags: 64});
      const query = normalizeString(interaction.options?.getString?.("query"));
      const notes = normalizeString(interaction.options?.getString?.("notes"));
      if (!query) {
        await sendInteractionReply(interaction, {
          content: "Provide a title to request.",
          ephemeral: true
        });
        return;
      }

      const response = await sage.searchIntake(query);
      if (!response.ok) {
        await sendInteractionReply(interaction, {
          content: response.payload?.error || "Request search is unavailable right now.",
          ephemeral: true
        });
        return;
      }

      const results = Array.isArray(response.payload?.results) ? response.payload.results : [];
      if (!results.length) {
        await sendInteractionReply(interaction, {
          content: `No metadata matches were found for "${query}".`,
          ephemeral: true
        });
        return;
      }

      const sessionId = store.create({
        discordUserId: interaction.user?.id,
        query,
        notes,
        results
      });
      await sendInteractionReply(interaction, createPickerMessage({
        heading: `Select the Scriptarr request result for "${query}":`,
        sessionId,
        action: "request",
        results
      }));
    },
    async handleComponent(interaction) {
      return handleSessionButton({
        interaction,
        prefix: "portal:request:",
        store,
        onSelect: async ({interaction: component, session, choice}) => {
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
          const targetIdentity = resolveIntakeTargetIdentity(choice);

          const response = await sage.createDiscordRequest({
            source: "discord",
            discordUserId: component.user?.id,
            username: component.user?.globalName || component.user?.username || "Discord Reader",
            query: session.query,
            notes: session.notes,
            title: resolveIntakeTitle(choice),
            selectedMetadata: resolveIntakeMetadata(choice),
            selectedDownload: resolveIntakeDownload(choice),
            requestType: resolveIntakeRequestType(choice),
            ...(targetIdentity ? {targetIdentity} : {})
          });

          await sendInteractionReply(component, {
            content: response.ok
              ? `Request saved as **${normalizeString(response.payload?.status, "pending")}** for **${normalizeString(response.payload?.title || resolveIntakeTitle(choice), "Untitled")}**.`
              : response.payload?.error || "Unable to create that request right now.",
            ephemeral: true,
            components: []
          });
        }
      });
    }
  };
};
