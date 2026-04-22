"use client";

/**
 * @file Personalized Moon homepage shelf row.
 */

import Link from "next/link";
import {Scroller} from "@once-ui-system/core";
import {buildLibraryPath} from "../../lib/routes.js";
import HomeArtCard from "./HomeArtCard.jsx";

/**
 * Render a cover-led shelf row.
 *
 * @param {{shelf: Record<string, any>}} props
 * @returns {import("react").ReactNode}
 */
export const HomeShelfRow = ({shelf}) => {
  const items = Array.isArray(shelf?.items) ? shelf.items : [];
  const browseHref = shelf?.kind === "recent" && shelf?.typeSlug ? buildLibraryPath(shelf.typeSlug) : "";

  if (!items.length) {
    return null;
  }

  return (
    <section className="moon-home-shelf">
      <div className="moon-home-shelf-head">
        <div>
          <span className="moon-kicker">{shelf.kind === "bookshelf" ? "Personalized" : shelf.kind === "tag" ? "Your taste" : "Library"}</span>
          <h2>{shelf.title}</h2>
          {shelf.subtitle ? <p>{shelf.subtitle}</p> : null}
        </div>
        {browseHref ? (
          <Link href={browseHref} className="moon-home-shelf-link">
            Open {shelf.typeLabel || "library"}
          </Link>
        ) : null}
      </div>
      <Scroller direction="row" className="moon-home-scroller" gap="20">
        {items.map((item) => (
          <div
            key={`${shelf.id}:${item?.id || item?.titleId || item?.mediaId || item?.title || "item"}`}
            className="moon-home-scroller-item"
          >
            <HomeArtCard item={item} shelfKind={shelf.kind} />
          </div>
        ))}
      </Scroller>
    </section>
  );
};

export default HomeShelfRow;
