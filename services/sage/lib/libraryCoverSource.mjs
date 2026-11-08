/**
 * @file Shared catalog cover projection and lazy first-page fallback selection.
 */
import {createHash} from "node:crypto";

const text = (value) => typeof value === "string" ? value.trim() : "";

/**
 * Build lightweight artwork fields without loading chapter or page metadata.
 *
 * @param {object} title Catalog title or compact title card.
 * @returns {{coverUrl: string, coverThumbUrl: string, coverRevision: string}} Cover fields.
 */
export const buildTitleCoverFields = (title = {}) => {
  const id = text(title.id);
  const coverUrl = text(title.coverUrl);
  const date = Date.parse(text(title.updatedAt));
  const updatedAt = Number.isFinite(date) ? new Date(date).toISOString() : "";
  const coverRevision = createHash("sha1")
    .update([id, coverUrl, updatedAt, text(title.metadataMatchedAt)].join("|"))
    .digest("hex")
    .slice(0, 12);
  return {
    coverUrl,
    coverThumbUrl: id
      ? `/api/moon/v3/user/covers/${encodeURIComponent(id)}.webp?rev=${coverRevision}`
      : text(title.coverThumbUrl),
    coverRevision
  };
};

/**
 * Resolve primary artwork and the earliest readable chapter's first page.
 * Only the cover request loads chapters; compact card reads stay lightweight.
 *
 * @param {object} title Full normalized catalog title.
 * @returns {object | null} Authorized cover source description, or no available art.
 */
export const buildLibraryCoverSource = (title = {}) => {
  const titleId = text(title.id);
  if (!titleId) {
    return null;
  }
  const chapters = (Array.isArray(title.chapters) ? title.chapters : [])
    .filter((chapter) => text(chapter.id)
      && chapter.available !== false
      && chapter.ingestStatus === "ready"
      && /^avif-[a-f0-9]{16}$/.test(text(chapter.ingestRevision))
      && Number.isInteger(chapter.pageCount) && chapter.pageCount > 0
      && chapter.ingestedPageCount >= chapter.pageCount)
    .sort((left, right) => {
      const a = Number(text(left.chapterNumber));
      const b = Number(text(right.chapterNumber));
      if (text(left.chapterNumber) && text(right.chapterNumber) && Number.isFinite(a) && Number.isFinite(b) && a !== b) {
        return a - b;
      }
      return text(left.chapterNumber || left.label || left.id).localeCompare(
        text(right.chapterNumber || right.label || right.id), "en", {numeric: true, sensitivity: "base"}
      );
    });
  const first = chapters[0];
  const fields = buildTitleCoverFields(title);
  if (!fields.coverUrl && !first) {
    return null;
  }
  return {
    titleId,
    coverUrl: fields.coverUrl,
    coverRevision: fields.coverRevision,
    updatedAt: title.updatedAt || null,
    fallbackPagePath: first
      ? `/api/moon-v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/${encodeURIComponent(first.id)}/page/0?rev=${encodeURIComponent(first.ingestRevision)}`
      : ""
  };
};
