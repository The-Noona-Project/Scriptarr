/**
 * @file Shared access-control helpers for Scriptarr services.
 */

export const ADMIN_ACCESS_DOMAINS = Object.freeze([
  {id: "overview", label: "Overview"},
  {id: "library", label: "Library"},
  {id: "add", label: "Add Title"},
  {id: "import", label: "Import Library"},
  {id: "calendar", label: "Calendar"},
  {id: "mediamanagement", label: "Media Management"},
  {id: "activity", label: "Activity"},
  {id: "wanted", label: "Wanted"},
  {id: "requests", label: "Requests"},
  {id: "users", label: "Users"},
  {id: "discord", label: "Discord"},
  {id: "settings", label: "Settings"},
  {id: "system", label: "System"},
  {id: "publicapi", label: "Public API"}
]);

export const ADMIN_ACCESS_DOMAIN_IDS = Object.freeze(ADMIN_ACCESS_DOMAINS.map((domain) => domain.id));
export const ACCESS_LEVELS = Object.freeze(["read", "write", "root"]);
export const BASELINE_USER_CAPABILITIES = Object.freeze([
  "read_library",
  "create_requests",
  "read_requests",
  "read_ai_status"
]);

const ACCESS_LEVEL_ORDER = Object.freeze({
  "": 0,
  none: 0,
  read: 1,
  write: 2,
  root: 3
});

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

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeCapability = (value) => normalizeString(value);

/**
 * Normalize a requested access level to `read`, `write`, `root`, or `""`.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {"" | "read" | "write" | "root"}
 */
export const normalizeAccessLevel = (value, fallback = "") => {
  const normalized = normalizeString(value, fallback).toLowerCase();
  if (normalized === "read" || normalized === "write" || normalized === "root") {
    return normalized;
  }
  return "";
};

/**
 * Normalize a capability array into stable, deduped values.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export const normalizeCapabilities = (value) => Array.from(new Set(
  (Array.isArray(value) ? value : [])
    .map((entry) => normalizeCapability(entry))
    .filter(Boolean)
)).sort();

/**
 * Normalize a raw domain grant payload into a stable map of domain id to
 * highest granted level.
 *
 * @param {unknown} value
 * @returns {Record<string, "" | "read" | "write" | "root">}
 */
export const normalizeAdminGrants = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(ADMIN_ACCESS_DOMAIN_IDS.map((domainId) => [
    domainId,
    normalizeAccessLevel(source[domainId])
  ]));
};

/**
 * Merge many grant maps together, keeping the highest level seen per domain.
 *
 * @param {Array<Record<string, string> | null | undefined>} values
 * @returns {Record<string, "" | "read" | "write" | "root">}
 */
export const mergeAdminGrantMaps = (values) => {
  const merged = normalizeAdminGrants({});
  for (const entry of values) {
    const normalized = normalizeAdminGrants(entry);
    for (const domainId of ADMIN_ACCESS_DOMAIN_IDS) {
      const nextLevel = normalized[domainId];
      if (ACCESS_LEVEL_ORDER[nextLevel] > ACCESS_LEVEL_ORDER[merged[domainId]]) {
        merged[domainId] = nextLevel;
      }
    }
  }
  return merged;
};

/**
 * Resolve whether the supplied grant map satisfies a requested domain level.
 *
 * @param {Record<string, string> | null | undefined} grants
 * @param {string} domain
 * @param {"" | "read" | "write" | "root"} [level]
 * @returns {boolean}
 */
export const hasGrant = (grants, domain, level = "read") => {
  const normalizedDomain = normalizeString(domain).toLowerCase();
  if (!ADMIN_ACCESS_DOMAIN_IDS.includes(normalizedDomain)) {
    return false;
  }
  const normalizedLevel = normalizeAccessLevel(level, "read") || "read";
  const currentLevel = normalizeAdminGrants(grants)[normalizedDomain];
  return ACCESS_LEVEL_ORDER[currentLevel] >= ACCESS_LEVEL_ORDER[normalizedLevel];
};

/**
 * Resolve whether a user/session payload has any admin-route visibility.
 *
 * @param {{role?: string, adminGrants?: Record<string, string>, isOwner?: boolean} | null | undefined} user
 * @returns {boolean}
 */
