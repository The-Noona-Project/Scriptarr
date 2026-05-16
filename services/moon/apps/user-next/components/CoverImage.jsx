"use client";

/**
 * @file Resilient cover image component for Moon user cards.
 */

import {useEffect, useMemo, useState} from "react";

/**
 * Render a cover image with a thumbnail-to-source fallback chain.
 *
 * @param {{
 *   title?: string,
 *   coverUrl?: string,
 *   coverThumbUrl?: string,
 *   fallbackClassName: string,
 *   className?: string,
 *   loading?: "eager" | "lazy"
 * }} props
 * @returns {import("react").ReactNode}
 */
export const CoverImage = ({
  title = "Title",
  coverUrl = "",
  coverThumbUrl = "",
  fallbackClassName,
  className = "",
  loading = "lazy"
}) => {
  const sources = useMemo(() => Array.from(new Set([coverThumbUrl, coverUrl].filter(Boolean))), [coverThumbUrl, coverUrl]);
  const sourceKey = sources.join("|");
  const [sourceIndex, setSourceIndex] = useState(0);
  const initial = String(title || "?").trim().charAt(0).toUpperCase() || "?";
  const source = sources[sourceIndex] || "";

  useEffect(() => {
    setSourceIndex(0);
  }, [sourceKey]);

  if (!source) {
    return (
      <div className={fallbackClassName}>
        <span>{initial}</span>
      </div>
    );
  }

  return (
    <img
      className={className || undefined}
      src={source}
      alt={`${title || "Title"} cover`}
      loading={loading}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setSourceIndex((current) => current + 1)}
    />
  );
};

export default CoverImage;
