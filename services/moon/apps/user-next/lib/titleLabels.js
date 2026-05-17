/**
 * @file Reader-facing title copy helpers for compact title surfaces.
 */

/**
 * Build the short action label for a compact title art or row link.
 *
 * @param {{readerTarget?: {kind?: string, label?: string} | null, latestChapter?: string} | null | undefined} title
 * @returns {string}
 */
export const resolveReaderTargetLabel = (title) => {
  const target = title?.readerTarget || null;
  const label = target?.label || title?.latestChapter || "chapter";
  if (target?.kind === "continue") {
    return `Continue ${label}`;
  }
  if (target?.kind === "next-unread") {
    return `Read next ${label}`;
  }
  if (target?.kind === "first") {
    return `Start ${label}`;
  }
  return "Open title";
};

export default {
  resolveReaderTargetLabel
};