export const canAccessAdmin = (user) => {
  if (!user) {
    return false;
  }
  if (user.isOwner === true || normalizeString(user.role).toLowerCase() === "owner") {
    return true;
  }
  const grants = normalizeAdminGrants(user.adminGrants);
  return ADMIN_ACCESS_DOMAIN_IDS.some((domainId) => hasGrant(grants, domainId, "read"));
};

/**
 * Resolve a display role label from a user's access footprint.
 *
 * @param {{
 *   isOwner?: boolean,
 *   role?: string,
 *   adminGrants?: Record<string, string>,
 *   groups?: Array<{name?: string}>
 * }} user
 * @returns {string}
 */
export const deriveRoleLabel = (user = {}) => {
  if (user.isOwner === true || normalizeString(user.role).toLowerCase() === "owner") {
    return "owner";
  }
  const groupNames = Array.isArray(user.groups) ? user.groups.map((group) => normalizeString(group?.name).toLowerCase()) : [];
  if (groupNames.includes("admin")) {
    return "admin";
  }
  if (groupNames.includes("moderator")) {
    return "moderator";
  }
  if (canAccessAdmin(user)) {
    return "admin";
  }
  return "member";
};

/**
 * Derive legacy permissions from baseline capabilities plus the new domain
 * grant model so older guards can keep working while routes migrate.
 *
 * @param {{
 *   isOwner?: boolean,
 *   role?: string,
 *   permissions?: string[],
 *   adminGrants?: Record<string, string>
 * }} user
 * @returns {string[]}
 */
export const deriveLegacyPermissions = (user = {}) => {
  const derived = new Set(normalizeCapabilities(user.permissions));
  const isOwner = user.isOwner === true || normalizeString(user.role).toLowerCase() === "owner";
  const grants = normalizeAdminGrants(user.adminGrants);

  if (isOwner) {
    BASELINE_USER_CAPABILITIES.forEach((permission) => derived.add(permission));
    derived.add("admin");
    derived.add("manage_users");
    derived.add("manage_settings");
    derived.add("moderate_requests");
    derived.add("read_requests");
    derived.add("read_library");
    derived.add("read_ai_status");
    return Array.from(derived).sort();
  }

  BASELINE_USER_CAPABILITIES.forEach((permission) => {
    if (derived.has(permission)) {
      return;
    }
  });

  for (const [permission, mappings] of Object.entries(LEGACY_PERMISSION_DOMAIN_MAP)) {
    if (permission === "admin") {
      if (canAccessAdmin({adminGrants: grants})) {
        derived.add("admin");
      }
      continue;
    }
    if (mappings.some((entry) => hasGrant(grants, entry.domain, entry.level))) {
      derived.add(permission);
    }
  }

  return Array.from(derived).sort();
};

const fullAdminGrantMap = Object.freeze(Object.fromEntries(ADMIN_ACCESS_DOMAIN_IDS.map((domainId) => [domainId, "root"])));

/**
 * Seed the required default permission groups for new installs.
 *
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   description: string,
 *   isDefault: boolean,
 *   permissions: string[],
 *   adminGrants: Record<string, "" | "read" | "write" | "root">
 * }>}
 */
export const seedPermissionGroups = () => ([
  {
    id: "member",
    name: "Member",
    description: "Default reader access for signed-in Scriptarr users.",
    isDefault: true,
    permissions: [...BASELINE_USER_CAPABILITIES],
    adminGrants: normalizeAdminGrants({})
  },
  {
    id: "moderator",
    name: "Moderator",
    description: "Request triage and operational library visibility without full system control.",
    isDefault: false,
    permissions: [...BASELINE_USER_CAPABILITIES],
    adminGrants: normalizeAdminGrants({
      overview: "read",
      library: "read",
      calendar: "read",
      activity: "read",
      wanted: "read",
      requests: "root"
    })
  },
  {
    id: "admin",
    name: "Admin",
    description: "Full administrative control across Moon route families.",
    isDefault: false,
    permissions: [...BASELINE_USER_CAPABILITIES],
    adminGrants: fullAdminGrantMap
  }
]);

export default {
  ADMIN_ACCESS_DOMAINS,
  ADMIN_ACCESS_DOMAIN_IDS,
  ACCESS_LEVELS,
  BASELINE_USER_CAPABILITIES,
  canAccessAdmin,
  deriveLegacyPermissions,
  deriveRoleLabel,
  hasGrant,
  mergeAdminGrantMaps,
  normalizeAccessLevel,
  normalizeAdminGrants,
  normalizeCapabilities,
  seedPermissionGroups
};
