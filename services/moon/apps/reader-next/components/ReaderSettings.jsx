"use client";

/**
 * @file Reader settings drawer and chapter/bookmark rail.
 */

import {formatDate} from "../lib/date.js";
import {buildReaderPath, buildReaderPathForTitle} from "../lib/routes.js";
import ReaderSegmented from "./ReaderSegmented.jsx";

const LAYOUT_MODES = [
  {label: "Single", value: "single"},
  {label: "Double", value: "double"},
  {label: "Manga double", value: "manga-double"},
  {label: "Webtoon", value: "webtoon"}
];
const PAGE_FITS = ["width", "height", "contain"];
const DIRECTIONS = ["ltr", "rtl"];

/**
 * Render the reader settings and navigation drawer.
 *
 * @param {any} props
 * @returns {import("react").ReactNode}
 */
export const ReaderSettings = ({
  title,
  activeChapterId,
  bookmarks,
  chapterRows,
  chapterPageInfo,
  chapterRowsLoading,
  isOpen,
  pinned,
  isPaged,
  layoutMode,
  readingDirection,
  pageFit,
  showPageNumbers,
  onClose,
  onLayoutMode,
  onReadingDirection,
  onPageFit,
  onPinned,
  onPageNumbers,
  onOpenPagedChapter,
  onLoadMoreChapters,
  containerRef
}) => (
  <aside ref={containerRef} className={`reader-settings ${isOpen || pinned ? "is-open" : ""}`.trim()} aria-label="Reader settings">
    <div className="reader-settings-head">
      <div>
        <span className="reader-eyebrow">{title.libraryTypeLabel || title.mediaType || "Reader"}</span>
        <h2>{title.title}</h2>
      </div>
      <button type="button" onClick={onClose}>Close</button>
    </div>
    <ReaderSegmented label="Layout" value={layoutMode} options={LAYOUT_MODES} onChange={onLayoutMode} />
    <ReaderSegmented label="Direction" value={readingDirection} options={DIRECTIONS} onChange={onReadingDirection} />
    <ReaderSegmented label="Fit" value={pageFit} options={PAGE_FITS} onChange={onPageFit} />
    <label className="reader-check-row">
      <input checked={pinned} type="checkbox" onChange={(event) => onPinned(event.target.checked)} />
      Pin chapter rail
    </label>
    <label className="reader-check-row">
      <input checked={showPageNumbers} type="checkbox" onChange={(event) => onPageNumbers(event.target.checked)} />
      Page numbers
    </label>
    <section className="reader-settings-section">
      <h3>Chapters</h3>
      <div className="reader-chapter-list">
        {chapterRows.map((chapter) => (
          <button
            className={chapter.id === activeChapterId ? "is-active" : ""}
            key={chapter.id}
            type="button"
            onClick={() => {
              if (isPaged) {
                void onOpenPagedChapter(chapter.id, 0);
              } else {
                window.location.assign(buildReaderPathForTitle(title, chapter.id));
              }
            }}
          >
            <strong>{chapter.label}</strong>
            <span>{formatDate(chapter.releaseDate)} - {chapter.pageCount || 0} pages</span>
          </button>
        ))}
        {chapterRowsLoading ? <p>Loading chapters.</p> : null}
        {chapterPageInfo?.hasMore ? <button type="button" onClick={onLoadMoreChapters}>Load more chapters</button> : null}
      </div>
    </section>
    <section className="reader-settings-section">
      <h3>Bookmarks</h3>
      <div className="reader-chapter-list">
        {bookmarks.length ? bookmarks.map((bookmark) => (
          <button
            key={bookmark.id}
            type="button"
            onClick={() => {
              if (isPaged) {
                void onOpenPagedChapter(bookmark.chapterId, bookmark.pageIndex || 0);
              } else {
                window.location.assign(buildReaderPath(title.libraryTypeSlug || title.mediaType || "manga", title.id, bookmark.chapterId));
              }
            }}
          >
            <strong>{bookmark.label || "Bookmark"}</strong>
            <span>Page {(bookmark.pageIndex || 0) + 1}</span>
          </button>
        )) : <p>No bookmarks yet.</p>}
      </div>
    </section>
  </aside>
);

export default ReaderSettings;
