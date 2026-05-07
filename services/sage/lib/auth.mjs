/**
 * @file Scriptarr Sage module: services/sage/lib/auth.mjs.
 */
import {createHash} from "node:crypto";
import {
  canAccessAdmin,
  deriveLegacyPermissions,
  hasGrant,
  mergeAdminGrantMaps,
  normalizeCapabilities
} from "@scriptarr/access";

const USER_API_KEY_PERMISSIONS = new Set([
  "read_library",
  "create_requests",
  "read_requests",
  "read_ai_status"
]);

const getBearerToken = (header) => {
  if (!header) {
    return "";
  }
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
};

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const hashPresentedApiKey = (value) => createHash("sha256").update(normalizeString(value)).digest("hex");

const sanitizeApiKeyRecord = (apiKey = {}) => ({
  id: normalizeString(apiKey.id),
  name: normalizeString(apiKey.name, "API key"),
  kind: normalizeString(apiKey.kind),
  keyPrefix: normalizeString(apiKey.keyPrefix),
  ownerDiscordUserId: normalizeString(apiKey.ownerDiscordUserId),
  groupIds: Array.isArray(apiKey.groupIds) ? apiKey.groupIds.map((entry) => normalizeString(entry)).filter(Boolean) : [],
  createdBy: apiKey.createdBy && typeof apiKey.createdBy === "object" ? apiKey.createdBy : {},
  lastUsedAt: normalizeString(apiKey.lastUsedAt),
  createdAt: normalizeString(apiKey.createdAt),
  updatedAt: normalizeString(apiKey.updatedAt)
});

const buildSystemApiKeyUser = async (vaultClient, apiKey) => {
  const groups = Array.isArray(apiKey.groupIds) && apiKey.groupIds.length
    ? (await vaultClient.listPermissionGroups()).filter((group) => apiKey.groupIds.includes(group.id))
    : [];
  const adminGrants = mergeAdminGrantMaps(groups.map((group) => group.adminGrants));
  const permissions = deriveLegacyPermissions({
    role: "api-key",
    permissions: normalizeCapabilities(groups.flatMap((group) => group.permissions || [])),
    adminGrants
  });
  return {
    discordUserId: `api-key:${apiKey.id}`,
    username: apiKey.name || "System API key",
    role: "api-key",
    isOwner: false,
    groups,
    adminGrants,
    permissions
  };
};

const buildUserApiKeyUser = async (vaultClient, apiKey) => {
  const owner = await vaultClient.getUserByDiscordId(apiKey.ownerDiscordUserId);
  if (!owner) {
    return null;
  }
  return {
    discordUserId: owner.discordUserId,
    username: owner.username || "Reader",
    avatarUrl: owner.avatarUrl || null,
    role: "member",
    isOwner: false,
    groups: [],
    adminGrants: {},
    permissions: normalizeCapabilities(owner.permissions).filter((permission) => USER_API_KEY_PERMISSIONS.has(permission))
  };
};

/**
 * Resolve an API-key header into the same user shape used by session routes.
 *
 * @param {ReturnType<import("./vaultClient.mjs").createVaultClient>} vaultClient
 * @param {string} presentedKey
 * @returns {Promise<{user: any, apiKey: any} | null>}
 */
export const resolveApiKeySession = async (vaultClient, presentedKey) => {
  const normalizedKey = normalizeString(presentedKey);
  if (!normalizedKey) {
    return null;
  }
  const apiKey = await vaultClient.resolveApiKey(hashPresentedApiKey(normalizedKey));
  if (!apiKey) {
    return null;
  }
  const user = apiKey.kind === "user"
    ? await buildUserApiKeyUser(vaultClient, apiKey)
    : await buildSystemApiKeyUser(vaultClient, apiKey);
  if (!user) {
    return null;
  }
  return {
    user,
    apiKey: sanitizeApiKeyRecord(apiKey)
  };
};

const LEGACY_PERMISSION_DOMAIN_MAP = Object.freeze({
  admin: [{domain: "overview", level: "read"}],
  manage_users: [{domain: "users", level: "write"}],
  manage_settings: [
    {domain: "settings", level: "write"},
    {domain: "discord", level: "write"},
    {domain: "mediamanagement", level: "write"},
    {domain: "system", level: "write"},
    {domain: "publicapi", level: "write"},
    {domain: "ai", level: "write"}
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
  const presentedApiKey = req.get("X-Scriptarr-Api-Key");
  if (presentedApiKey) {
    const resolved = await resolveApiKeySession(vaultClient, presentedApiKey);
    if (!resolved) {
      res.status(401).json({error: "Invalid API key."});
      return;
    }
    req.user = resolved.user;
    req.apiKey = resolved.apiKey;
    req.authMethod = "api-key";
    next();
    return;
  }

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
  req.authMethod = "session";
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

