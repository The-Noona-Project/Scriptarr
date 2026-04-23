const DOWNLOAD_ALL_PATTERN = /^(?:\/|!)?downloadall\b/i;
const DOWNLOAD_ALL_TOKEN_PATTERN = /([a-z]+):(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
const ALLOWED_DOWNLOAD_ALL_KEYS = new Set(["type", "nsfw", "titlegroup"]);
const TYPE_ALIASES = new Map([
  ["manga", "Manga"],
  ["managa", "Manga"],
  ["manhwa", "Manhwa"],
  ["manhua", "Manhua"],
  ["oel", "OEL"]
]);

const normalizeString = (value) => typeof value === "string" ? value.trim() : "";

const isDownloadAllHelpRequest = (content) => {
  const trimmed = normalizeString(content);
  const commandMatch = trimmed.match(DOWNLOAD_ALL_PATTERN);
  if (!commandMatch) {
    return false;
  }

  const remainder = normalizeString(trimmed.slice(commandMatch[0].length)).toLowerCase();
  return ["help", "--help", "-h", "?"].includes(remainder);
};

const normalizeBoolean = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["true", "yes", "1", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "0", "off"].includes(normalized)) {
    return false;
  }
  return null;
};

const parseDownloadAllTokens = (raw) => {
  const parsed = new Map();
  const invalidSegments = [];
  let cursor = 0;

  for (const match of raw.matchAll(DOWNLOAD_ALL_TOKEN_PATTERN)) {
    const gap = raw.slice(cursor, match.index).trim();
    if (gap) {
      invalidSegments.push(gap);
    }
    cursor = match.index + match[0].length;

    const [, rawKey, doubleQuoted, singleQuoted, bare] = match;
    parsed.set(rawKey.toLowerCase(), normalizeString(doubleQuoted ?? singleQuoted ?? bare ?? ""));
  }

  const trailing = raw.slice(cursor).trim();
  if (trailing) {
    invalidSegments.push(trailing);
  }

  return {parsed, invalidSegments};
};

export const parseDownloadAllCommand = (content) => {
  const trimmed = normalizeString(content);
  const commandMatch = trimmed.match(DOWNLOAD_ALL_PATTERN);
  if (!commandMatch) {
    return {matched: false, valid: false, errors: []};
  }

  const remainder = trimmed.slice(commandMatch[0].length).trim();
  const {parsed, invalidSegments} = parseDownloadAllTokens(remainder);
  const errors = [];
  const unknownKeys = [...parsed.keys()].filter((key) => !ALLOWED_DOWNLOAD_ALL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    errors.push(`Unknown fields: ${unknownKeys.join(", ")}`);
  }
  if (invalidSegments.length > 0) {
    errors.push(`Could not parse: ${invalidSegments.join(" | ")}`);
  }

  const type = TYPE_ALIASES.get(normalizeString(parsed.get("type")).toLowerCase()) ?? null;
  if (!type) {
    errors.push("type must be one of: manga, manhwa, manhua, oel.");
  }
  const nsfw = normalizeBoolean(parsed.get("nsfw"));
  if (nsfw == null) {
    errors.push("nsfw must be true or false.");
  }
  const titlePrefix = normalizeString(parsed.get("titlegroup"));
  if (!titlePrefix) {
    errors.push("titlegroup is required.");
  }

  return {
    matched: true,
    valid: errors.length === 0,
    filters: type && nsfw != null && titlePrefix ? {type, nsfw, titlePrefix} : undefined,
    errors
  };
};

const formatValidationMessage = (errors = []) => {
  const lines = [
    "Use `downloadall type:manga nsfw:false titlegroup:a`",
    "Supported `type` values: manga, manhwa, manhua, oel.",
    "`nsfw` accepts true/false, yes/no, or 1/0.",
    "`titlegroup` is the title prefix Scriptarr should match."
  ];
  if (errors.length > 0) {
    lines.push("", `Problems: ${errors.join(" ")}`);
  }
  return lines.join("\n");
};

const formatTitleSection = (label, titles) => {
  const normalized = Array.isArray(titles)
    ? titles.map((entry) => normalizeString(entry)).filter(Boolean).slice(0, 10)
    : [];
  if (!normalized.length) {
    return null;
  }
  return `${label}:\n${normalized.map((title) => `- ${title}`).join("\n")}`;
};

