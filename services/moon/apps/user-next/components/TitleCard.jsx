/**
 * @file Reusable series card for Moon's Next user app.
 */

import Link from "next/link";
import {buildTitlePathForTitle} from "../lib/routes.js";
import {formatCoverage} from "../lib/date.js";

/**
 * Render a title card with full-cover treatment.
 *
 * @param {{
 *   title: {
 *     id?: string,
 *     title?: string,
 *     summary?: string,
 *     coverUrl?: string,
 *     libraryTypeLabel?: string,
 *     libraryTypeSlug?: string,
 *     mediaType?: string,
 *     latestChapter?: string,
 *     chapterCount?: number,
 *     chaptersDownloaded?: number
 *   },
 *   compact?: boolean,
 *   variant?: "default" | "browse"
 * }} props
 * @returns {import("react").ReactNode}
 */
export const TitleCard = ({title, compact = false, variant = "default"}) => (
  <Link
    href={buildTitlePathForTitle(title)}
    className={`moon-title-card ${compact ? "is-compact" : ""} ${variant === "browse" ? "is-browse" : ""}`.trim()}
  >
    <div className="moon-title-card-media">
      {title?.coverUrl ? (
        <img src={title.coverUrl} alt={`${title?.title || "Untitled"} cover`} loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="moon-title-card-fallback">
          <span>{String(title?.title || "U").trim().charAt(0).toUpperCase()}</span>
        </div>
      )}
    </div>
    <div className="moon-title-card-copy">
      <div className="moon-title-card-meta">
        <span>{title?.libraryTypeLabel || title?.mediaType || "Title"}</span>
        <span>{formatCoverage(title?.chaptersDownloaded, title?.chapterCount)}</span>
      </div>
      <h3>{title?.title || "Untitled"}</h3>
      <p>{title?.summary || "Open the title page to review chapters, metadata, and reading progress."}</p>
      <strong>{title?.latestChapter || "Read now"}</strong>
    </div>
  </Link>
);

export default TitleCard;
