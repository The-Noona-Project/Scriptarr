/** @file Canonical, reader-ready Discord release projections. */
import {createHash} from "node:crypto";
import {hasReadyReaderRevision} from "./readerVariants.mjs";

const text = value => typeof value === "string" ? value.trim() : "";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Stable per-title checkpoint identity, independent of task history.
 * @param {string} titleId Canonical catalog identity.
 * @returns {string} Durable job identity.
 */
export const releaseTitleJobId = titleId => `portal_release_title_${hash(titleId)}`;

/** Select complete logical chapters, ordered for reading rather than ingest time.
 * @param {object} title Full canonical catalog title.
 * @returns {object[]} Readable chapters.
 */
export const releaseReadyChapters = title => (Array.isArray(title.chapters) ? title.chapters : [])
  .filter(c => text(c.id) && c.available !== false && c.ingestStatus === "ready"
    && c.pageCount > 0 && c.ingestedPageCount >= c.pageCount && hasReadyReaderRevision(c))
  .sort((a, b) => String(a.chapterNumber || a.label || a.id).localeCompare(String(b.chapterNumber || b.label || b.id), "en", {numeric: true}));

/** Fingerprint compact state so unchanged titles do not hydrate their chapters each poll.
 * @param {object} card Compact catalog title.
 * @returns {string} Observation fingerprint.
 */
export const releaseCardVersion = card => hash([card.id, card.updatedAt, card.metadataMatchedAt,
  card.chapterCount, card.chaptersDownloaded, card.ingestedChapterCount, card.ingestStatus]);

/** Build one immutable title or chapter notification from exact canonical metadata.
 * @param {{title: object, chapters: object[], kind: string, channelId: string, publicBaseUrl: string}} options Canonical title, new chapters, destination and branding URL.
 * @returns {object} Public notification snapshot with stable delivery identity.
 */
export const buildReleaseFeedEvent = ({title, chapters, kind, channelId, publicBaseUrl}) => {
  const type = text(title.libraryTypeSlug || title.mediaType).toLowerCase();
  const base = new URL(publicBaseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new Error("A trusted HTTP(S) public URL is required for release links.");
  const root = base.href.replace(/\/+$/, "");
  const titleUrl = `${root}/title/${encodeURIComponent(type)}/${encodeURIComponent(title.id)}`;
  const rows = chapters.map(c => ({id: c.id, chapterNumber: text(c.chapterNumber),
    label: text(c.chapterNumber) ? `Chapter ${text(c.chapterNumber)}` : text(c.label).replace(/\s+Last Read\b.*$/i, "") || "Chapter",
    readerUrl: `${root}/reader/${encodeURIComponent(type)}/${encodeURIComponent(title.id)}/${encodeURIComponent(c.id)}`}));
  const key = hash([title.id, kind, rows.map(c => c.id).sort(), channelId]);
  return {id: `release-feed:${hash(title.id)}:${key.slice(0, 24)}`, kind, channelId, nonce: `rf${key.slice(0, 23)}`,
    titleId: title.id, titleName: text(title.title), libraryTypeSlug: type,
    libraryTypeLabel: text(title.libraryTypeLabel) || ({manga: "Manga", manhwa: "Manhwa", manhua: "Manhua", oel: "OEL"})[type] || type,
    titleUrl, readerUrl: rows[0]?.readerUrl || "", coverUrl: text(title.coverUrl),
    summary: text(title.summary), author: text(title.author), tags: Array.isArray(title.tags) ? title.tags.filter(t => typeof t === "string") : [],
    metadataProvider: text(title.metadataProvider), chapterCount: releaseReadyChapters(title).length, chapters: rows};
};
