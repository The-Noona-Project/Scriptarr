import {
  DOWNLOAD_ALL_ALLOWED_KEYS,
  DOWNLOAD_ALL_PATTERN,
  DOWNLOAD_ALL_TOKEN_PATTERN,
  DOWNLOAD_ALL_TYPE_ALIASES
} from "./constants.mjs";

const normalizeString = (value) => typeof value === "string" ? value.trim() : "";

export const isDownloadAllHelpRequest = (content) => {
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

const normalizeTitleGroup = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "all") {
    return "all";
  }
  return /^[a-z]$/.test(normalized) ? normalized : "";
};

const isMegaDownloadAllFilters = (filters = {}) =>
  normalizeString(filters.type).toLowerCase() === "all"
  || normalizeString(filters.titlePrefix).toLowerCase() === "all";

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
  const unknownKeys = [...parsed.keys()].filter((key) => !DOWNLOAD_ALL_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    errors.push(`Unknown fields: ${unknownKeys.join(", ")}`);
  }
  if (invalidSegments.length > 0) {
    errors.push(`Could not parse: ${invalidSegments.join(" | ")}`);
  }

  const type = DOWNLOAD_ALL_TYPE_ALIASES.get(normalizeString(parsed.get("type")).toLowerCase()) ?? null;
  if (!type) {
    errors.push("type must be one of: manga, manhwa, manhua, oel, all.");
  }
  const nsfw = normalizeBoolean(parsed.get("nsfw"));
  if (nsfw == null) {
    errors.push("nsfw must be true or false.");
  }
  const titlePrefix = normalizeTitleGroup(parsed.get("titlegroup"));
  if (!titlePrefix) {
    errors.push("titlegroup must be one letter a-z or all.");
  }

  return {
    matched: true,
    valid: errors.length === 0,
    filters: type && nsfw != null && titlePrefix ? {type, nsfw, titlePrefix} : undefined,
    errors
  };
};

