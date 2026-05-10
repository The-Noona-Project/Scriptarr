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
 * Determine whether a thrown Vault client error represents a stale request
 * revision supplied by a Moon admin action.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export const isRequestRevisionConflictError = (error) =>
  Boolean(error && typeof error === "object" && error.status === 409 && error.payload?.code === "REQUEST_REVISION_CONFLICT");

/**
 * Normalize a caller-provided request revision into the numeric shape expected
 * by Vault. Empty values intentionally return undefined so older callers keep
 * their existing behavior.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
export const normalizeExpectedRequestRevision = (value) => {
  if (value == null || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

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

/**
 * Build the user-facing 409 payload for stale admin request actions.
 *
 * @param {unknown} _error
 * @returns {{error: string, code: string}}
 */
export const buildRequestRevisionConflictPayload = (_error) => ({
  error: "This request changed while you were reviewing it. Refresh the inbox and try again with the latest snapshot.",
  code: "REQUEST_REVISION_CONFLICT"
});
