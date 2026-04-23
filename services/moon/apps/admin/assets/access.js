const LEVEL_ORDER = Object.freeze({
  "": 0,
  none: 0,
  read: 1,
  write: 2,
  root: 3
});

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeLevel = (value, fallback = "") => {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return ["read", "write", "root"].includes(normalized) ? normalized : "";
};

/**
 * Resolve whether a user payload has a requested admin-domain grant.
 *
 * @param {{role?: string, isOwner?: boolean, adminGrants?: Record<string, string>} | null | undefined} user
 * @param {string} domain
 * @param {"" | "read" | "write" | "root"} [level]
 * @returns {boolean}
 */
export const hasAdminGrant = (user, domain, level = "read") => {
  if (!user) {
    return false;
  }
  if (user.isOwner === true || normalizeString(user.role).toLowerCase() === "owner") {
    return true;
  }
  const currentLevel = normalizeLevel(user.adminGrants?.[domain]);
  return LEVEL_ORDER[currentLevel] >= LEVEL_ORDER[normalizeLevel(level, "read") || "read"];
};

/**
 * Resolve whether a user can open Moon admin at all.
 *
 * @param {{role?: string, isOwner?: boolean, adminGrants?: Record<string, string>} | null | undefined} user
 * @returns {boolean}
 */
export const canAccessAdmin = (user) => {
  if (!user) {
    return false;
  }
  if (user.isOwner === true || normalizeString(user.role).toLowerCase() === "owner") {
    return true;
  }
  return Object.values(user.adminGrants || {}).some((value) => LEVEL_ORDER[normalizeLevel(value)] >= LEVEL_ORDER.read);
};

/**
 * Filter a route list down to the entries the current user can read.
 *
 * @param {Array<{domain?: string}>} routes
 * @param {{role?: string, isOwner?: boolean, adminGrants?: Record<string, string>} | null | undefined} user
 * @returns {Array<any>}
 */
export const filterRoutesForUser = (routes, user) => {
  if (canAccessAdmin(user) && (user.isOwner === true || normalizeString(user.role).toLowerCase() === "owner")) {
    return routes;
  }
  return routes.filter((route) => !route.domain || hasAdminGrant(user, route.domain, "read"));
};

export default {
  canAccessAdmin,
  filterRoutesForUser,
  hasAdminGrant
};
