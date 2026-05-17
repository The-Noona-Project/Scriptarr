/**
 * @file Reusable series card for Moon's Next user app.
 */

import Link from "next/link";
import {buildReaderPathForTitleTarget, buildTitlePathForTitle} from "../lib/titleRoutes.js";
import {formatCoverage} from "../lib/date.js";
import {resolveReaderTargetLabel} from "../lib/titleLabels.js";
import CoverImage from "./CoverImage.jsx";

/**
 * Render a title card with full-cover treatment.
 *
 * @param {{
 *   title: {
 *     id?: string,
 *     title?: string,
 *     summary?: string,
 *     coverUrl?: string,
 *     coverThumbUrl?: string,
 *     libraryTypeLabel?: string,
 *     libraryTypeSlug?: string,
 *     mediaType?: string,
 *     latestChapter?: string,
 *     chapterCount?: number,
 *     chaptersDownloaded?: number,
 *     readerTarget?: {chapterId?: string, label?: string, kind?: string} | null
 *   },
 *   compact?: boolean,
 *   priority?: boolean,
 *   variant?: "default" | "browse"
 * }} props
 * @returns {import("react").ReactNode}
 */
export const TitleCard = ({title, compact = false, priority = false, variant = "default"}) => {
  const titleHref = buildTitlePathForTitle(title);
  const readerHref = buildReaderPathForTitleTarget(title);
  const titleText = title?.title || "Untitled";
  const readerLabel = resolveReaderTargetLabel(title);

  return (
    <article className={`moon-title-card ${compact ? "is-compact" : ""} ${variant === "browse" ? "is-browse" : ""}`.trim()}>
      <Link href={readerHref} className="moon-title-card-media" aria-label={`${readerLabel} for ${titleText}`}>
        <CoverImage
          title={titleText}
          coverUrl={title?.coverUrl || ""}
          coverThumbUrl={title?.coverThumbUrl || ""}
          fallbackClassName="moon-title-card-fallback"
          loading={priority ? "eager" : "lazy"}
        />
      </Link>
      <Link href={titleHref} className="moon-title-card-copy" aria-label={`Open ${titleText} title page`}>
        <div className="moon-title-card-meta">
          <span>{title?.libraryTypeLabel || title?.mediaType || "Title"}</span>
          <span>{formatCoverage(title?.chaptersDownloaded, title?.chapterCount)}</span>
        </div>
        <h3>{titleText}</h3>
        <p>{title?.summary || "Open the title page to review chapters, metadata, and reading progress."}</p>
        <strong>{readerLabel}</strong>
      </Link>
    </article>
  );
};

export default TitleCard;
