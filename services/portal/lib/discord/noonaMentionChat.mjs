import {normalizeString} from "./utils.mjs";

const DEFAULT_RATE_LIMIT_MS = 6000;
const MAX_REPLY_CHUNK_LENGTH = 1800;

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

const splitReplyContent = (content, maxLength = MAX_REPLY_CHUNK_LENGTH) => {
  const text = normalizeString(content, "Noona is here, but she could not find the words that time.");
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const splitAt = Math.max(
      remaining.lastIndexOf("\n", maxLength),
      remaining.lastIndexOf(" ", maxLength)
    );
    const end = splitAt > maxLength * 0.5 ? splitAt : maxLength;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
};

const sendPublicReply = async (message, content) => {
  const chunks = splitReplyContent(content);
  const payloadFor = (chunk) => ({
    content: chunk,
    allowedMentions: {
      repliedUser: false,
      parse: []
    }
  });
  const replies = [];
  const firstPayload = payloadFor(chunks[0]);
  if (typeof message?.reply === "function") {
    replies.push(await message.reply(firstPayload));
  } else if (typeof message?.channel?.send === "function") {
    replies.push(await message.channel.send(firstPayload));
  }
  for (const chunk of chunks.slice(1)) {
    if (typeof message?.channel?.send === "function") {
      replies.push(await message.channel.send(payloadFor(chunk)));
    }
  }
  return replies;
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
 *   rateLimitMs?: number
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
  rateLimitMs = DEFAULT_RATE_LIMIT_MS
}) => {
  const lastByUser = new Map();

  return async (message) => {
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

    const access = roleManager.checkAccess({
      guildId,
      guild: message?.guild,
      user: message?.author,
      member: message?.member
    }, "chat", {});
    if (!access.allowed) {
      await sendPublicReply(message, access.message || "You do not have permission to talk to Noona here.");
      return true;
    }

    const userId = normalizeString(message?.author?.id);
    const now = Date.now();
    const lastAt = lastByUser.get(userId) || 0;
    if (userId && now - lastAt < rateLimitMs) {
      onRuntimeEvent?.({
        type: "noona-chat-rate-limited",
        at: new Date().toISOString(),
        authorId: userId,
        channelId
      });
      await sendPublicReply(message, "One sec, honey. Noona is catching up.");
      return true;
    }
    if (userId) {
      lastByUser.set(userId, now);
    }

    try {
      await message?.channel?.sendTyping?.();
      const response = await sage.noonaChat?.({
        message: prompt,
        rawMessage: normalizeString(message?.content),
        guildId,
        channelId,
        messageId: normalizeString(message?.id),
        user: buildUserPayload(message?.author, message?.member),
        memoryEnabled: noonaChat.memoryEnabled !== false,
        proposalMode: normalizeString(noonaChat.proposalMode, "conservative")
      });
      const payload = response?.payload || {};
      const reply = payload.reply || (response?.ok
        ? "Noona is here."
        : payload.error || "Noona is unavailable right now.");
      const replies = await sendPublicReply(message, reply);
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
      await sendPublicReply(message, "Noona tripped over the wires for a second. Try me again soon.");
      return true;
    }
  };
};

export default createNoonaMentionHandler;
