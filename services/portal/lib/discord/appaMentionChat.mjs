import {editPublicAiReply, queueStatusText, sendPublicAiReply} from "./aiChatMessages.mjs";
import {createAiResponseQueue, isAiResponseQueueCancelError} from "./aiResponseQueue.mjs";
import {normalizeString} from "./utils.mjs";

const defaultAppaAiQueue = createAiResponseQueue();

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const escapeRegExp = (value) => normalizeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const resolveGuildId = (message) =>
  normalizeString(message?.guildId || message?.guild?.id || (message?.inGuild?.() ? message?.guildId : ""));

const resolveBotUserId = (message, getBotUserId) =>
  normalizeString(getBotUserId?.() || message?.client?.user?.id || "");

const normalizeBotUserIds = (value) => normalizeArray(value).map((entry) => normalizeString(entry)).filter(Boolean);
const normalizeObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

const hasMention = (message, botUserId) => {
  if (!botUserId) {
    return false;
  }
  const users = message?.mentions?.users;
  if (typeof users?.has === "function" && users.has(botUserId)) {
    return true;
  }
  return new RegExp(`<@!?${escapeRegExp(botUserId)}>`).test(normalizeString(message?.content));
};

const stripMentions = (content, botUserIds) => normalizeBotUserIds(botUserIds).reduce(
  (current, botUserId) => current.replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g"), ""),
  normalizeString(content)
).replace(/\s+/g, " ").trim().replace(/^(?:and|,|&|\+)\s+/i, "").trim();

const classifyChatFailure = (message) => {
  const text = normalizeString(message).toLowerCase();
  if (/timed out|timeout|aborted|fetch failed|network|econn|socket/.test(text)) {
    return "sage-timeout";
  }
  return "sage-error";
};

const buildUserPayload = (author = {}, member = {}) => ({
  discordUserId: normalizeString(author.id),
  username: normalizeString(author.username || member.displayName || author.globalName, "Discord Admin"),
  globalName: normalizeString(author.globalName),
  displayName: normalizeString(member.displayName || author.globalName || author.username),
  avatarUrl: typeof author.displayAvatarURL === "function" ? normalizeString(author.displayAvatarURL()) : normalizeString(author.avatarUrl)
});

/**
 * Create Appa's admin mention handler for guild messages.
 *
 * @param {{
 *   getSettings: () => Record<string, unknown>,
 *   getBotUserId?: () => string,
 *   sage: {appaChat?: Function},
 *   roleManager: {checkAccess: Function},
 *   logger?: {warn?: Function},
 *   onRuntimeEvent?: Function,
 *   getPeerBotUserIds?: () => string[],
 *   allowPeerBotMentions?: boolean,
 *   replyOnAccessDenied?: boolean,
 *   preparePrompt?: (input: {prompt: string, message: any}) => string,
 *   buildExtraPayload?: (input: {prompt: string, message: any}) => Record<string, unknown>,
 *   aiQueue?: ReturnType<typeof createAiResponseQueue>
 * }} options
 * @returns {(message: any) => Promise<boolean>}
 */
