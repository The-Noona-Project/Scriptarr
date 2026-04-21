/**
 * @file Shared Sage helpers for surfacing durable request-work conflicts from
 * Vault consistently across Moon, Portal, and public API flows.
 */

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Determine whether a thrown Vault client error represents a durable active
 * request work-key conflict.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export const isRequestWorkConflictError = (error) =>
  Boolean(error && typeof error === "object" && error.status === 409 && error.payload?.code === "REQUEST_WORK_KEY_CONFLICT");

/**
 * Build the user-facing 409 payload for request work-key conflicts. The
 * message remains stable while preserving canonical conflict metadata for
 * callers that can use it.
 *
 * @param {unknown} error
 * @returns {{error: string, code?: string, requestId?: string | null, workKey?: string, workKeyKind?: string}}
 */
export const buildRequestWorkConflictPayload = (error) => ({
  error: "That title is already queued or has an active request.",
  ...(normalizeString(error?.payload?.code) ? {code: normalizeString(error?.payload?.code)} : {}),
  ...(normalizeString(error?.payload?.requestId) ? {requestId: normalizeString(error?.payload?.requestId)} : {}),
  ...(normalizeString(error?.payload?.workKey) ? {workKey: normalizeString(error?.payload?.workKey)} : {}),
  ...(normalizeString(error?.payload?.workKeyKind) ? {workKeyKind: normalizeString(error?.payload?.workKeyKind)} : {})
});
