/** @file Bounded chapter selection and stable retry request identity. */

/** @param {any[]} chapters catalog damage rows @returns {any[]} source-bound repair choices */
export const selectableRepairChapters = chapters => (Array.isArray(chapters) ? chapters : [])
  .filter(chapter => chapter?.id && chapter.sourceUrl && (!chapter.available || chapter.qualityStatus !== "clean" || Number(chapter.missingPageCount) > 0));

/**
 * Reuse an interrupted request for the same exact selection without relying on render timing.
 * @param {any} previous previous request receipt
 * @param {string} titleId canonical title
 * @param {string[]} chapterIds selected chapter identities
 * @param {() => string} [newId] injectable identity factory
 * @returns {{scope: string, body: {chapterIds: string[], requestId: string}}} stable intake request
 */
export const repairRequest = (previous, titleId, chapterIds, newId = () => crypto.randomUUID()) => {
  const ids = [...new Set(chapterIds)].sort();
  if (!ids.length || ids.length > 50) throw new Error("Select 1–50 chapters.");
  const scope = JSON.stringify([titleId, ids]);
  return previous?.scope === scope ? previous : {scope, body: {chapterIds: ids, requestId: `chapter-repair:${newId()}`}};
};
