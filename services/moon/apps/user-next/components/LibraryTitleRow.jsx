/**
 * @file Dense title row for Moon's user library list.
 */

import Link from "next/link";
import {formatCoverage} from "../lib/date.js";
import {buildReaderPathForTitleTarget, buildTitlePathForTitle} from "../lib/titleRoutes.js";
import {resolveReaderTargetLabel} from "../lib/titleLabels.js";
import CoverImage from "./CoverImage.jsx";

/**
 * Render one dense library title row.
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
 *   }
 *   priority?: boolean
 * }} props
 * @returns {import("react").ReactNode}
 */
export const LibraryTitleRow = ({title, priority = false}) => {
  const titleHref = buildTitlePathForTitle(title);
  const readerHref = buildReaderPathForTitleTarget(title);
  const titleText = title?.title || "Untitled";
  const readerLabel = resolveReaderTargetLabel(title);

  return (
    <article className="moon-library-title-row">
      <Link href={readerHref} className="moon-library-title-cover" aria-label={`${readerLabel} for ${titleText}`}>
        <CoverImage
          title={titleText}
          coverUrl={title?.coverUrl || ""}
          coverThumbUrl={title?.coverThumbUrl || ""}
          fallbackClassName="moon-title-card-fallback"
          loading={priority ? "eager" : "lazy"}
        />
      </Link>
      <div className="moon-library-title-main">
        <div className="moon-title-card-meta">
          <span>{title?.libraryTypeLabel || title?.mediaType || "Title"}</span>
          <span>{formatCoverage(title?.chaptersDownloaded, title?.chapterCount)}</span>
        </div>
        <Link href={titleHref} className="moon-library-title-link" aria-label={`Open ${titleText} title page`}>
          {titleText}
        </Link>
        <p>{title?.summary || "Open the title page to review chapters, metadata, and reading progress."}</p>
      </div>
      <div className="moon-library-title-side">
        <span>{title?.latestChapter ? `Latest ${title.latestChapter}` : "No chapter summary yet"}</span>
        <Link href={readerHref}>{readerLabel}</Link>
      </div>
    </article>
  );
};

export default LibraryTitleRow;
