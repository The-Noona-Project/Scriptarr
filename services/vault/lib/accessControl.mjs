import {
  canAccessAdmin,
  deriveLegacyPermissions,
  deriveRoleLabel,
  mergeAdminGrantMaps,
  normalizeAdminGrants,
  normalizeCapabilities,
  seedPermissionGroups
} from "@scriptarr/access";

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const slugify = (value, fallback = "group") => {
  const normalized = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

/**
 * Normalize a permission-group payload into a stable Vault record.
 *
 * @param {Record<string, unknown>} [value]
 * @param {Record<string, unknown>} [fallback]
 * @returns {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   isDefault: boolean,
 *   permissions: string[],
 *   adminGrants: Record<string, "" | "read" | "write" | "root">,
 *   createdAt: string,
 *   updatedAt: string
 * }}
 */
export const normalizePermissionGroup = (value = {}, fallback = {}) => {
  const name = normalizeString(value.name, normalizeString(fallback.name, "Group"));
  const id = slugify(value.id || fallback.id || name, "group");
  return {
    id,
    name,
    description: normalizeString(value.description, normalizeString(fallback.description)),
    isDefault: value.isDefault === true || (value.isDefault == null && fallback.isDefault === true),
    permissions: normalizeCapabilities(value.permissions ?? fallback.permissions ?? []),
    adminGrants: normalizeAdminGrants(value.adminGrants ?? fallback.adminGrants ?? {}),
    createdAt: normalizeString(value.createdAt, normalizeString(fallback.createdAt)),
    updatedAt: normalizeString(value.updatedAt, normalizeString(fallback.updatedAt))
  };
};

/**
 * Seed or repair the required default permission groups.
 *
 * @param {Array<Record<string, unknown>>} groups
 * @param {() => string} nowIso
 * @returns {ReturnType<typeof normalizePermissionGroup>[]}
 */
export const ensureSeedPermissionGroups = (groups = [], nowIso = () => new Date().toISOString()) => {
  const existingById = new Map((Array.isArray(groups) ? groups : []).map((group) => {
    const normalized = normalizePermissionGroup(group);
    return [normalized.id, normalized];
  }));

  const seeded = seedPermissionGroups().map((group) => {
    const existing = existingById.get(group.id);
    return normalizePermissionGroup({
      ...group,
      createdAt: normalizeString(existing?.createdAt, nowIso()),
      updatedAt: normalizeString(existing?.updatedAt, nowIso())
    }, existing || {});
  });

  const customGroups = Array.from(existingById.values()).filter((group) =>
    !seeded.some((seed) => seed.id === group.id)
  );

  return ensureSingleDefaultGroup([...seeded, ...customGroups]);
};

/**
 * Guarantee that exactly one permission group is marked as default.
 *
 * @param {Array<Record<string, unknown>>} groups
 * @returns {ReturnType<typeof normalizePermissionGroup>[]}
 */
export const ensureSingleDefaultGroup = (groups = []) => {
  const normalized = (Array.isArray(groups) ? groups : []).map((group) => normalizePermissionGroup(group));
  if (normalized.length === 0) {
    return [];
  }

  const preferredDefault = normalized.find((group) => group.isDefault)
    || normalized.find((group) => group.id === "member")
    || normalized[0];

  return normalized.map((group) => ({
    ...group,
    isDefault: group.id === preferredDefault.id
  }));
};

/**
 * Read the current default group id from a normalized group list.
 *
 * @param {Array<Record<string, unknown>>} groups
 * @returns {string}
 */
export const getDefaultGroupId = (groups = []) =>
  ensureSingleDefaultGroup(groups).find((group) => group.isDefault)?.id || "";

/**
 * Build the effective access payload for a stored user and their assigned
 * permission groups.
 *
 * @param {{
 *   id?: string,
 *   discordUserId?: string,
 *   username?: string,
 *   avatarUrl?: string | null,
 *   role?: string,
 *   createdAt?: string,
 *   updatedAt?: string
 * }} user
 * @param {Array<Record<string, unknown>>} groups
 * @returns {{
 *   id: string,
 *   discordUserId: string,
 *   username: string,
 *   avatarUrl: string | null,
 *   role: string,
 *   isOwner: boolean,
 *   groups: ReturnType<typeof normalizePermissionGroup>[],
 *   baselinePermissions: string[],
 *   adminGrants: Record<string, "" | "read" | "write" | "root">,
 *   permissions: string[],
 *   accessSummary: {
 *     label: string,
 *     adminDomains: string[],
 *     rootDomains: string[]
 *   },
 *   createdAt: string,
 *   updatedAt: string
 * }}
 */
export const buildEffectiveUserAccess = (user = {}, groups = []) => {
  const normalizedGroups = ensureSingleDefaultGroup(groups);
  const mergedGrants = mergeAdminGrantMaps(normalizedGroups.map((group) => group.adminGrants));
  const baselinePermissions = normalizeCapabilities(normalizedGroups.flatMap((group) => group.permissions));
  const isOwner = normalizeString(user.role).toLowerCase() === "owner";
  const role = isOwner
    ? "owner"
    : deriveRoleLabel({
      groups: normalizedGroups,
      adminGrants: mergedGrants
    });
  const permissions = deriveLegacyPermissions({
    isOwner,
    role,
    permissions: baselinePermissions,
    adminGrants: mergedGrants
  });
  const adminDomains = Object.entries(mergedGrants)
    .filter(([, level]) => level)
    .map(([domain]) => domain);
  const rootDomains = Object.entries(mergedGrants)
    .filter(([, level]) => level === "root")
    .map(([domain]) => domain);

  return {
    id: normalizeString(user.id, normalizeString(user.discordUserId)),
    discordUserId: normalizeString(user.discordUserId, normalizeString(user.id)),
    username: normalizeString(user.username, "Unknown user"),
    avatarUrl: normalizeString(user.avatarUrl) || null,
    role,
    isOwner,
    groups: normalizedGroups,
    baselinePermissions,
    adminGrants: mergedGrants,
    permissions,
    accessSummary: {
      label: isOwner
        ? "Owner"
        : canAccessAdmin({adminGrants: mergedGrants})
          ? `${adminDomains.length} admin domains`
          : "Reader access",
      adminDomains,
      rootDomains
    },
    createdAt: normalizeString(user.createdAt),
    updatedAt: normalizeString(user.updatedAt)
  };
};

export default {
  buildEffectiveUserAccess,
  ensureSeedPermissionGroups,
  ensureSingleDefaultGroup,
  getDefaultGroupId,
  normalizePermissionGroup
};
