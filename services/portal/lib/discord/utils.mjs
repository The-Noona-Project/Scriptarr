import {EPHEMERAL_FLAG} from "./constants.mjs";

export const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

export const normalizeDiscordIdCandidate = (value) => {
  const digits = normalizeString(value).replace(/\D/g, "");
  return digits || null;
};

export const resolveDiscordId = (subject) =>
  subject?.user?.id
  ?? subject?.author?.id
  ?? subject?.member?.user?.id
  ?? subject?.member?.id
  ?? null;

export const sendInteractionReply = async (interaction, payload) => {
  const normalized = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {content: String(payload ?? "")};
  const replyPayload = normalized.ephemeral === true
    ? {flags: EPHEMERAL_FLAG, ...Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== "ephemeral"))}
    : normalized;
  const editPayload = Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== "ephemeral"));

  if (interaction?.deferred || interaction?.replied) {
    await interaction.editReply?.(editPayload);
    return;
  }

  await interaction.reply?.(replyPayload);
};

export const respondWithError = async (interaction, message) =>
  sendInteractionReply(interaction, {
    content: message,
    ephemeral: true
  });

export const truncate = (value, max = 80) => {
  const normalized = normalizeString(value);
  if (!normalized || normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
};
