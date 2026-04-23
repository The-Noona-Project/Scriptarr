/**
 * @file Durable event helpers for Sage-backed admin activity.
 */

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Build a normalized actor payload from a Moon/Sage session user.
 *
 * @param {{discordUserId?: string, username?: string, role?: string} | null | undefined} user
 * @param {string} [fallbackActorType]
 * @returns {{actorType: string, actorId: string, actorLabel: string}}
 */
export const buildUserActor = (user, fallbackActorType = "user") => ({
  actorType: normalizeString(user?.role, fallbackActorType) === "owner" ? "owner" : fallbackActorType,
  actorId: normalizeString(user?.discordUserId),
  actorLabel: normalizeString(user?.username, normalizeString(user?.discordUserId, "Scriptarr user"))
});

/**
 * Build a normalized service actor payload.
 *
 * @param {string} serviceName
 * @param {string} [label]
 * @returns {{actorType: string, actorId: string, actorLabel: string}}
 */
export const buildServiceActor = (serviceName, label = serviceName) => ({
  actorType: "service",
  actorId: normalizeString(serviceName),
  actorLabel: normalizeString(label, normalizeString(serviceName, "Scriptarr service"))
});

/**
 * Append a durable event to Vault while failing soft for the caller.
 *
 * @param {ReturnType<import("./vaultClient.mjs").createVaultClient>} vaultClient
 * @param {Record<string, unknown>} payload
 * @param {{warn?: Function}} [logger]
 * @returns {Promise<any>}
 */
export const appendDurableEvent = async (vaultClient, payload, logger) => {
  try {
    return await vaultClient.appendEvent(payload);
  } catch (error) {
    logger?.warn?.("Failed to append durable event.", {
      domain: payload?.domain,
      eventType: payload?.eventType,
      targetType: payload?.targetType,
      targetId: payload?.targetId,
      error
    });
    return null;
  }
};

/**
 * Convenience helper for appending a user-scoped admin event.
 *
 * @param {ReturnType<import("./vaultClient.mjs").createVaultClient>} vaultClient
 * @param {{
 *   domain: string,
 *   eventType: string,
 *   message: string,
 *   user?: {discordUserId?: string, username?: string, role?: string} | null,
 *   severity?: string,
 *   targetType?: string,
 *   targetId?: string,
 *   metadata?: Record<string, unknown>
 * }} payload
 * @param {{warn?: Function}} [logger]
 * @returns {Promise<any>}
 */
export const appendUserEvent = async (vaultClient, payload, logger) => appendDurableEvent(vaultClient, {
  ...buildUserActor(payload.user),
  domain: payload.domain,
  eventType: payload.eventType,
  severity: payload.severity || "info",
  targetType: payload.targetType || "",
  targetId: payload.targetId || "",
  message: payload.message,
  metadata: payload.metadata || {}
}, logger);

export default {
  appendDurableEvent,
  appendUserEvent,
  buildServiceActor,
  buildUserActor
};
