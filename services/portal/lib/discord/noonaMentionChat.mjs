import {editPublicAiReply, queueStatusText, sendPublicAiReply} from "./aiChatMessages.mjs";
import {createAiResponseQueue} from "./aiResponseQueue.mjs";
import {normalizeString} from "./utils.mjs";

const defaultNoonaAiQueue = createAiResponseQueue();

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const resolveGuildId = (message) =>
  normalizeString(message?.guildId || message?.guild?.id || (message?.inGuild?.() ? message?.guildId : ""));

const resolveBotUserId = (message, getBotUserId) =>
  normalizeString(getBotUserId?.() || message?.client?.user?.id || "");

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
  return new RegExp(`<@!?${botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`).test(normalizeString(message?.content));
};

const stripMention = (content, botUserId) =>
  normalizeString(content).replace(new RegExp(`<@!?${botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "g"), "").trim();

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
  aiQueue = defaultNoonaAiQueue
}) => async (message) => {
  const settings = getSettings?.() || {};
  const noonaChat = settings.noonaChat || {};
  const guildId = resolveGuildId(message);
  const botUserId = resolveBotUserId(message, getBotUserId);

  if (!guildId || message?.author?.bot || noonaChat.enabled !== true || !hasMention(message, botUserId)) {
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

  const prompt = stripMention(message?.content, botUserId);
  if (!prompt) {
    return false;
  }
  const userId = normalizeString(message?.author?.id);

  const access = roleManager.checkAccess({
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
    const response = await aiQueue.run(async () => {
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
      });
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
      : payload.error || "Noona is unavailable right now.");
    const replies = await editPublicAiReply({
      message,
      placeholder,
      content: reply,
      userId,
      fallback: "Noona is here, but she could not find the words that time."
    });
    onRuntimeEvent?.({
      type: response?.ok ? "noona-chat-handled" : "noona-chat-error",
      at: new Date().toISOString(),
      authorId: userId,
      channelId,
      message: payload.error || ""
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
    const messageText = error instanceof Error ? error.message : String(error);
    logger?.warn?.("Portal Noona mention chat failed.", {error});
    onRuntimeEvent?.({
      type: "noona-chat-error",
      at: new Date().toISOString(),
      authorId: userId,
      channelId,
      message: messageText
    });
    await editPublicAiReply({
      message,
      placeholder,
      content: "Noona tripped over the wires for a second. Try me again soon.",
      userId,
      fallback: "Noona tripped over the wires for a second. Try me again soon."
    });
    return true;
  }
};

export default createNoonaMentionHandler;
