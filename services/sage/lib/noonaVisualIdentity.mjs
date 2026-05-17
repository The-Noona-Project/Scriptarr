/**
 * @file Public visual identity facts for Noona and Appa.
 */

/**
 * Public visual descriptions for bundled Noona and Appa identity assets.
 */
export const NOONA_VISUAL_IDENTITIES = Object.freeze({
  noona: Object.freeze({
    name: "Noona",
    role: "Scriptarr's Discord AI persona",
    avatarAsset: "services/portal/assets/discord/noona-avatar.png",
    description: (
      "Noona's current avatar is an anime-style big sister with warm brown eyes, long dark hair in a high ponytail, "
      + "a white robe with black and red layers, gold trim, teal gemstones, and a glowing star-map orb floating over her hand."
    )
  }),
  appa: Object.freeze({
    name: "Appa",
    role: "Scriptarr's admin and reviewer Discord persona",
    avatarAsset: "services/portal/assets/discord/appa-avatar.png",
    description: (
      "Appa's current avatar is a soft cloud-like companion with cream spiral clouds, a dark face mask, glowing teal eyes, "
      + "ornate gold filigree, turquoise gems, and orbiting star lines against a deep teal sky."
    )
  })
});

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Detect when a Discord prompt is asking about Noona or Appa's appearance.
 *
 * @param {unknown} message
 * @returns {boolean}
 */
export const isVisualIdentityPrompt = (message) => {
  const normalized = normalizeString(message).toLowerCase();
  return /\b(look like|looks like|appearance|avatar|picture|image|face|visual|describe)\b/.test(normalized)
    || /\b(who|what)\s+is\s+appa\b/.test(normalized)
    || /\b(describe|show|see)\s+(noona|appa)\b/.test(normalized);
};

/**
 * Build the small read-only identity context sent to Oracle.
 *
 * @returns {{characters: typeof NOONA_VISUAL_IDENTITIES, guidance: string}}
 */
export const buildNoonaVisualIdentityContext = () => ({
  characters: NOONA_VISUAL_IDENTITIES,
  guidance: "Use these visual facts when someone asks what Noona or Appa looks like. Do not claim to inspect live images."
});

/**
 * Build a deterministic visual-identity answer for degraded AI paths.
 *
 * @param {unknown} message
 * @returns {string}
 */
export const buildNoonaVisualIdentityReply = (message) => {
  const normalized = normalizeString(message).toLowerCase();
  const wantsAppa = /\bappa\b/.test(normalized);
  const wantsNoona = /\bnoona\b/.test(normalized) || !wantsAppa;
  const parts = [];
  if (wantsNoona) {
    parts.push(NOONA_VISUAL_IDENTITIES.noona.description);
  }
  if (wantsAppa) {
    parts.push(NOONA_VISUAL_IDENTITIES.appa.description);
  }
  return parts.join(" ");
};
