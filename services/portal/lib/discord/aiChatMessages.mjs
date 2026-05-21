import {normalizeString} from "./utils.mjs";

export const MAX_AI_REPLY_CHUNK_LENGTH = 1800;

export const allowedMentionsForUser = (userId) => {
  const id = normalizeString(userId);
  return id
    ? {users: [id], repliedUser: false, parse: []}
    : {repliedUser: false, parse: []};
};

export const queueStatusText = (ahead = 0) => {
  const count = Math.max(0, Number.parseInt(String(ahead), 10) || 0);
  return count > 0
    ? `Working on ${count} request${count === 1 ? "" : "s"} ahead of you. Please wait.`
    : "Thinking...";
};

export const withRequesterMention = (content, userId, fallback = "") => {
  const text = normalizeString(content, fallback);
  const id = normalizeString(userId);
  return id ? `<@${id}> ${text}` : text;
};

export const splitReplyContent = (content, maxLength = MAX_AI_REPLY_CHUNK_LENGTH) => {
  const text = normalizeString(content);
  if (!text) {
    return [""];
  }
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

const payloadFor = (content, userId) => ({
  content,
  allowedMentions: allowedMentionsForUser(userId)
});

export const sendPublicAiReply = async (message, content, {
  userId,
  fallback = "The bot is here, but it could not find the words that time."
} = {}) => {
  const chunks = splitReplyContent(withRequesterMention(content, userId, fallback));
  const replies = [];
  const firstPayload = payloadFor(chunks[0], userId);
  if (typeof message?.reply === "function") {
    replies.push(await message.reply(firstPayload));
  } else if (typeof message?.channel?.send === "function") {
    replies.push(await message.channel.send(firstPayload));
  }
  for (const chunk of chunks.slice(1)) {
    if (typeof message?.channel?.send === "function") {
      replies.push(await message.channel.send(payloadFor(chunk, userId)));
    }
  }
  return replies;
};

export const editPublicAiReply = async ({
  message,
  placeholder,
  content,
  userId,
  fallback = "The bot is here, but it could not find the words that time."
} = {}) => {
  const chunks = splitReplyContent(withRequesterMention(content, userId, fallback));
  const replies = [];
  const firstPayload = payloadFor(chunks[0], userId);
  if (typeof placeholder?.edit === "function") {
    replies.push(await placeholder.edit(firstPayload));
  } else if (typeof message?.channel?.send === "function") {
    replies.push(await message.channel.send(firstPayload));
  } else if (typeof message?.reply === "function") {
    replies.push(await message.reply(firstPayload));
  }
  for (const chunk of chunks.slice(1)) {
    if (typeof message?.channel?.send === "function") {
      replies.push(await message.channel.send(payloadFor(chunk, userId)));
    }
  }
  return replies;
};

export const interactionAiPayload = (content, {
  userId,
  fallback = "Thinking...",
  ephemeral = true
} = {}) => ({
  content: withRequesterMention(content, userId, fallback),
  allowedMentions: allowedMentionsForUser(userId),
  ephemeral
});
