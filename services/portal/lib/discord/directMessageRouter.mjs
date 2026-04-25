import {
  executeDownloadAll,
  formatBulkQueueSummary,
  formatDownloadAllUsage,
  isDownloadAllHelpRequest,
  parseDownloadAllCommand,
  resolveDownloadAllAccess
} from "./downloadAllShared.mjs";

const normalizeString = (value) => typeof value === "string" ? value.trim() : "";

const splitContentChunk = (chunk, maxLength) => {
  if (chunk.length <= maxLength) {
    return [chunk];
  }

  const parts = [];
  let remaining = chunk;
  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex < 0) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex < 1) {
      splitIndex = maxLength;
    }
    parts.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
};

const splitMessageContent = (content, maxLength = 1800) => {
  const normalized = normalizeString(content);
  if (!normalized) {
    return [];
  }

  const chunks = [];
  let current = "";
  for (const section of normalized.split(/\n{2,}/)) {
    const trimmed = section.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = current ? `${current}\n\n${trimmed}` : trimmed;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    for (const part of splitContentChunk(trimmed, maxLength)) {
      chunks.push(part);
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
};

const sendReply = async (message, payload) => {
  const normalizedPayload = typeof payload === "string" ? {content: payload} : payload;
  if (typeof message?.reply === "function") {
    try {
      return await message.reply(normalizedPayload);
    } catch {
      // Fall back to channel.send below when replying directly fails.
    }
  }
  if (typeof message?.channel?.send === "function") {
    return message.channel.send(normalizedPayload);
  }
  return null;
};

const sendReplySequence = async (message, payload) => {
  const normalizedPayload = typeof payload === "string" ? {content: payload} : payload;
  if (!normalizedPayload || typeof normalizedPayload !== "object") {
    return [];
  }
  const content = normalizeString(normalizedPayload.content);
  if (!content) {
    return [await sendReply(message, normalizedPayload)];
  }

  const chunks = splitMessageContent(content);
  if (chunks.length <= 1) {
    return [await sendReply(message, normalizedPayload)];
  }

  const responses = [];
  for (const chunk of chunks) {
    responses.push(await sendReply(message, {...normalizedPayload, content: chunk}));
  }
  return responses;
};

/**
 * Create the DM-only legacy text downloadall handler.
 *
 * @param {{getSettings: () => {superuserId?: string}, sage: ReturnType<import("../sageClient.mjs").createSageClient>, logger?: {warn?: Function, info?: Function}, onRuntimeEvent?: Function}} options
 * @returns {(message: any) => Promise<boolean>}
 */
export const createDirectMessageHandler = ({getSettings, sage, logger, onRuntimeEvent}) => async (message) => {
  if (!message || message?.author?.bot) {
    return false;
  }
  if (message.guildId || message?.inGuild?.()) {
    return false;
  }

  const parsed = parseDownloadAllCommand(message.content);
  const helpRequested = isDownloadAllHelpRequest(message.content);
  if (!parsed.matched && !helpRequested) {
    return false;
  }

  const requestedBy = normalizeString(message?.author?.id);
  const settings = typeof getSettings === "function" ? (getSettings() || {}) : {};
  const access = resolveDownloadAllAccess({
    settings,
    requestedBy,
    requireDm: true,
    isDirectMessage: true
  });
  if (!access.allowed) {
    await sendReplySequence(message, access.message);
    return true;
  }

  if (helpRequested) {
    onRuntimeEvent?.({
      type: "downloadall-handled",
      source: "dm-text-help",
      requestedBy,
      status: "help"
    });
    await sendReplySequence(message, formatDownloadAllUsage());
    return true;
  }

  if (!parsed.valid || !parsed.filters) {
    onRuntimeEvent?.({
      type: "downloadall-error",
      source: "dm-text",
      requestedBy,
      message: parsed.errors.join(" ")
    });
    await sendReplySequence(message, formatDownloadAllUsage(parsed.errors));
    return true;
  }

  await sendReplySequence(
    message,
    `Queueing Scriptarr bulk download for type=${parsed.filters.type}, nsfw=${parsed.filters.nsfw}, titlegroup=${parsed.filters.titlePrefix}...`
  );

  try {
    const result = await executeDownloadAll({
      getSettings,
      sage,
      logger,
      onRuntimeEvent,
      requestedBy,
      filters: parsed.filters,
      source: "dm-text"
    });
    await sendReplySequence(message, formatBulkQueueSummary(result.payload || result));
  } catch (error) {
    await sendReplySequence(message, `Scriptarr bulk queue failed: ${error?.message || String(error)}`);
  }

  return true;
};

export {
  formatBulkQueueSummary,
  formatDownloadAllUsage,
  isDownloadAllHelpRequest,
  parseDownloadAllCommand,
  resolveDownloadAllAccess
};

export default createDirectMessageHandler;
