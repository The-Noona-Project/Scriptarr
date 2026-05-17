/**
 * @file Helpers for compact, paged user title lists.
 */

/**
 * Normalize an arbitrary value into an array.
 *
 * @param {unknown} value
 * @returns {Array<any>}
 */
const toArray = (value) => Array.isArray(value) ? value : [];

/**
 * Merge paged title rows while preserving server order and dropping duplicate ids.
 *
 * @param {Array<any>} current
 * @param {Array<any>} incoming
 * @param {{append?: boolean}} [options]
 * @returns {Array<any>}
 */
export const mergePagedTitleRows = (current, incoming, {append = true} = {}) => {
  const rows = append ? [...toArray(current), ...toArray(incoming)] : toArray(incoming);
  const seenIds = new Set();
  const merged = [];

  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (id) {
      if (seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
    }
    merged.push(row);
  }

  return merged;
};

export default {
  mergePagedTitleRows
};
