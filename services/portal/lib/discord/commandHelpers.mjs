import {EPHEMERAL_FLAG, MAX_VISIBLE_RESULTS} from "./constants.mjs";
import {normalizeString, resolveDiscordId, respondWithError, truncate} from "./utils.mjs";

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

export const buildEphemeralContent = (content, components = []) => ({
  content,
  flags: EPHEMERAL_FLAG,
  components
});

export const buildMoonTitleUrl = (publicBaseUrl, result = {}) => {
  const baseUrl = normalizeString(publicBaseUrl);
  const titleId = normalizeString(result.id || result.titleId);
  const typeSlug = normalizeString(result.libraryTypeSlug || result.mediaType || "manga")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!baseUrl || !titleId) {
    return null;
  }
  return `${baseUrl}/title/${typeSlug || "manga"}/${encodeURIComponent(titleId)}`;
};

export const renderSearchResults = (title, results = [], publicBaseUrl) => {
  const visible = results.slice(0, MAX_VISIBLE_RESULTS);
  const lines = visible.map((entry, index) => {
    const url = buildMoonTitleUrl(publicBaseUrl, entry);
    const meta = [
      normalizeString(entry.libraryTypeLabel || entry.mediaType),
      normalizeString(entry.latestChapter),
      normalizeString(entry.status)
    ].filter(Boolean).join(" | ");
    const heading = `${index + 1}. ${truncate(normalizeString(entry.title, "Untitled"), 64)}`;
    return [
      heading,
      meta ? `   ${meta}` : null,
      url ? `   ${url}` : null
    ].filter(Boolean).join("\n");
  });

  if (!visible.length) {
    return `No Scriptarr library titles found for "${title}".`;
  }

  return [
    `Found ${results.length} Scriptarr ${results.length === 1 ? "match" : "matches"} for "${title}":`,
    ...lines,
    results.length > visible.length ? `Showing first ${visible.length} results.` : null
  ].filter(Boolean).join("\n");
};

export const createPickerMessage = ({
  heading,
  sessionId,
  action,
  results,
  kind
}) => {
  const visible = results.slice(0, MAX_VISIBLE_RESULTS);
  const lines = visible.map((entry, index) => {
    const availability = normalizeString(entry.availability || kind, kind || "available");
    const downloadProvider = normalizeString(entry.downloadProviderId);
    const typeLabel = normalizeString(entry.libraryTypeLabel || entry.type || entry.requestType);
    return `${index + 1}. ${truncate(normalizeString(entry.title || entry.canonicalTitle, "Untitled"), 64)}${typeLabel ? ` | ${typeLabel}` : ""}${downloadProvider ? ` | ${downloadProvider}` : ""}${availability ? ` | ${availability}` : ""}`;
  });

  const buttons = visible.map((entry, index) => buildButton({
    customId: `portal:${action}:${sessionId}:${index}`,
    label: `${index + 1}. ${truncate(normalizeString(entry.title || entry.canonicalTitle, "Option"), 70)}`,
    style: entry.availability === "download-ready" || entry.availability === "available" ? 1 : 2
  }));

  return buildEphemeralContent(
    [
      heading,
      ...lines
    ].join("\n"),
    buttons.length ? [buildButtonRow(buttons)] : []
  );
};

export const ensureDiscordIdentity = async ({sage, interactionOrMessage, username}) => {
  const discordUserId = resolveDiscordId(interactionOrMessage);
  if (!discordUserId) {
    return {
      ok: false,
      status: 400,
      payload: {error: "Could not resolve your Discord user id."}
    };
  }

  const normalizedUsername = normalizeString(
    username
    || interactionOrMessage?.user?.globalName
    || interactionOrMessage?.user?.username
    || interactionOrMessage?.author?.username
    || "Discord Reader"
  );

  return sage.upsertDiscordUser({
    discordUserId,
    username: normalizedUsername,
    avatarUrl: interactionOrMessage?.user?.displayAvatarURL?.() || interactionOrMessage?.author?.avatarURL?.() || null,
    role: "member"
  });
};

export const handleSessionButton = async ({
  interaction,
  prefix,
  store,
  onSelect
}) => {
  const customId = normalizeString(interaction?.customId);
  if (!customId.startsWith(prefix)) {
    return false;
  }

  const [, , sessionId, rawIndex] = customId.split(":");
  const session = store.read(sessionId);
  if (!session) {
    await respondWithError(interaction, "That selection expired. Run the command again.");
    return true;
  }
  if (resolveDiscordId(interaction) !== session.discordUserId) {
    await respondWithError(interaction, "Only the user who opened this selector can use it.");
    return true;
  }

  const index = Number.parseInt(String(rawIndex), 10);
  const choice = session.results[index];
  if (!choice) {
    await respondWithError(interaction, "That option is no longer available.");
    return true;
  }

  await onSelect({interaction, session, choice});
  store.delete(sessionId);
  return true;
};
