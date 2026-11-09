const fields = ["sourcePageCount", "expectedSegmentCount", "ingestedSegmentCount", "segmentsReady"];
const count = value => Math.max(0, Number.parseInt(String(value || 0), 10) || 0);

/** Preserve segment checkpoints when a metadata-only caller omits additive fields. */
export const mergeRavenSegmentFields = (chapter, previous = {}) => ({...chapter,
  ...Object.fromEntries(fields.filter(key => !Object.hasOwn(chapter, key) && Object.hasOwn(previous, key)).map(key => [key, previous[key]]))});

/** Keep logical source-page totals separate from physical WebP segment totals. */
export const normalizeRavenSegments = chapter => {
  if (!String(chapter.ingestRevision || "").toLowerCase().startsWith("webp-") && !fields.some(key => Object.hasOwn(chapter, key))) return {};
  const sourcePageCount = count(chapter.sourcePageCount ?? chapter.pageCount);
  const expectedSegmentCount = count(chapter.expectedSegmentCount ?? sourcePageCount);
  const ingestedSegmentCount = count(chapter.ingestedSegmentCount ?? chapter.ingestedPageCount);
  return {sourcePageCount, expectedSegmentCount, ingestedSegmentCount,
    segmentsReady: chapter.segmentsReady === true};
};

/** A segmented chapter is readable only after every tile of every logical page exists. */
export const hasAllRavenSegments = chapter => {
  const revision = String(chapter.ingestRevision || "").toLowerCase();
  if (revision.startsWith("webp-") && !/^webp-[a-f0-9]{16}$/.test(revision)) return false;
  const segment = normalizeRavenSegments(chapter);
  return !Object.keys(segment).length || (segment.segmentsReady && segment.sourcePageCount > 0 && segment.sourcePageCount === count(chapter.pageCount)
    && count(chapter.ingestedPageCount) === segment.sourcePageCount && segment.expectedSegmentCount >= segment.sourcePageCount
    && segment.ingestedSegmentCount === segment.expectedSegmentCount);
};
