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


/** @param {string} actorId current admin identity @param {string} titleId canonical title @returns {string} actor-scoped pending receipt key */
const receiptKey = (actorId, titleId) => `scriptarr:chapter-repair:v1:${encodeURIComponent(actorId)}:${encodeURIComponent(titleId)}`;

/**
 * Restore only a bounded, valid mutation receipt; browser storage is untrusted and optional.
 * @param {Storage} storage tab-local storage
 * @param {string} actorId current admin identity
 * @param {string} titleId canonical title
 * @returns {any} pending receipt or null
 */
export const readPendingRepair = (storage, actorId, titleId) => {
  try {
    const raw = storage.getItem(receiptKey(actorId, titleId));
    if (!raw || raw.length > 20000) return null;
    const saved = JSON.parse(raw), ids = saved?.body?.chapterIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id) || [".", ".."].includes(id))
      || !/^chapter-repair:[A-Za-z0-9:._-]{1,180}$/.test(saved?.body?.requestId || "")
      || saved.scope !== JSON.stringify([titleId, [...ids].sort()])) return null;
    return {scope: saved.scope, body: {chapterIds: [...ids], requestId: saved.body.requestId}};
  } catch { return null; }
};

/**
 * Retain an unresolved receipt before sending, or clear it only after acknowledgement.
 * @param {Storage} storage tab-local storage
 * @param {string} actorId current admin identity
 * @param {string} titleId canonical title
 * @param {any} receipt pending receipt, or null after acknowledgement
 * @returns {void}
 */
export const savePendingRepair = (storage, actorId, titleId, receipt) => {
  try {
    if (receipt) storage.setItem(receiptKey(actorId, titleId), JSON.stringify(receipt));
    else storage.removeItem(receiptKey(actorId, titleId));
  } catch { /* Keep the in-memory receipt when private storage is unavailable. */ }
};
