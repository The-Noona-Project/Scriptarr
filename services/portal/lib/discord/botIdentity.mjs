import {readFile} from "node:fs/promises";

const BOT_AVATAR_ASSET_URLS = Object.freeze({
  noona: new URL("../../assets/discord/noona-avatar.png", import.meta.url),
  appa: new URL("../../assets/discord/appa-avatar.png", import.meta.url)
});

export const DISCORD_BOT_IDENTITIES = Object.freeze({
  noona: Object.freeze({
    id: "noona",
    label: "Noona",
    avatarAssetUrl: BOT_AVATAR_ASSET_URLS.noona
  }),
  appa: Object.freeze({
    id: "appa",
    label: "Appa",
    avatarAssetUrl: BOT_AVATAR_ASSET_URLS.appa
  })
});

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Resolve the configured Discord bot identity to a bundled avatar asset.
 *
 * @param {unknown} value
 * @returns {typeof DISCORD_BOT_IDENTITIES.noona}
 */
export const resolveDiscordBotIdentity = (value = "noona") => {
  const requested = normalizeString(value, "noona").toLowerCase();
  return DISCORD_BOT_IDENTITIES[requested] || DISCORD_BOT_IDENTITIES.noona;
};

/**
 * Normalize the Discord avatar sync mode.
 *
 * @param {unknown} value
 * @returns {"off" | "missing" | "force"}
 */
export const normalizeDiscordAvatarMode = (value = "missing") => {
  const mode = normalizeString(value, "missing").toLowerCase();
  return mode === "off" || mode === "force" ? mode : "missing";
};

/**
 * Apply a bundled default avatar to the Discord bot user when allowed.
 *
 * The default mode is intentionally conservative: it only uploads the bundled
 * image when Discord reports no custom avatar. Operators can opt into `force`
 * for one deliberate rollout, while `off` disables runtime avatar sync.
 *
 * @param {{
 *   client?: {user?: {avatar?: string | null, setAvatar?: Function}},
 *   identity?: ReturnType<typeof resolveDiscordBotIdentity>,
 *   mode?: "off" | "missing" | "force",
 *   logger?: {info?: Function, warn?: Function}
 * }} options
 * @returns {Promise<{status: string, identity: string, reason?: string, bytes?: number}>}
 */
export const syncDiscordBotAvatar = async ({
  client,
  identity = DISCORD_BOT_IDENTITIES.noona,
  mode = "missing",
  logger
} = {}) => {
  const normalizedMode = normalizeDiscordAvatarMode(mode);
  const resolvedIdentity = resolveDiscordBotIdentity(identity?.id);
  const user = client?.user;

  if (normalizedMode === "off") {
    return {status: "skipped", identity: resolvedIdentity.id, reason: "disabled"};
  }
  if (!user) {
    return {status: "skipped", identity: resolvedIdentity.id, reason: "bot-user-unavailable"};
  }
  if (normalizedMode === "missing" && normalizeString(user.avatar)) {
    return {status: "skipped", identity: resolvedIdentity.id, reason: "custom-avatar-present"};
  }
  if (typeof user.setAvatar !== "function") {
    return {status: "skipped", identity: resolvedIdentity.id, reason: "set-avatar-unavailable"};
  }

  const avatar = await readFile(resolvedIdentity.avatarAssetUrl);
  await user.setAvatar(avatar);
  logger?.info?.("Portal Discord default avatar applied.", {
    identity: resolvedIdentity.id,
    bytes: avatar.byteLength
  });
  return {
    status: "updated",
    identity: resolvedIdentity.id,
    bytes: avatar.byteLength
  };
};
