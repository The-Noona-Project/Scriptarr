/**
 * @file Shared profile helpers for Moon's user-next shell.
 */

/**
 * Build initials from the current display name.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export const initialsFromName = (value) =>
  String(value || "Reader")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "R";

/**
 * Resolve Once UI Avatar props from a Moon auth payload.
 *
 * @param {{avatarUrl?: string, username?: string} | null | undefined} user
 * @returns {{src: string} | {value: string}}
 */
export const buildAvatarProps = (user) => {
  const avatarUrl = String(user?.avatarUrl || "").trim();
  if (avatarUrl) {
    return {src: avatarUrl};
  }
  return {value: initialsFromName(user?.username)};
};

export default {
  buildAvatarProps,
  initialsFromName
};