export const formatDownloadAllUsage = (errors = []) => {
  const lines = [
    "Use `/downloadall run type:manga nsfw:false titlegroup:a` in a DM with Noona.",
    "Use `type:all` or `titlegroup:all` for an async mega run that pauses after each batch.",
    "Manage mega runs with `/downloadall status runid:<id>`, `/downloadall continue runid:<id>`, or `/downloadall cancel runid:<id>`.",
    "Use `/downloadall help` to show this guide again.",
    "Legacy fallback: `downloadall type:manga nsfw:false titlegroup:a`.",
    "Supported `type` values: manga, manhwa, manhua, oel, all.",
    "`nsfw` accepts true/false, yes/no, or 1/0.",
    "`titlegroup` is the title prefix Scriptarr should match: a-z or all."
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

export const formatBulkRunSummary = (result = {}) => {
  const filters = result?.filters && typeof result.filters === "object" ? result.filters : {};
  const counts = result?.counts && typeof result.counts === "object" ? result.counts : {};
  const runId = normalizeString(result?.runId || result?.id);
  const currentBatch = result?.currentBatch && typeof result.currentBatch === "object" ? result.currentBatch : null;
  const lines = [
    "Scriptarr downloadall mega run updated.",
    `Run ID: ${runId || "unknown"}`,
    `Status: ${normalizeString(result?.status) || "unknown"}`,
    `Message: ${normalizeString(result?.message) || "No summary returned."}`,
    `Filters: provider=weebcentral, type=${normalizeString(filters.type) || "unknown"}, nsfw=${String(filters.nsfw)}, titlegroup=${normalizeString(filters.titlePrefix || filters.titlegroup) || "unknown"}`,
    `Batches completed: ${Number.parseInt(String(counts.completedBatches ?? result?.completedBatches ?? 0), 10) || 0}`,
    `Batches remaining: ${Number.parseInt(String(counts.remainingBatches ?? result?.remainingBatches ?? 0), 10) || 0}`,
    `Queued: ${Number.parseInt(String(counts.queued ?? result?.queuedCount ?? 0), 10) || 0}`,
    `Skipped: ${Number.parseInt(String(counts.skipped ?? result?.skippedCount ?? 0), 10) || 0}`,
    `Failed: ${Number.parseInt(String(counts.failed ?? result?.failedCount ?? 0), 10) || 0}`
  ];
  if (currentBatch) {
    lines.push(
      `Current batch: type=${normalizeString(currentBatch.type) || "unknown"}, titlegroup=${normalizeString(currentBatch.titlePrefix || currentBatch.titlegroup) || "unknown"}`
    );
  }
  if (normalizeString(result?.status).toLowerCase() === "paused") {
    lines.push(`Next step: use /downloadall continue runid:${runId || "<id>"} when you want the next batch.`);
  }
  return lines.join("\n");
};

const resolveBulkQueueFailure = (result) => {
  if (!result || typeof result !== "object" || result.ok !== false) {
    return "";
  }
  return normalizeString(result.payload?.error)
    || normalizeString(result.payload?.message)
    || `Sage returned ${normalizeString(result.status, "an error")}.`;
};

export const resolveDownloadAllAccess = ({
  settings = {},
  requestedBy = "",
  requireDm = false,
  isDirectMessage = true
} = {}) => {
  const commandSettings = settings?.commands && typeof settings.commands === "object"
    ? settings.commands.downloadall || {}
    : {};
  const superuserId = normalizeString(settings?.superuserId);
  const authorId = normalizeString(requestedBy);

  if (commandSettings.enabled === false) {
    return {
      allowed: false,
      reason: "disabled",
      message: "The Scriptarr downloadall command is currently disabled."
    };
  }

  if (requireDm && !isDirectMessage) {
    return {
      allowed: false,
      reason: "dm",
      message: "This command only works in a direct message with Noona."
    };
  }

  if (!superuserId || authorId !== superuserId) {
    return {
      allowed: false,
      reason: "owner",
      message: "This command is restricted to the configured Scriptarr owner."
    };
  }

  return {
    allowed: true,
    commandSettings,
    superuserId
  };
};

export const executeDownloadAll = async ({
  getSettings,
  sage,
  logger,
  onRuntimeEvent,
  requestedBy,
  filters,
  source = "unknown"
} = {}) => {
  const settings = typeof getSettings === "function" ? (getSettings() || {}) : {};
  const access = resolveDownloadAllAccess({
    settings,
    requestedBy,
    requireDm: false,
    isDirectMessage: true
  });
  if (!access.allowed) {
    const error = new Error(access.message);
    error.code = access.reason;
    throw error;
  }

  logger?.info?.("Portal downloadall started.", {
    requestedBy: normalizeString(requestedBy),
    filters,
    source
  });
  onRuntimeEvent?.({
    type: "downloadall-handled",
    source,
    requestedBy: normalizeString(requestedBy),
    filters,
    status: "started"
  });

  try {
    const payload = {
      providerId: "weebcentral",
      ...filters,
      requestedBy: normalizeString(requestedBy)
    };
    const result = isMegaDownloadAllFilters(filters)
      ? await sage.createBulkRun(payload)
      : await sage.bulkQueueDownload(payload);
    const failure = resolveBulkQueueFailure(result);
    if (failure) {
      throw new Error(failure);
    }
    logger?.info?.("Portal downloadall completed.", {
      requestedBy: normalizeString(requestedBy),
      status: result?.payload?.status || result?.status || "unknown",
      source
    });
    onRuntimeEvent?.({
      type: "downloadall-handled",
      source,
      requestedBy: normalizeString(requestedBy),
      filters,
      status: "completed"
    });
    return result;
  } catch (error) {
    logger?.warn?.("Portal downloadall failed.", {
      requestedBy: normalizeString(requestedBy),
      source,
      error: error?.message || String(error)
    });
    onRuntimeEvent?.({
      type: "downloadall-error",
      source,
      requestedBy: normalizeString(requestedBy),
      filters,
      message: error?.message || String(error)
    });
    throw error;
  }
};

export const executeDownloadAllRunAction = async ({
  getSettings,
  sage,
  requestedBy,
  runId,
  action = "status"
} = {}) => {
  const settings = typeof getSettings === "function" ? (getSettings() || {}) : {};
  const access = resolveDownloadAllAccess({
    settings,
    requestedBy,
    requireDm: false,
    isDirectMessage: true
  });
  if (!access.allowed) {
    const error = new Error(access.message);
    error.code = access.reason;
    throw error;
  }

  const normalizedRunId = normalizeString(runId);
  if (!normalizedRunId) {
    throw new Error("runid is required.");
  }

  if (action === "continue" || action === "resume") {
    return sage.continueBulkRun(normalizedRunId, {requestedBy: normalizeString(requestedBy)});
  }
  if (action === "cancel") {
    return sage.cancelBulkRun(normalizedRunId, {requestedBy: normalizeString(requestedBy)});
  }
  return sage.getBulkRunStatus(normalizedRunId);
};

export default {
  executeDownloadAll,
  executeDownloadAllRunAction,
  formatBulkQueueSummary,
  formatBulkRunSummary,
  formatDownloadAllUsage,
  isDownloadAllHelpRequest,
  parseDownloadAllCommand,
  resolveDownloadAllAccess
};
