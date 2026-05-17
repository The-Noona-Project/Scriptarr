"use client";

/**
 * @file Top and bottom chrome for the fullscreen reader app.
 */

import {formatProgress} from "../lib/date.js";
import {buildTitlePathForTitle} from "../lib/routes.js";

/**
 * Render reader top and bottom control bars.
 *
 * @param {{title: any, activeChapter: any, activePageIndex: number, pageCount: number, onBookmark: () => void, onSettings: () => void, onFullscreen: () => void, onPrevious: () => void, onNext: () => void, onSeek: (pageIndex: number) => void}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderControls = ({
  title,
  activeChapter,
  activePageIndex,
  pageCount,
  onBookmark,
  onSettings,
  onFullscreen,
  onPrevious,
  onNext,
  onSeek
}) => {
  const total = Math.max(1, Number.parseInt(String(pageCount || 0), 10) || 1);
  const current = Math.max(0, Math.min(activePageIndex, total - 1));
  const ratio = total <= 1 ? 0 : current / Math.max(1, total - 1);

  return (
    <>
      <header className="reader-topbar">
        <a className="reader-icon-button" href={buildTitlePathForTitle(title)}>Back</a>
        <div className="reader-title-stack">
          <strong>{title.title}</strong>
          <span>{activeChapter?.label || "Chapter"} - Page {current + 1} of {total}</span>
        </div>
        <div className="reader-top-actions">
          <button className="reader-icon-button" type="button" onClick={onBookmark}>Bookmark</button>
          <button className="reader-icon-button" type="button" onClick={onSettings}>Settings</button>
          <button className="reader-icon-button" type="button" onClick={onFullscreen}>Fullscreen</button>
        </div>
      </header>
      <footer className="reader-bottombar">
        <button type="button" onClick={onPrevious}>Previous</button>
        <input
          aria-label="Page progress"
          max={Math.max(0, total - 1)}
          min="0"
          type="range"
          value={current}
          onChange={(event) => onSeek(Number.parseInt(event.target.value, 10) || 0)}
        />
        <span>{formatProgress(ratio)}</span>
        <button type="button" onClick={onNext}>Next</button>
      </footer>
    </>
  );
};

export default ReaderControls;
