/**
 * @file Admin users access-control helpers.
 */

export const grantLevels = Object.freeze(["", "read", "write", "root"]);

export const normalizeArray = (value) => Array.isArray(value) ? value : [];

export const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Resolve the stable table and drawer key for a user row.
 *
 * @param {Record<string, unknown>} user
 * @returns {string}
 */
export const userRowKey = (user = {}) => normalizeString(user.discordUserId, normalizeString(user.id));

/**
 * Preserve an explicit user drawer selection only while that user still exists.
 *
 * @param {Array<Record<string, unknown>>} users
 * @param {string} selectedUserId
 * @returns {string}
 */
export const resolveExistingUserSelection = (users = [], selectedUserId = "") => {
  const normalized = normalizeString(selectedUserId);
  if (!normalized) {
    return "";
  }
  return normalizeArray(users).some((user) => userRowKey(user) === normalized) ? normalized : "";
};

/**
 * Normalize a grant level for the matrix editor.
 *
 * @param {unknown} value
 * @returns {"" | "read" | "write" | "root"}
 */
export const normalizeGrantLevel = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  return grantLevels.includes(normalized) ? normalized : "";
};

/**
 * Patch a single domain grant inside a group draft.
 *
 * @param {Record<string, unknown>} group
 * @param {string} domain
 * @param {string} level
 * @returns {Record<string, unknown>}
 */
export const patchGroupGrant = (group = {}, domain, level) => {
  const grants = {
    ...(group.adminGrants || {})
  };
  const normalizedLevel = normalizeGrantLevel(level);
  if (normalizedLevel) {
    grants[domain] = normalizedLevel;
  } else {
    delete grants[domain];
  }
  return {
    ...group,
    adminGrants: grants
  };
};

/**
 * Build user page summary counts.
 *
 * @param {Array<Record<string, unknown>>} users
 * @param {Array<Record<string, unknown>>} groups
 * @returns {Record<string, number>}
 */
export const buildUserMetrics = (users = [], groups = []) => {
  const rows = normalizeArray(users);
  return {
    total: rows.length,
    owners: rows.filter((user) => user.isOwner || user.role === "owner").length,
    admins: rows.filter((user) => normalizeArray(user.accessSummary?.adminDomains).length > 0 || user.isOwner || user.role === "owner").length,
    readers: rows.filter((user) => !user.isOwner && normalizeArray(user.accessSummary?.adminDomains).length === 0).length,
    groups: normalizeArray(groups).length
  };
};

/**
 * Build searchable text for a user row.
 *
 * @param {Record<string, unknown>} user
 * @returns {string}
 */
export const userSearchText = (user = {}) => [
  user.username,
  user.discordUserId,
  user.role,
  user.accessSummary?.label,
  ...normalizeArray(user.groups).map((group) => `${group.id} ${group.name}`)
].map((entry) => normalizeString(entry).toLowerCase()).filter(Boolean).join(" ");

/**
 * Filter users by search text and role/access bucket.
 *
 * @param {Array<Record<string, unknown>>} users
 * @param {{query?: string, filter?: string}} options
 * @returns {Array<Record<string, unknown>>}
 */
export const filterUsers = (users = [], {query = "", filter = "all"} = {}) => {
  const normalizedQuery = normalizeString(query).toLowerCase();
  return normalizeArray(users)
    .filter((user) => {
      if (filter === "owners") {
        return user.isOwner || user.role === "owner";
      }
      if (filter === "admins") {
        return normalizeArray(user.accessSummary?.adminDomains).length > 0 || user.isOwner || user.role === "owner";
      }
      if (filter === "readers") {
        return !user.isOwner && normalizeArray(user.accessSummary?.adminDomains).length === 0;
      }
      return true;
    })
    .filter((user) => !normalizedQuery || userSearchText(user).includes(normalizedQuery));
};

/**
 * Normalize a permission group into a form draft.
 *
 * @param {Record<string, unknown>} [group]
 * @returns {Record<string, unknown>}
 */
export const buildGroupDraft = (group = {}) => ({
  id: normalizeString(group.id),
  name: normalizeString(group.name),
  description: normalizeString(group.description),
  isDefault: group.isDefault === true,
  permissionsText: normalizeArray(group.permissions).join(", "),
  adminGrants: {
    ...(group.adminGrants || {})
  }
});

/**
 * Serialize a group drawer draft for Sage.
 *
 * @param {Record<string, unknown>} draft
 * @returns {Record<string, unknown>}
 */
export const serializeGroupDraft = (draft = {}) => ({
  name: normalizeString(draft.name, "Permission group"),
  description: normalizeString(draft.description),
  isDefault: draft.isDefault === true,
  permissions: normalizeString(draft.permissionsText)
    .split(",")
    .map((entry) => normalizeString(entry))
    .filter(Boolean),
  adminGrants: Object.fromEntries(Object.entries(draft.adminGrants || {})
    .map(([domain, level]) => [domain, normalizeGrantLevel(level)])
    .filter(([, level]) => level))
});

export default {
  buildGroupDraft,
  buildUserMetrics,
  filterUsers,
  grantLevels,
  normalizeGrantLevel,
  patchGroupGrant,
  resolveExistingUserSelection,
  serializeGroupDraft,
  userRowKey
};
