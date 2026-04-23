import {MAX_VISIBLE_RESULTS, REQUEST_SESSION_TTL_MS} from "../constants.mjs";
import {createSessionStore} from "../sessionStore.mjs";
import {
  buildEphemeralContent,
  ensureDiscordIdentity,
  handleSessionButton
} from "../commandHelpers.mjs";
import {normalizeString, sendInteractionReply, truncate} from "../utils.mjs";

const option = (name, description, required = false) => ({
  type: 3,
  name,
  description,
  required
});

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;

const buildButtonRow = (buttons = []) => ({
  type: 1,
  components: buttons
});

const buildButton = ({customId, label, style = 2, disabled = false}) => ({
  type: 2,
  custom_id: customId,
  label,
  style,
  disabled
});

const normalizeMetadataResult = (entry = {}) => {
  const normalized = normalizeObject(entry) || {};
  return {
    provider: normalizeString(normalized.provider || normalized.providerId),
    providerName: normalizeString(normalized.providerName || normalized.provider),
    providerSeriesId: normalizeString(normalized.providerSeriesId || normalized.id),
    title: normalizeString(normalized.title || normalized.name, "Untitled"),
    summary: normalizeString(normalized.summary),
    aliases: normalizeArray(normalized.aliases),
    coverUrl: normalizeString(normalized.coverUrl),
    releaseLabel: normalizeString(normalized.releaseLabel),
    status: normalizeString(normalized.status),
    type: normalizeString(normalized.type, "manga"),
    url: normalizeString(normalized.url),
    tags: normalizeArray(normalized.tags)
  };
};

const buildMetadataPickerMessage = ({query, results, sessionId}) => {
  const visible = normalizeArray(results).slice(0, MAX_VISIBLE_RESULTS);
  const lines = visible.map((result, index) => {
    const aliases = result.aliases.length ? ` | ${truncate(result.aliases.join(", "), 42)}` : "";
    const release = result.releaseLabel ? ` | ${result.releaseLabel}` : "";
    const provider = result.providerName || result.provider || "metadata";
    const tags = result.tags.length ? ` | ${truncate(result.tags.join(", "), 32)}` : "";
    const link = result.url ? `\n   ${result.url}` : "";
    return `${index + 1}. ${truncate(result.title, 72)} | ${provider}${release}${aliases}${tags}${link}`;
  });
  const buttons = visible.map((result, index) => buildButton({
    customId: `portal:request-meta:${sessionId}:${index}`,
    label: `${index + 1}. ${truncate(result.title, 70)}`,
    style: 1
  }));
  return buildEphemeralContent(
    [
      `Pick the exact metadata result for "${query}":`,
      ...lines
    ].join("\n"),
    buttons.length ? [buildButtonRow(buttons)] : []
  );
};

const formatRequestResultMessage = (response, fallbackTitle) => {
  const payload = response?.payload || {};
  const title = normalizeString(payload.title, fallbackTitle || "Untitled");
  if (response?.ok) {
    return payload.status === "unavailable"
      ? `Saved **${title}** as **unavailable**. Scriptarr will keep re-checking for a source every 4 hours and DM you if one appears.`
      : `Request saved as **${normalizeString(payload.status, "pending")}** for **${title}**.`;
  }

  if (payload?.code === "REQUEST_ALREADY_IN_LIBRARY") {
    const link = normalizeString(payload.libraryTitle?.linkUrl);
    return link
      ? `**${normalizeString(payload.libraryTitle?.title, title)}** is already in the Scriptarr library.\nOpen it here: ${link}`
      : `${title} is already in the Scriptarr library.`;
  }

  if (payload?.code === "REQUEST_ALREADY_QUEUED") {
    const link = normalizeString(payload.linkUrl);
    return link
      ? `Scriptarr is already tracking **${normalizeString(payload.title, title)}**. You were attached to the notification waitlist and will get a Discord DM when it is ready.\nTrack it here: ${link}`
      : `Scriptarr is already tracking **${normalizeString(payload.title, title)}**. You were attached to the notification waitlist and will get a Discord DM when it is ready.`;
  }

  return payload?.error || "Unable to save that request right now.";
};

const finalizeDiscordRequest = async ({
  interaction,
  sage,
  query,
  notes,
  selectedMetadata,
  selectedDownload = null
}) => {
  const identity = await ensureDiscordIdentity({
    sage,
    interactionOrMessage: interaction
  });
  if (!identity.ok) {
    await sendInteractionReply(interaction, {
      content: identity.payload?.error || "Unable to resolve your Discord identity.",
      ephemeral: true,
      components: []
    });
    return;
  }

  const response = await sage.createDiscordRequest({
    source: "discord",
    requestedBy: interaction.user?.id,
    discordUserId: interaction.user?.id,
    username: interaction.user?.globalName || interaction.user?.username || "Discord Reader",
    avatarUrl: interaction.user?.displayAvatarURL?.() || "",
    query,
    notes,
    title: normalizeString(selectedMetadata?.title, normalizeString(selectedDownload?.titleName)),
    requestType: normalizeString(selectedDownload?.requestType || selectedMetadata?.type, "manga"),
    selectedMetadata,
    ...(selectedDownload ? {selectedDownload} : {})
  });

  await sendInteractionReply(interaction, {
    content: formatRequestResultMessage(response, selectedMetadata?.title || selectedDownload?.titleName),
    ephemeral: true,
    components: []
  });
};

export const createRequestCommand = ({sage}) => {
  const metadataStore = createSessionStore({ttlMs: REQUEST_SESSION_TTL_MS});

  return {
    definition: {
      name: "request",
      description: "Search metadata, pick the exact title, and create a moderated Scriptarr request.",
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

      const response = await sage.searchRequestMetadata(query);
      if (!response.ok) {
        await sendInteractionReply(interaction, {
          content: response.payload?.error || "Metadata search is unavailable right now.",
          ephemeral: true
        });
        return;
      }

      const results = normalizeArray(response.payload?.results || response.payload).map(normalizeMetadataResult)
        .filter((entry) => entry.provider && entry.providerSeriesId && entry.title);
      if (!results.length) {
        await sendInteractionReply(interaction, {
          content: `No metadata matches were found for "${query}".`,
          ephemeral: true
        });
        return;
      }

      const sessionId = metadataStore.create({
        discordUserId: interaction.user?.id,
        query,
        notes,
        results
      });
      await sendInteractionReply(interaction, buildMetadataPickerMessage({
        query,
        results,
        sessionId
      }));
    },
    async handleComponent(interaction) {
      const metadataHandled = await handleSessionButton({
        interaction,
        prefix: "portal:request-meta:",
        store: metadataStore,
        onSelect: async ({interaction: component, session, choice}) => {
          const selectedMetadata = normalizeMetadataResult(choice);
          await finalizeDiscordRequest({
            interaction: component,
            sage,
            query: session.query,
            notes: session.notes,
            selectedMetadata
          });
        }
      });
      if (metadataHandled) {
        return true;
      }

      return false;
    }
  };
};

export default createRequestCommand;
