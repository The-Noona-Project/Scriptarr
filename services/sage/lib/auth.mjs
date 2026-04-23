/**
 * @file Scriptarr Sage module: services/sage/lib/auth.mjs.
 */
import {canAccessAdmin, hasGrant} from "@scriptarr/access";

const getBearerToken = (header) => {
  if (!header) {
    return "";
  }
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
};

const LEGACY_PERMISSION_DOMAIN_MAP = Object.freeze({
  admin: [{domain: "overview", level: "read"}],
  manage_users: [{domain: "users", level: "write"}],
  manage_settings: [
    {domain: "settings", level: "write"},
    {domain: "discord", level: "write"},
    {domain: "mediamanagement", level: "write"},
    {domain: "system", level: "write"},
    {domain: "publicapi", level: "write"}
  ],
  moderate_requests: [{domain: "requests", level: "write"}],
  read_requests: [{domain: "requests", level: "read"}],
  read_library: [
    {domain: "library", level: "read"},
    {domain: "overview", level: "read"},
    {domain: "add", level: "read"},
    {domain: "import", level: "read"},
    {domain: "calendar", level: "read"},
    {domain: "activity", level: "read"},
    {domain: "wanted", level: "read"}
  ]
});

/**
 * Resolve whether a session can open Moon admin at all.
 *
 * @param {{role?: string, isOwner?: boolean, adminGrants?: Record<string, string>} | null | undefined} user
 * @returns {boolean}
 */
export const hasAdminAccess = (user) => canAccessAdmin(user);

/**
 * Resolve whether a session has the requested admin-domain grant level.
 *
 * @param {{role?: string, isOwner?: boolean, adminGrants?: Record<string, string>} | null | undefined} user
 * @param {string} domain
 * @param {"" | "read" | "write" | "root"} [level]
 * @returns {boolean}
 */
export const hasDomainAccess = (user, domain, level = "read") => {
  if (user?.isOwner === true || user?.role === "owner") {
    return true;
  }
  return hasGrant(user?.adminGrants, domain, level);
};

/**
 * Determine whether a signed-in user carries a specific permission or global
 * admin access.
 *
 * @param {{permissions?: string[]}} user
 * @param {string} permission
 * @returns {boolean}
 */
export const hasPermission = (user, permission) => {
  if (user?.isOwner === true || user?.role === "owner") {
    return true;
  }
  if (Array.isArray(user?.permissions) && user.permissions.includes(permission)) {
    return true;
  }
  if (permission === "admin") {
    return hasAdminAccess(user);
  }
  return (LEGACY_PERMISSION_DOMAIN_MAP[permission] || []).some((mapping) =>
    hasDomainAccess(user, mapping.domain, mapping.level)
  );
};

/**
 * Build an Express middleware that resolves the current session user through
 * Vault's session APIs.
 *
 * @param {ReturnType<import("./vaultClient.mjs").createVaultClient>} vaultClient
 * @returns {import("express").RequestHandler}
 */
export const requireSession = (vaultClient) => async (req, res, next) => {
  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({error: "Missing session token."});
    return;
  }
  const user = await vaultClient.getSessionUser(token);
  if (!user) {
    res.status(401).json({error: "Invalid session token."});
    return;
  }
  req.sessionToken = token;
  req.user = user;
  next();
};

/**
 * Build an Express middleware that enforces a named permission after the
 * request session has been resolved.
 *
 * @param {ReturnType<import("./vaultClient.mjs").createVaultClient>} vaultClient
 * @param {string} permission
 * @returns {import("express").RequestHandler}
 */
export const requirePermission = (vaultClient, permission) => {
  const requireUser = requireSession(vaultClient);
  return async (req, res, next) => {
    await requireUser(req, res, async () => {
      if (!hasPermission(req.user, permission)) {
        res.status(403).json({error: `Missing permission: ${permission}`});
        return;
      }
      next();
    });
  };
};

/**
 * Build an Express middleware that enforces a canonical admin-domain grant
 * level after the request session has been resolved.
 *
 * @param {ReturnType<import("./vaultClient.mjs").createVaultClient>} vaultClient
 * @param {string} domain
 * @param {"" | "read" | "write" | "root"} [level]
 * @returns {import("express").RequestHandler}
 */
export const requireAdminGrant = (vaultClient, domain, level = "read") => {
  const requireUser = requireSession(vaultClient);
  return async (req, res, next) => {
    await requireUser(req, res, async () => {
      if (!hasDomainAccess(req.user, domain, level)) {
        res.status(403).json({error: `Missing admin grant: ${domain}.${level}`});
        return;
      }
      next();
    });
  };
};