export const formatBulkQueueSummary = (result = {}) => {
  const filters = result?.filters && typeof result.filters === "object" ? result.filters : {};
  const lines = [
    "Scriptarr bulk queue finished.",
    `Status: ${normalizeString(result?.status) || "unknown"}`,
    `Message: ${normalizeString(result?.message) || "No summary returned."}`,
    `Filters: type=${normalizeString(filters.type) || "unknown"}, nsfw=${String(filters.nsfw)}, titlegroup=${normalizeString(filters.titlePrefix) || "unknown"}`,
    `Pages scanned: ${Number.parseInt(String(result?.pagesScanned || 0), 10) || 0}`,
    `Matched: ${Number.parseInt(String(result?.matchedCount || 0), 10) || 0}`,
    `Queued: ${Number.parseInt(String(result?.queuedCount || 0), 10) || 0}`,
    `Skipped active: ${Number.parseInt(String(result?.skippedActiveCount || 0), 10) || 0}`,
    `Skipped adult content: ${Number.parseInt(String(result?.skippedAdultContentCount || 0), 10) || 0}`,
    `Skipped no metadata: ${Number.parseInt(String(result?.skippedNoMetadataCount || 0), 10) || 0}`,
    `Skipped ambiguous metadata: ${Number.parseInt(String(result?.skippedAmbiguousMetadataCount || 0), 10) || 0}`,
    `Failed: ${Number.parseInt(String(result?.failedCount || 0), 10) || 0}`
  ];

  return [
    lines.join("\n"),
    formatTitleSection("Queued titles (first 10)", result?.queuedTitles),
    formatTitleSection("Skipped active titles (first 10)", result?.skippedActiveTitles),
    formatTitleSection("Skipped adult content titles (first 10)", result?.skippedAdultContentTitles),
    formatTitleSection("Skipped no metadata titles (first 10)", result?.skippedNoMetadataTitles),
    formatTitleSection("Skipped ambiguous metadata titles (first 10)", result?.skippedAmbiguousMetadataTitles),
    formatTitleSection("Failed titles (first 10)", result?.failedTitles)
  ].filter(Boolean).join("\n\n");
};

const sendReply = async (message, payload) => {
  if (typeof message?.reply === "function") {
    return message.reply(typeof payload === "string" ? {content: payload} : payload);
  }
  if (typeof message?.channel?.send === "function") {
    return message.channel.send(typeof payload === "string" ? {content: payload} : payload);
  }
  return null;
};

const resolveBulkQueueFailure = (result) => {
  if (!result || typeof result !== "object" || result.ok !== false) {
    return "";
  }
  return normalizeString(result.payload?.error)
    || normalizeString(result.payload?.message)
    || `Sage returned ${normalizeString(result.status, "an error")}.`;
};

/**
 * Create the DM-only downloadall handler.
 *
 * @param {{getSettings: () => {superuserId?: string}, sage: ReturnType<import("../sageClient.mjs").createSageClient>, logger?: {warn?: Function}}} options
 * @returns {(message: any) => Promise<boolean>}
 */
export const createDirectMessageHandler = ({getSettings, sage, logger}) => async (message) => {
  if (!message || message?.author?.bot) {
    return false;
  }
  if (message.guildId || message?.inGuild?.()) {
    return false;
  }

  if (isDownloadAllHelpRequest(message.content)) {
    await sendReply(message, formatValidationMessage());
    return true;
  }

  const parsed = parseDownloadAllCommand(message.content);
  if (!parsed.matched) {
    return false;
  }

  const settings = typeof getSettings === "function" ? (getSettings() || {}) : {};
  const commandSettings = settings?.commands && typeof settings.commands === "object"
    ? settings.commands.downloadall || {}
    : {};
  const superuserId = normalizeString(settings?.superuserId);
  const authorId = normalizeString(message?.author?.id);
  if (commandSettings.enabled === false) {
    await sendReply(message, "The Scriptarr downloadall DM command is currently disabled.");
    return true;
  }
  if (!superuserId || authorId !== superuserId) {
    await sendReply(message, "This DM command is restricted to the configured Scriptarr superuser.");
    return true;
  }

  if (!parsed.valid || !parsed.filters) {
    await sendReply(message, formatValidationMessage(parsed.errors));
    return true;
  }

  await sendReply(
    message,
    `Queueing Scriptarr bulk download for type=${parsed.filters.type}, nsfw=${parsed.filters.nsfw}, titlegroup=${parsed.filters.titlePrefix}...`
  );

  try {
    const result = await sage.bulkQueueDownload({
      providerId: "weebcentral",
      ...parsed.filters,
      requestedBy: authorId
    });
    const failure = resolveBulkQueueFailure(result);
    if (failure) {
      throw new Error(failure);
    }
    await sendReply(message, formatBulkQueueSummary(result.payload || result));
  } catch (error) {
    logger?.warn?.("Portal DM downloadall failed.", {error: error?.message || String(error)});
    await sendReply(message, `Scriptarr bulk queue failed: ${error?.message || String(error)}`);
  }

  return true;
};

export default createDirectMessageHandler;
