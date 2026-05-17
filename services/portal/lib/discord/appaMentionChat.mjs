import {normalizeString} from "./utils.mjs";

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

const sendPublicReply = async (message, content) => {
  const payload = {
    content: normalizeString(content, "Appa is here, but the review cloud is quiet."),
    allowedMentions: {
      repliedUser: false,
      parse: []
    }
  };
  if (typeof message?.reply === "function") {
    return message.reply(payload);
  }
  if (typeof message?.channel?.send === "function") {
    return message.channel.send(payload);
  }
  return null;
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
 *   onRuntimeEvent?: Function
 * }} options
 * @returns {(message: any) => Promise<boolean>}
 */
export const createAppaMentionHandler = ({
  getSettings,
  getBotUserId,
  sage,
  roleManager,
  logger,
  onRuntimeEvent
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
    return false;
  }

  const allowedChannelIds = normalizeArray(appa.adminMentionChannelIds).map((entry) => normalizeString(entry)).filter(Boolean);
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
  }, "status", {});
  if (!access.allowed) {
    await sendPublicReply(message, access.message || "Appa is for configured admins here.");
    return true;
  }

  const userId = normalizeString(message?.author?.id);
  try {
    await message?.channel?.sendTyping?.();
    const response = await sage.appaChat?.({
      message: prompt,
      rawMessage: normalizeString(message?.content),
      guildId,
      channelId,
      messageId: normalizeString(message?.id),
      user: buildUserPayload(message?.author, message?.member),
      proposalMode: "conservative"
    });
    const payload = response?.payload || {};
    await sendPublicReply(message, payload.reply || (response?.ok
      ? "Appa is watching the admin side."
      : payload.error || "Appa is unavailable right now."));
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
    await sendPublicReply(message, "Appa lost the admin thread for a second. Try again soon.");
    return true;
  }
};

export default createAppaMentionHandler;
