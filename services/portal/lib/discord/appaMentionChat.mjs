import {editPublicAiReply, queueStatusText, sendPublicAiReply} from "./aiChatMessages.mjs";
import {createAiResponseQueue} from "./aiResponseQueue.mjs";
import {normalizeString} from "./utils.mjs";

const defaultAppaAiQueue = createAiResponseQueue();

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
  return new RegExp(`<@!?${botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`).test(normalizeString(message?.content));
};

const stripMention = (content, botUserId) =>
  normalizeString(content).replace(new RegExp(`<@!?${botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "g"), "").trim();

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
  aiQueue = defaultAppaAiQueue
}) => async (message) => {
  const settings = getSettings?.() || {};
  const appa = settings.appa || {};
  const guildId = resolveGuildId(message);
  const botUserId = resolveBotUserId(message, getBotUserId);

  if (!guildId || message?.author?.bot || appa.enabled !== true || !hasMention(message, botUserId)) {
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
    await sendPublicAiReply(message, access.message || "Appa is for configured admins here.", {
      userId,
      fallback: "Appa is for configured admins here."
    });
    return true;
  }

  let placeholder = null;
  try {
    const response = await aiQueue.run(async () => {
      await message?.channel?.sendTyping?.();
      return sage.appaChat?.({
        message: prompt,
        rawMessage: normalizeString(message?.content),
        guildId,
        channelId,
        messageId: normalizeString(message?.id),
        user: buildUserPayload(message?.author, message?.member),
        proposalMode: "conservative"
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
    await editPublicAiReply({
      message,
      placeholder,
      content: payload.reply || (response?.ok
        ? "Appa is watching the admin side."
        : payload.error || "Appa is unavailable right now."),
      userId,
      fallback: "Appa is here, but the review cloud is quiet."
    });
    onRuntimeEvent?.({
      type: response?.ok ? "appa-chat-handled" : "appa-chat-error",
      at: new Date().toISOString(),
      authorId: userId,
      channelId,
      message: payload.error || ""
    });
    return true;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    logger?.warn?.("Portal Appa mention chat failed.", {error});
    onRuntimeEvent?.({
      type: "appa-chat-error",
      at: new Date().toISOString(),
      authorId: userId,
      channelId,
      message: messageText
    });
    await editPublicAiReply({
      message,
      placeholder,
      content: "Appa lost the admin thread for a second. Try again soon.",
      userId,
      fallback: "Appa lost the admin thread for a second. Try again soon."
    });
    return true;
  }
};

export default createAppaMentionHandler;
