"use client";

/**
 * @file A-Z browse shelf row built on the same Once UI scroller pattern as Moon home.
 */

import {Scroller} from "@once-ui-system/core";
import TitleCard from "../TitleCard.jsx";

/**
 * Render one alphabetical browse shelf row.
 *
 * @param {{
 *   section: {letter: string, titles: Array<Record<string, any>>},
 *   sectionRef?: ((node: HTMLElement | null) => void) | null
 * }} props
 * @returns {import("react").ReactNode}
 */
export const BrowseLetterRow = ({section, sectionRef = null}) => {
  const titles = Array.isArray(section?.titles) ? section.titles : [];

  if (!titles.length) {
    return null;
  }

  return (
    <section className="moon-panel moon-section moon-browse-letter-section" ref={sectionRef}>
      <div className="moon-section-head moon-browse-letter-head">
        <div>
          <span className="moon-kicker">Letter</span>
          <h2>{section.letter}</h2>
        </div>
        <span className="moon-muted">
          {titles.length} title{titles.length === 1 ? "" : "s"}
        </span>
      </div>
      <Scroller direction="row" className="moon-home-scroller moon-browse-scroller" gap="24">
        {titles.map((title) => (
          <div key={title.id} className="moon-home-scroller-item moon-browse-scroller-item">
            <TitleCard title={title} variant="browse" />
          </div>
        ))}
      </Scroller>
    </section>
  );
};

export default BrowseLetterRow;
