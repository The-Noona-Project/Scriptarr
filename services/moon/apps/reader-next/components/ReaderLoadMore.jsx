"use client";

/**
 * @file Automatic reader sentinel with a manual load-next fallback.
 */

import {useEffect, useRef, useState} from "react";

/**
 * Render the infinite-reader load sentinel.
 *
 * @param {{loadMore: () => Promise<boolean>, label?: string}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderLoadMore = ({loadMore, label = "Load next"}) => {
  const sentinelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [pending, setPending] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState("");

  const runLoad = async () => {
    if (pending || !hasMore) {
      return;
    }
    setPending(true);
    setError("");
    try {
      const result = await loadMore();
      if (result === false) {
        setHasMore(false);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the next pages.");
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!hasMore || pending || !entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      void runLoad();
    }, {rootMargin: "360px 0px", threshold: 0.01});
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, pending]);

  if (!hasMore) {
    return null;
  }

  return (
    <>
      <div ref={sentinelRef} className="reader-load-sentinel" aria-hidden="true" />
      <div className="reader-loading-next">
        {pending ? "Loading next pages." : <button type="button" onClick={runLoad}>{label}</button>}
        {error ? <p>{error}</p> : null}
      </div>
    </>
  );
};

export default ReaderLoadMore;
