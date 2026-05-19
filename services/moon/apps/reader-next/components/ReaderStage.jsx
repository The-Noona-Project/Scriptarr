"use client";

/**
 * @file Reader stage rendering for paged and webtoon modes.
 */

import {formatDate} from "../lib/date.js";
import ReaderLoadMore from "./ReaderLoadMore.jsx";
import ReaderPageImage from "./ReaderPageImage.jsx";
import {ReaderPageSkeletons} from "./ReaderSkeleton.jsx";

/**
 * Render the active reader page stage.
 *
 * @param {{title: any, layoutMode: string, pageFit: string, spreadDirection: string, isPaged: boolean, spreadPages: any[], pagedChapterId: string, webtoonChapters: any[], showPageNumbers: boolean, loadingPages?: boolean, loadMoreReady?: boolean, loadMoreKey?: string, loadMore: () => Promise<boolean | null | undefined>}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderStage = ({
  title,
  layoutMode,
  pageFit,
  spreadDirection,
  isPaged,
  spreadPages,
  pagedChapterId,
  webtoonChapters,
  showPageNumbers,
  loadingPages = false,
  loadMoreReady = true,
  loadMoreKey = "",
  loadMore
}) => (
  <section className="reader-stage" aria-label={`${title.title} reader`} data-fit={pageFit} data-layout={layoutMode}>
    {isPaged ? (
      <div className="reader-spread" data-direction={spreadDirection}>
        {spreadPages.length ? spreadPages.map((page, index) => (
          <ReaderPageImage
            chapterId={pagedChapterId}
            eager={index === 0}
            key={`${pagedChapterId}:${page.index}:${page.src || "pending"}`}
            layoutMode={layoutMode}
            page={page}
            showPageNumbers={showPageNumbers}
            titleId={title.id}
          />
        )) : (
          loadingPages ? <ReaderPageSkeletons count={layoutMode === "single" ? 1 : 2} /> : <div className="reader-empty-panel">No pages are available for this chapter.</div>
        )}
      </div>
    ) : (
      <div className="reader-webtoon-flow">
        {webtoonChapters.map((chapterPayload, chapterIndex) => (
          <section className="reader-webtoon-chapter" key={chapterPayload.chapter.id}>
            {chapterIndex === 0 ? null : (
              <header className="reader-chapter-divider">
                <strong>{chapterPayload.chapter.label}</strong>
                <span>{formatDate(chapterPayload.chapter.releaseDate)} - {chapterPayload.pageCount || chapterPayload.pages.length} pages</span>
              </header>
            )}
            {chapterPayload.pages.length ? chapterPayload.pages.map((page, pageIndex) => (
              <ReaderPageImage
                chapterId={chapterPayload.chapter.id}
                eager={chapterIndex === 0 && pageIndex === 0}
                key={`${chapterPayload.chapter.id}:${page.index}:${page.src || "pending"}`}
                layoutMode={layoutMode}
                page={page}
                showPageNumbers={showPageNumbers}
                titleId={title.id}
              />
            )) : <ReaderPageSkeletons count={2} />}
            {chapterPayload.loading ? <ReaderPageSkeletons count={1} /> : null}
            {chapterPayload.error ? <div className="reader-loading-next"><p>{chapterPayload.error}</p></div> : null}
          </section>
        ))}
        <ReaderLoadMore loadMore={loadMore} label="Load next pages" ready={loadMoreReady} resetKey={loadMoreKey} />
      </div>
    )}
  </section>
);

export default ReaderStage;
