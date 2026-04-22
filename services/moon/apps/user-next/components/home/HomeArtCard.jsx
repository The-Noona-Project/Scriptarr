"use client";

/**
 * @file Cover-led homepage card for Moon's personalized shelf rows.
 */

import Link from "next/link";
import {HoverCard} from "@once-ui-system/core";
import {buildReaderPath, buildTitlePath} from "../../lib/routes.js";
import {formatDate, formatProgress} from "../../lib/date.js";

const resolveTypeSlug = (item) => item?.libraryTypeSlug || item?.mediaType || "manga";
const resolveTitleId = (item) => item?.id || item?.titleId || item?.mediaId || "";
const resolveHref = (item, shelfKind) => {
  const typeSlug = resolveTypeSlug(item);
  const titleId = resolveTitleId(item);
  const chapterId = item?.bookmark?.chapterId || "";

  if (shelfKind === "bookshelf" && chapterId) {
    return buildReaderPath(typeSlug, titleId, chapterId);
  }

  return buildTitlePath(typeSlug, titleId);
};

const resolveStatusLine = (item, shelfKind) => {
  if (shelfKind === "bookshelf") {
    return item?.chapterLabel || item?.latestChapter || "Continue reading";
  }

  if (item?.latestChapter) {
    return `Latest ${item.latestChapter}`;
  }

  if (item?.releaseLabel) {
    return item.releaseLabel;
  }

  return item?.status || "In library";
};

const resolveMetaLine = (item, shelfKind) => {
  if (shelfKind === "bookshelf") {
    return `${formatProgress(item?.positionRatio || 0)} read`;
  }

  const chapterCount = Number.parseInt(String(item?.chaptersDownloaded || item?.chapterCount || 0), 10) || 0;
  if (chapterCount > 0) {
    return `${chapterCount} chapter${chapterCount === 1 ? "" : "s"}`;
  }

  return item?.libraryTypeLabel || item?.mediaType || "Title";
};

/**
 * Render one art-first homepage card with a hover reveal.
 *
 * @param {{
 *   item: Record<string, any>,
 *   shelfKind: string
 * }} props
 * @returns {import("react").ReactNode}
 */
export const HomeArtCard = ({item, shelfKind}) => {
  const href = resolveHref(item, shelfKind);
  const tags = Array.isArray(item?.tags) ? item.tags.filter(Boolean).slice(0, 3) : [];

  return (
    <HoverCard
      trigger={(
        <Link href={href} className="moon-home-art-card">
          {item?.coverUrl ? (
            <img
              src={item.coverUrl}
              alt={`${item?.title || "Title"} cover`}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="moon-home-art-card-fallback">
              <span>{String(item?.title || "?").charAt(0)}</span>
            </div>
          )}
          <div className="moon-home-art-card-shade" />
          <div className="moon-home-art-card-copy">
            <span className="moon-home-art-card-status">{resolveStatusLine(item, shelfKind)}</span>
            <strong>{item?.title || "Untitled"}</strong>
            <span>{resolveMetaLine(item, shelfKind)}</span>
          </div>
        </Link>
      )}
      className="moon-home-hover-card"
      direction="column"
      gap="10"
      placement="top-start"
      offsetDistance="12"
      border="neutral-alpha-medium"
      padding="20"
      background="surface"
      shadow="xl"
      radius="xl"
    >
      <span className="moon-kicker">{item?.libraryTypeLabel || item?.mediaType || "Title"}</span>
      <h3>{item?.title || "Untitled"}</h3>
      <p>{item?.summary || "Moon is still gathering a richer summary for this title."}</p>
      <div className="moon-home-hover-meta">
        <span>{resolveStatusLine(item, shelfKind)}</span>
        <span>{resolveMetaLine(item, shelfKind)}</span>
        <span>{formatDate(item?.updatedAt || item?.releaseLabel || item?.metadataMatchedAt)}</span>
      </div>
      {tags.length ? (
        <div className="moon-pill-row">
          {tags.map((tag) => (
            <span key={tag} className="moon-pill">{tag}</span>
          ))}
        </div>
      ) : null}
    </HoverCard>
  );
};

export default HomeArtCard;
