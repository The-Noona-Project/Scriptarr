/**
 * @file Status page helpers for Moon admin endpoint groups.
 */

import {normalizeString} from "./format.js";

/**
 * Resolve a stable key for a System Status endpoint group.
 *
 * @param {Record<string, unknown> | null | undefined} group
 * @param {number} index
 * @returns {string}
 */
export const resolveStatusGroupKey = (group, index) => {
  const stableKey = normalizeString(group?.id)
    || normalizeString(group?.service)
    || normalizeString(group?.label);

  return stableKey || `group-${index}`;
};

/**
 * Toggle one status group key while preserving any other open groups.
 *
 * @param {string[]} openKeys
 * @param {string} key
 * @returns {string[]}
 */
export const toggleStatusGroupKey = (openKeys, key) => {
  const normalizedKey = normalizeString(key);
  if (!normalizedKey) {
    return Array.isArray(openKeys) ? [...openKeys] : [];
  }

  const nextKeys = new Set(Array.isArray(openKeys) ? openKeys : []);
  if (nextKeys.has(normalizedKey)) {
    nextKeys.delete(normalizedKey);
  } else {
    nextKeys.add(normalizedKey);
  }

  return [...nextKeys];
};
