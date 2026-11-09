/** @file Reader variant validation and mixed AVIF/WebP readiness projections. */

/**
 * Require every physical segment while retaining logical source-page counts.
 * @param {object} chapter Stored chapter checkpoint.
 * @returns {boolean} Whether its derived revision is current and complete.
 */
export const hasReadyReaderRevision = (chapter = {}) => {
  const revision = String(chapter.ingestRevision || "").toLowerCase();
  if (revision.startsWith("avif-")) return true;
  if (!/^webp-[a-f0-9]{16}$/.test(revision)) return false;
  return chapter.segmentsReady === true && Number.isSafeInteger(chapter.sourcePageCount) && chapter.sourcePageCount > 0
    && chapter.sourcePageCount === chapter.pageCount && chapter.ingestedPageCount === chapter.sourcePageCount
    && Number.isSafeInteger(chapter.expectedSegmentCount) && chapter.expectedSegmentCount >= chapter.sourcePageCount
    && chapter.ingestedSegmentCount === chapter.expectedSegmentCount;
};

/**
 * Parse exact image selectors; malformed variants must never fall back to page zero.
 * @param {object} query Express query fields.
 * @returns {string} Encoded query suffix, including the leading question mark when present.
 */
export const readerVariantQuery = (query = {}) => {
  const params = new URLSearchParams();
  if (query.rev != null) {
    if (typeof query.rev !== "string" || !query.rev || query.rev.length > 160 || /[\x00-\x20\x7f]/.test(query.rev)) throw Object.assign(new Error("Invalid reader revision."), {status: 400});
    params.set("rev", query.rev);
  }
  if (query.segment != null) {
    if (typeof query.segment !== "string" || !/^(0|[1-9]\d{0,5})$/.test(query.segment)) throw Object.assign(new Error("Invalid reader segment."), {status: 400});
    params.set("segment", query.segment);
  }
  if (query.thumbnail != null) {
    if (!["true", "false"].includes(query.thumbnail) || (query.thumbnail === "true" && Number(query.segment || 0) !== 0)) throw Object.assign(new Error("Invalid reader thumbnail selector."), {status: 400});
    params.set("thumbnail", query.thumbnail);
  }
  return params.size ? `?${params}` : "";
};

/**
 * Map a logical reader page and each ordered physical tile to same-origin URLs.
 * @param {object} page Manifest logical page.
 * @param {{pageBase: string, revision: string, fallbackIndex: number}} options Reader route context.
 * @returns {object} Browser-safe page with tile URLs.
 */
export const readerPageRow = (page, {pageBase, revision, fallbackIndex}) => {
  const candidate = Number(page?.index ?? fallbackIndex);
  const index = Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : fallbackIndex;
  const src = `${pageBase}/${encodeURIComponent(String(index))}?rev=${encodeURIComponent(revision)}`;
  return {...page, index, label: typeof page?.label === "string" && page.label.trim() ? page.label.trim() : `Page ${index + 1}`, src,
    ...(Array.isArray(page?.segments) ? {segments: page.segments.map((segment, offset) => ({...segment, src: `${src}&segment=${offset}`}))} : {})};
};
