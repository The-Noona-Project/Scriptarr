"use client";

/**
 * @file Once UI leaf loading primitives for paged Moon title lists.
 */

import dynamic from "next/dynamic";
import {Fragment, useEffect, useState} from "react";

const OnceSkeleton = dynamic(
  () => import("@once-ui-system/core/components/Skeleton").then((module) => module.Skeleton),
  {
    ssr: false,
    loading: () => <span className="moon-once-skeleton-fallback" />
  }
);

let infiniteScrollLoader = null;

const loadOnceInfiniteScroll = () => {
  infiniteScrollLoader ||= import("@once-ui-system/core/components/InfiniteScroll").then((module) => module.InfiniteScroll);
  return infiniteScrollLoader;
};

const ImmediateTitleList = ({items = [], renderItem, className = ""}) => (
  <>
    {items.map((item, index) => (
      <Fragment key={item?.id || index}>
        {renderItem(item, index)}
      </Fragment>
    ))}
    <div className={className || undefined} aria-hidden="true" />
  </>
);

/**
 * Render Once UI's InfiniteScroll from a user-list leaf component.
 *
 * @param {import("@once-ui-system/core/components/InfiniteScroll").InfiniteScrollProps<any>} props
 * @returns {import("react").ReactNode}
 */
export const TitleListInfiniteScroll = (props) => {
  const [InfiniteScrollComponent, setInfiniteScrollComponent] = useState(null);

  useEffect(() => {
    let active = true;
    loadOnceInfiniteScroll()
      .then((component) => {
        if (active) {
          setInfiniteScrollComponent(() => component);
        }
      })
      .catch(() => {
        if (active) {
          setInfiniteScrollComponent(null);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (!InfiniteScrollComponent) {
    return <ImmediateTitleList {...props} />;
  }

  return <InfiniteScrollComponent {...props} />;
};

/**
 * Render card-shaped placeholders for the browse grid.
 *
 * @param {{count?: number}} props
 * @returns {import("react").ReactNode}
 */
export const TitleCardGridSkeleton = ({count = 12}) => (
  <div className="moon-browse-grid moon-title-card-skeleton-grid" aria-busy="true" aria-label="Loading titles">
    {Array.from({length: count}).map((_, index) => (
      <article className="moon-title-card moon-title-card-skeleton is-browse" key={index}>
        <div className="moon-title-card-media moon-title-card-skeleton-media">
          <OnceSkeleton shape="block" className="moon-once-skeleton-fill" delay={String((index % 4) + 1)} />
        </div>
        <div className="moon-title-card-copy">
          <div className="moon-title-card-meta">
            <OnceSkeleton shape="line" width="s" height="xs" delay={String((index % 4) + 1)} />
            <OnceSkeleton shape="line" width="xs" height="xs" delay={String((index % 4) + 2)} />
          </div>
          <OnceSkeleton shape="line" width="l" height="s" delay={String((index % 4) + 1)} />
          <OnceSkeleton shape="line" width="xl" height="xs" delay={String((index % 4) + 2)} />
          <OnceSkeleton shape="line" width="m" height="xs" delay={String((index % 4) + 3)} />
          <OnceSkeleton shape="line" width="s" height="xs" delay={String((index % 4) + 4)} />
        </div>
      </article>
    ))}
  </div>
);

/**
 * Render dense row placeholders for the library list.
 *
 * @param {{count?: number}} props
 * @returns {import("react").ReactNode}
 */
export const TitleRowListSkeleton = ({count = 8}) => (
  <div className="moon-library-title-list moon-library-title-skeleton-list" aria-busy="true" aria-label="Loading library titles">
    {Array.from({length: count}).map((_, index) => (
      <article className="moon-library-title-row moon-library-title-row-skeleton" key={index}>
        <div className="moon-library-title-cover">
          <OnceSkeleton shape="block" className="moon-once-skeleton-fill" delay={String((index % 4) + 1)} />
        </div>
        <div className="moon-library-title-main">
          <OnceSkeleton shape="line" width="m" height="xs" delay={String((index % 4) + 1)} />
          <OnceSkeleton shape="line" width="xl" height="s" delay={String((index % 4) + 2)} />
          <OnceSkeleton shape="line" width="xl" height="xs" delay={String((index % 4) + 3)} />
        </div>
        <div className="moon-library-title-side">
          <OnceSkeleton shape="line" width="s" height="xs" delay={String((index % 4) + 1)} />
          <OnceSkeleton shape="line" width="s" height="xs" delay={String((index % 4) + 2)} />
        </div>
      </article>
    ))}
  </div>
);

/**
 * Render cover-led shelf placeholders for the home page.
 *
 * @param {{shelves?: number, itemsPerShelf?: number}} props
 * @returns {import("react").ReactNode}
 */
export const HomeShelfSkeleton = ({shelves = 3, itemsPerShelf = 5}) => (
  <div className="moon-home-layout" aria-busy="true" aria-label="Loading home shelves">
    {Array.from({length: shelves}).map((_, shelfIndex) => (
      <section className="moon-home-shelf moon-home-shelf-skeleton" key={shelfIndex}>
        <div className="moon-home-shelf-head">
          <div className="moon-home-shelf-skeleton-copy">
            <OnceSkeleton shape="line" width="s" height="xs" delay={String((shelfIndex % 4) + 1)} />
            <OnceSkeleton shape="line" width="l" height="m" delay={String((shelfIndex % 4) + 2)} />
            <OnceSkeleton shape="line" width="xl" height="xs" delay={String((shelfIndex % 4) + 3)} />
          </div>
        </div>
        <div className="moon-home-scroller moon-home-skeleton-row">
          {Array.from({length: itemsPerShelf}).map((__, itemIndex) => (
            <div className="moon-home-scroller-item" key={itemIndex}>
              <article className="moon-home-art-card moon-home-art-card-skeleton">
                <OnceSkeleton shape="block" className="moon-once-skeleton-fill" delay={String((itemIndex % 4) + 1)} />
              </article>
            </div>
          ))}
        </div>
      </section>
    ))}
  </div>
);
