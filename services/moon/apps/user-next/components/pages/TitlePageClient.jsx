"use client";

/**
 * @file Series detail page for Moon's Once UI Next user app.
 */

import {startTransition, useMemo, useState} from "react";
import {useRouter} from "next/navigation";
import {Button, Flex} from "@once-ui-system/core";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {buildReaderPathForTitle, buildTitlePathForTitle} from "../../lib/routes.js";
import {formatDate} from "../../lib/date.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

const sortChapters = (chapters) => [...(Array.isArray(chapters) ? chapters : [])].sort((left, right) => {
  const leftNumber = Number.parseFloat(String(left?.chapterNumber || "0"));
  const rightNumber = Number.parseFloat(String(right?.chapterNumber || "0"));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && rightNumber !== leftNumber) {
    return rightNumber - leftNumber;
  }
  return Date.parse(String(right?.releaseDate || "")) - Date.parse(String(left?.releaseDate || ""));
});

/**
 * Render the title page.
 *
 * @param {{titleId: string, typeSlug?: string}} props
 * @returns {import("react").ReactNode}
 */
export const TitlePageClient = ({titleId, typeSlug = ""}) => {
  const router = useRouter();
  const {auth, loginUrl} = useMoonChrome();
  const {loading, error, status, data, refresh, setData} = useMoonJson(`/api/moon-v3/user/title/${encodeURIComponent(titleId)}`, {
    fallback: {title: null, following: false, requests: []},
    deps: [titleId]
  });
  const [busy, setBusy] = useState(false);

  const title = data?.title || null;
  const chapters = useMemo(() => sortChapters(title?.chapters), [title?.chapters]);
  const latestChapter = chapters[0] || null;

  if (title && title.libraryTypeSlug && typeSlug && typeSlug !== title.libraryTypeSlug) {
    router.replace(buildTitlePathForTitle(title));
  }

  if (loading) {
    return <LoadingView label="Moon is loading the title summary, queue context, and chapter table." />;
  }

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to open this title"
        detail="Connect your Discord account to browse title metadata, requests, and readable chapters."
      />
    );
  }

  if (error) {
    return <ErrorView detail={error} />;
  }

  if (!title) {
    return <EmptyView title="Title unavailable" detail="Moon could not find this series in the current library." />;
  }

  const toggleFollow = () => {
    setBusy(true);
    startTransition(() => {
      void (async () => {
        const nextResult = data.following
          ? await requestJson(`/api/moon-v3/user/following/${encodeURIComponent(title.id)}`, {method: "DELETE"})
          : await requestJson("/api/moon-v3/user/following", {
            method: "POST",
            json: {
              titleId: title.id,
              title: title.title,
              latestChapter: title.latestChapter,
              mediaType: title.mediaType,
              libraryTypeLabel: title.libraryTypeLabel,
              libraryTypeSlug: title.libraryTypeSlug
            }
          });
        if (nextResult.ok) {
          setData((current) => ({...current, following: !current.following}));
        } else {
          await refresh();
        }
        setBusy(false);
      })();
    });
  };

  return (
    <div className="moon-page-grid">
      <section className="moon-panel moon-title-hero">
        <div className="moon-title-cover">
          {title.coverUrl ? (
            <img src={title.coverUrl} alt={`${title.title} cover`} loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <div className="moon-title-card-fallback"><span>{title.title.charAt(0)}</span></div>
          )}
        </div>
        <div className="moon-title-hero-copy">
          <span className="moon-kicker">{title.libraryTypeLabel || title.mediaType || "Title"}</span>
          <h1>{title.title}</h1>
          <p className="moon-support-copy">{title.summary || "Moon has not matched a richer description for this title yet."}</p>
          <div className="moon-pill-row">
            <span className="moon-pill">{title.status || "active"}</span>
            <span className="moon-pill">{title.metadataProvider || "Metadata gap"}</span>
            <span className="moon-pill">{title.releaseLabel || "Release date unknown"}</span>
            <span className="moon-pill">{title.latestChapter || "No chapter summary yet"}</span>
          </div>
          <Flex gap="12" wrap>
            {latestChapter ? (
              <Button href={buildReaderPathForTitle(title, latestChapter.id)} variant="primary" size="l">
                Read latest
              </Button>
            ) : null}
            <Button variant="secondary" size="l" onClick={toggleFollow} disabled={busy}>
              {data.following ? "Unfollow" : "Follow"}
            </Button>
          </Flex>
        </div>
      </section>

      <section className="moon-panel moon-section">
        <div className="moon-section-head">
          <div>
            <span className="moon-kicker">Chapters</span>
            <h2>Read from Moon</h2>
          </div>
        </div>
        {chapters.length ? (
          <div className="moon-chapter-list">
            {chapters.map((chapter) => (
              <a key={chapter.id} className="moon-chapter-link" href={buildReaderPathForTitle(title, chapter.id)}>
                <div>
                  <strong>{chapter.label || `Chapter ${chapter.chapterNumber || "?"}`}</strong>
                  <div className="moon-muted">{formatDate(chapter.releaseDate)} · {chapter.pageCount || 0} pages</div>
                </div>
                <div className="moon-muted">Open</div>
              </a>
            ))}
          </div>
        ) : (
          <EmptyView title="No chapters indexed" detail="Raven has not cataloged any readable chapters for this title yet." />
        )}
      </section>
    </div>
  );
};

export default TitlePageClient;
