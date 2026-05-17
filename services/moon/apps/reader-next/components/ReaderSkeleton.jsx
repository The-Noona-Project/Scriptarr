"use client";

/**
 * @file Reader-native skeletons used while session and page chunks hydrate.
 */

/**
 * Render the first-paint reader shell while the lightweight session loads.
 *
 * @returns {import("react").ReactNode}
 */
export const ReaderInitialSkeleton = () => (
  <main className="reader-app has-visible-controls" data-layout="webtoon" data-fit="width">
    <header className="reader-topbar reader-skeleton-topbar" aria-hidden="true">
      <div className="reader-skeleton-pill" />
      <div className="reader-title-stack">
        <div className="reader-skeleton-line is-wide" />
        <div className="reader-skeleton-line is-short" />
      </div>
      <div className="reader-top-actions">
        <div className="reader-skeleton-pill" />
        <div className="reader-skeleton-pill" />
      </div>
    </header>
    <section className="reader-stage reader-stage-skeleton" aria-label="Loading reader">
      <div className="reader-page-frame reader-page-placeholder">
        <div className="reader-skeleton-page" />
      </div>
    </section>
    <footer className="reader-bottombar reader-skeleton-bottombar" aria-hidden="true">
      <div className="reader-skeleton-pill" />
      <div className="reader-skeleton-line" />
      <div className="reader-skeleton-pill" />
    </footer>
  </main>
);

/**
 * Render stable page placeholders for unloaded page chunks.
 *
 * @param {{count?: number}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderPageSkeletons = ({count = 2}) => (
  <>
    {Array.from({length: count}, (_value, index) => (
      <figure className="reader-page-frame reader-page-placeholder" key={`reader-page-skeleton-${index}`}>
        <div className="reader-skeleton-page" />
      </figure>
    ))}
  </>
);

export default ReaderInitialSkeleton;