export const createAppaMentionHandler = ({
  getSettings,
  getBotUserId,
  sage,
  roleManager,
  logger,
  onRuntimeEvent,
  getPeerBotUserIds,
  allowPeerBotMentions = false,
  replyOnAccessDenied = true,
  preparePrompt,
  buildExtraPayload,
  aiQueue = defaultAppaAiQueue
}) => async (message) => {
  const settings = getSettings?.() || {};
  const appa = settings.appa || {};
  const guildId = resolveGuildId(message);
  const botUserId = resolveBotUserId(message, getBotUserId);
  const peerBotUserIds = normalizeBotUserIds(getPeerBotUserIds?.());

  if (!guildId || message?.author?.bot || appa.enabled !== true || !hasMention(message, botUserId)) {
    return false;
  }
  if (!allowPeerBotMentions && peerBotUserIds.some((peerBotUserId) => hasMention(message, peerBotUserId))) {
    onRuntimeEvent?.({
      type: "appa-chat-rejected",
      at: new Date().toISOString(),
      reason: "co-mention-noona-led",
      authorId: normalizeString(message?.author?.id),
      channelId: normalizeString(message?.channelId || message?.channel?.id)
    });
    return false;
  }

  const configuredGuildId = normalizeString(settings.guildId);
  if (configuredGuildId && guildId !== configuredGuildId) {
    onRuntimeEvent?.({
      type: "appa-chat-rejected",
      at: new Date().toISOString(),
      reason: "wrong-guild",
      authorId: normalizeString(message?.author?.id),
      channelId: normalizeString(message?.channelId || message?.channel?.id)
    });
    return false;
  }

  const allowedChannelIds = normalizeArray(appa.adminMentionChannelIds).map((entry) => normalizeString(entry)).filter(Boolean);
  const channelId = normalizeString(message?.channelId || message?.channel?.id);
  if (allowedChannelIds.length && !allowedChannelIds.includes(channelId)) {
    onRuntimeEvent?.({
      type: "appa-chat-rejected",
      at: new Date().toISOString(),
      reason: "channel-not-allowed",
      authorId: normalizeString(message?.author?.id),
      channelId
    });
    return false;
  }

  const userId = normalizeString(message?.author?.id);

  const access = roleManager.checkAccess({
    guildId,
    guild: message?.guild,
    user: message?.author,
    member: message?.member
  }, "status", {});
  if (!access.allowed) {
    onRuntimeEvent?.({
      type: "appa-chat-rejected",
      at: new Date().toISOString(),
      reason: "role-denied",
      authorId: userId,
      channelId,
      message: access.message || ""
    });
    if (replyOnAccessDenied) {
      await sendPublicAiReply(message, access.message || "Appa is for configured admins here.", {
        userId,
        fallback: "Appa is for configured admins here."
      });
    }
    return true;
  }

  const strippedPrompt = stripMentions(message?.content, [botUserId, ...peerBotUserIds]);
  const prompt = normalizeString(preparePrompt?.({prompt: strippedPrompt, message}) ?? strippedPrompt);
  if (!prompt) {
    return false;
  }
  const extraPayload = normalizeObject(buildExtraPayload?.({prompt, message}));

  let placeholder = null;
  try {
    const response = await aiQueue.run(async ({signal}) => {
      await message?.channel?.sendTyping?.();
      return sage.appaChat?.({
        message: prompt,
        rawMessage: normalizeString(message?.content),
        guildId,
        channelId,
        messageId: normalizeString(message?.id),
        user: buildUserPayload(message?.author, message?.member),
        proposalMode: "conservative",
        ...extraPayload
      }, {signal});
    }, {
      onQueued: async ({ahead}) => {
        [placeholder] = await sendPublicAiReply(message, queueStatusText(ahead), {
          userId,
          fallback: "Thinking..."
        });
      },
      onStart: async ({ahead}) => {
        if (ahead > 0) {
          [placeholder] = await editPublicAiReply({
            message,
            placeholder,
            content: "Thinking...",
            userId,
            fallback: "Thinking..."
          });
        }
      }
    });
    const payload = response?.payload || {};
    const replies = await editPublicAiReply({
      message,
      placeholder,
      content: payload.reply || (response?.ok
        ? "Appa is watching the admin side."
        : "Appa is having trouble reaching the admin thread right now. Try again soon."),
      userId,
      fallback: "Appa is here, but the review cloud is quiet."
    });
    if (replies?.placeholderEditFailed) {
      onRuntimeEvent?.({
        type: "appa-chat-delivery-degraded",
        at: new Date().toISOString(),
        authorId: userId,
        channelId,
        reason: "placeholder-edit-failed",
        message: replies.placeholderEditError || ""
      });
    }
    onRuntimeEvent?.({
      type: response?.ok ? "appa-chat-handled" : "appa-chat-error",
      at: new Date().toISOString(),
      authorId: userId,
      channelId,
      message: response?.ok ? "" : "sage-error",
      degraded: payload.oracle?.degraded === true,
      degradedReason: payload.oracle?.degraded === true ? "oracle.degraded" : ""
    });
    return true;
  } catch (error) {
    if (isAiResponseQueueCancelError(error)) {
      return true;
    }
    const messageText = error instanceof Error ? error.message : String(error);
    const reason = classifyChatFailure(messageText);
    logger?.warn?.("Portal Appa mention chat failed.", {error});
    onRuntimeEvent?.({
      type: "appa-chat-error",
      at: new Date().toISOString(),
      authorId: userId,
      channelId,
      reason,
      message: reason
    });
    try {
      const replies = await editPublicAiReply({
        message,
        placeholder,
        content: "Appa is having trouble reaching the admin thread right now. Try again soon.",
        userId,
        fallback: "Appa is having trouble reaching the admin thread right now. Try again soon."
      });
      if (replies?.placeholderEditFailed) {
        onRuntimeEvent?.({
          type: "appa-chat-delivery-degraded",
          at: new Date().toISOString(),
          authorId: userId,
          channelId,
          reason: "placeholder-edit-failed",
          message: replies.placeholderEditError || ""
        });
      }
    } catch (deliveryError) {
      logger?.warn?.("Portal Appa mention chat could not post a public failure reply.", {error: deliveryError});
    }
    return true;
  }
};

export default createAppaMentionHandler;
