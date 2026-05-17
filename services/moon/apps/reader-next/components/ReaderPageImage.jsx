"use client";

/**
 * @file Reader page image with a visible retry state for failed page loads.
 */

import {useState} from "react";

/**
 * Render one reader page image and expose a retry if the browser fails it.
 *
 * @param {{page: {index: number, label?: string, src?: string, missing?: boolean}, chapterId: string, showPageNumbers?: boolean, eager?: boolean}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderPageImage = ({page, chapterId, showPageNumbers = true, eager = false}) => {
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  if (page?.missing || !page?.src) {
    return (
      <figure className="reader-page-frame reader-page-placeholder">
        <div className="reader-skeleton-page" />
      </figure>
    );
  }

  return (
    <figure
      className={`reader-page-frame ${failed ? "has-image-error" : ""}`.trim()}
      data-reader-page
      data-chapter-id={chapterId}
      data-page-index={page.index}
    >
      {failed ? (
        <div className="reader-page-retry">
          <strong>Page {page.index + 1} did not load.</strong>
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              setRetryKey((value) => value + 1);
            }}
          >
            Retry page
          </button>
        </div>
      ) : (
        <img
          key={`${page.src}:${retryKey}`}
          src={page.src}
          alt={page.label || `Page ${page.index + 1}`}
          draggable="false"
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={eager ? "high" : "auto"}
          onError={() => setFailed(true)}
        />
      )}
      {showPageNumbers ? <figcaption>{page.index + 1}</figcaption> : null}
    </figure>
  );
};

export default ReaderPageImage;
