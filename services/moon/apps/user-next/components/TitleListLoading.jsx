"use client";

/**
 * @file Once UI leaf loading primitives for paged Moon title lists.
 */

import dynamic from "next/dynamic";

const OnceSkeleton = dynamic(
  () => import("@once-ui-system/core/components/Skeleton").then((module) => module.Skeleton),
  {
    ssr: false,
    loading: () => <span className="moon-once-skeleton-fallback" />
  }
);

const OnceInfiniteScroll = dynamic(
  () => import("@once-ui-system/core/components/InfiniteScroll").then((module) => module.InfiniteScroll),
  {
    ssr: false
  }
);

/**
 * Render Once UI's InfiniteScroll from a user-list leaf component.
 *
 * @param {import("@once-ui-system/core/components/InfiniteScroll").InfiniteScrollProps<any>} props
 * @returns {import("react").ReactNode}
 */
export const TitleListInfiniteScroll = (props) => (
  <OnceInfiniteScroll {...props} />
);

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
