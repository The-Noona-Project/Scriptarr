import {editPublicAiReply, queueStatusText, sendPublicAiReply} from "./aiChatMessages.mjs";
import {createAiResponseQueue, isAiResponseQueueCancelError} from "./aiResponseQueue.mjs";
import {normalizeString} from "./utils.mjs";

const defaultNoonaAiQueue = createAiResponseQueue();

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const escapeRegExp = (value) => normalizeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const resolveGuildId = (message) =>
  normalizeString(message?.guildId || message?.guild?.id || (message?.inGuild?.() ? message?.guildId : ""));

const resolveBotUserId = (message, getBotUserId) =>
  normalizeString(getBotUserId?.() || message?.client?.user?.id || "");

const normalizeBotUserIds = (value) => normalizeArray(value).map((entry) => normalizeString(entry)).filter(Boolean);

const hasMention = (message, botUserId) => {
  if (!botUserId) {
    return false;
  }
  const users = message?.mentions?.users;
  if (typeof users?.has === "function" && users.has(botUserId)) {
    return true;
  }
  if (typeof message?.mentions?.has === "function") {
    try {
      if (message.mentions.has(botUserId)) {
        return true;
      }
    } catch {
      // Fake Discord.js shims may only support the users collection.
    }
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
  username: normalizeString(author.username || member.displayName || author.globalName, "Discord Reader"),
  globalName: normalizeString(author.globalName),
  displayName: normalizeString(member.displayName || author.globalName || author.username),
  avatarUrl: typeof author.displayAvatarURL === "function" ? normalizeString(author.displayAvatarURL()) : normalizeString(author.avatarUrl)
});

/**
 * Create Portal's public Noona mention handler for guild messages.
 *
 * @param {{
 *   getSettings: () => Record<string, unknown>,
 *   getBotUserId?: () => string,
 *   sage: {noonaChat?: Function},
 *   roleManager: {checkAccess: Function},
 *   logger?: {warn?: Function, error?: Function},
 *   onRuntimeEvent?: Function,
 *   onReviewCandidate?: Function,
 *   getPeerBotUserIds?: () => string[],
 *   allowBotAuthoredMessage?: (message: any) => boolean,
 *   preparePrompt?: (input: {prompt: string, message: any}) => string,
 *   aiQueue?: ReturnType<typeof createAiResponseQueue>
 * }} options
 * @returns {(message: any) => Promise<boolean>}
 */
export const createNoonaMentionHandler = ({
  getSettings,
  getBotUserId,
  sage,
  roleManager,
  logger,
  onRuntimeEvent,
  onReviewCandidate,
  getPeerBotUserIds,
  allowBotAuthoredMessage,
  preparePrompt,
  aiQueue = defaultNoonaAiQueue
}) => async (message) => {
  const settings = getSettings?.() || {};
  const noonaChat = settings.noonaChat || {};
  const guildId = resolveGuildId(message);
  const botUserId = resolveBotUserId(message, getBotUserId);
  const peerBotUserIds = normalizeBotUserIds(getPeerBotUserIds?.());
  const botAuthoredAllowed = message?.author?.bot && allowBotAuthoredMessage?.(message) === true;

  if (!guildId || (message?.author?.bot && !botAuthoredAllowed) || noonaChat.enabled !== true || !hasMention(message, botUserId)) {
    return false;
  }

  const configuredGuildId = normalizeString(settings.guildId);
  if (configuredGuildId && guildId !== configuredGuildId) {
    return false;
  }

  const allowedChannelIds = normalizeArray(noonaChat.allowedChannelIds).map((entry) => normalizeString(entry)).filter(Boolean);
  const channelId = normalizeString(message?.channelId || message?.channel?.id);
  if (allowedChannelIds.length && !allowedChannelIds.includes(channelId)) {
    return false;
  }

  const strippedPrompt = stripMentions(message?.content, [botUserId, ...peerBotUserIds]);
  const prompt = normalizeString(preparePrompt?.({prompt: strippedPrompt, message}) ?? strippedPrompt);
  if (!prompt) {
    return false;
  }
  const userId = normalizeString(message?.author?.id);

  const access = botAuthoredAllowed ? {allowed: true} : roleManager.checkAccess({
    guildId,
    guild: message?.guild,
    user: message?.author,
    member: message?.member
  }, "chat", {});
  if (!access.allowed) {
    await sendPublicAiReply(message, access.message || "You do not have permission to talk to Noona here.", {
      userId,
      fallback: "You do not have permission to talk to Noona here."
    });
    return true;
  }

  let placeholder = null;
  try {
    const response = await aiQueue.run(async ({signal}) => {
      await message?.channel?.sendTyping?.();
      return sage.noonaChat?.({
        message: prompt,
        rawMessage: normalizeString(message?.content),
        guildId,
        channelId,
        messageId: normalizeString(message?.id),
        user: buildUserPayload(message?.author, message?.member),
        memoryEnabled: noonaChat.memoryEnabled !== false,
        proposalMode: normalizeString(noonaChat.proposalMode, "conservative")
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
    const reply = payload.reply || (response?.ok
      ? "Noona is here."
      : "Noona is having trouble reaching her brain right now. Try me again soon.");
    const replies = await editPublicAiReply({
      message,
      placeholder,
      content: reply,
      userId,
      fallback: "Noona is here, but she could not find the words that time."
    });
    if (replies?.placeholderEditFailed) {
      onRuntimeEvent?.({
        type: "noona-chat-delivery-degraded",
        at: new Date().toISOString(),
        authorId: userId,
        channelId,
        reason: "placeholder-edit-failed",
        message: replies.placeholderEditError || ""
      });
    }
    onRuntimeEvent?.({
      type: response?.ok ? "noona-chat-handled" : "noona-chat-error",
      at: new Date().toISOString(),
      authorId: userId,
      channelId,
      message: response?.ok ? "" : "sage-error",
      degraded: payload.oracle?.degraded === true,
      degradedReason: payload.oracle?.degraded === true ? "oracle.degraded" : ""
    });
    if (response?.ok && typeof onReviewCandidate === "function") {
      void Promise.resolve(onReviewCandidate({
        message,
        prompt,
        reply,
        replyMessageId: normalizeString(replies?.[0]?.id),
        guildId,
        channelId,
        messageId: normalizeString(message?.id),
        user: buildUserPayload(message?.author, message?.member),
        oracle: payload.oracle || null
      })).catch((error) => {
        logger?.warn?.("Portal Appa review callback failed.", {error});
      });
    }
    return true;
  } catch (error) {
    if (isAiResponseQueueCancelError(error)) {
      return true;
    }
    const messageText = error instanceof Error ? error.message : String(error);
    const reason = classifyChatFailure(messageText);
    logger?.warn?.("Portal Noona mention chat failed.", {error});
    onRuntimeEvent?.({
      type: "noona-chat-error",
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
        content: "Noona is having trouble reaching her brain right now. Try me again soon.",
        userId,
        fallback: "Noona is having trouble reaching her brain right now. Try me again soon."
      });
      if (replies?.placeholderEditFailed) {
        onRuntimeEvent?.({
          type: "noona-chat-delivery-degraded",
          at: new Date().toISOString(),
          authorId: userId,
          channelId,
          reason: "placeholder-edit-failed",
          message: replies.placeholderEditError || ""
        });
      }
    } catch (deliveryError) {
      logger?.warn?.("Portal Noona mention chat could not post a public failure reply.", {error: deliveryError});
    }
    return true;
  }
};

export default createNoonaMentionHandler;
