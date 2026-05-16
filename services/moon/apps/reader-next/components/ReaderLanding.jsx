"use client";

/**
 * @file Minimal landing state for the dedicated reader app root.
 */

/**
 * Render the `/reader` app root when no title/chapter is selected.
 *
 * @returns {import("react").ReactNode}
 */
export const ReaderLanding = () => (
  <main className="reader-app reader-landing">
    <section className="reader-empty-panel">
      <span className="reader-eyebrow">Reader</span>
      <h1>Open a chapter from your library.</h1>
      <p>The fullscreen reader starts from a title page, bookshelf row, or continue-reading card.</p>
      <div className="reader-empty-actions">
        <a href="/">Home</a>
        <a href="/library">Library</a>
      </div>
    </section>
  </main>
);

export default ReaderLanding;
