"use client";

/**
 * @file Cover-led homepage card for Moon's personalized shelf rows.
 */

import Link from "next/link";
import {HoverCard} from "../UiPrimitives.jsx";
import {buildReaderPath, buildTitlePath} from "../../lib/titleRoutes.js";
import {formatDate, formatProgress} from "../../lib/date.js";
import CoverImage from "../CoverImage.jsx";

const resolveTypeSlug = (item) => item?.libraryTypeSlug || item?.mediaType || "manga";
const resolveTitleId = (item) => item?.id || item?.titleId || item?.mediaId || "";
const resolveTitleHref = (item) => buildTitlePath(resolveTypeSlug(item), resolveTitleId(item));
const resolveArtHref = (item, shelfKind) => {
  const typeSlug = resolveTypeSlug(item);
  const titleId = resolveTitleId(item);
  const chapterId = item?.readerTarget?.chapterId || item?.bookmark?.chapterId || "";

  if (chapterId) {
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
  const artHref = resolveArtHref(item, shelfKind);
  const titleHref = resolveTitleHref(item);
  const tags = Array.isArray(item?.tags) ? item.tags.filter(Boolean).slice(0, 3) : [];

  return (
    <HoverCard
      trigger={(
        <article className="moon-home-art-card">
          <Link href={artHref} className="moon-home-art-card-art" aria-label={`Read ${item?.title || "title"}`}>
            <CoverImage
              title={item?.title || "Title"}
              coverUrl={item?.coverUrl || ""}
              coverThumbUrl={item?.coverThumbUrl || ""}
              fallbackClassName="moon-home-art-card-fallback"
            />
            <div className="moon-home-art-card-shade" />
          </Link>
          <div className="moon-home-art-card-copy">
            <span className="moon-home-art-card-status">{resolveStatusLine(item, shelfKind)}</span>
            <Link href={titleHref}>{item?.title || "Untitled"}</Link>
            <span>{resolveMetaLine(item, shelfKind)}</span>
          </div>
        </article>
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
