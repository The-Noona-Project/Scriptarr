"use client";

/**
 * @file Following page for Moon's Once UI Next user app.
 */

import Link from "next/link";
import {useMoonJson} from "../../lib/api.js";
import {buildTitlePath} from "../../lib/routes.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

/**
 * Render the following page.
 *
 * @returns {import("react").ReactNode}
 */
export const FollowingPageClient = () => {
  const {auth, loginUrl} = useMoonChrome();
  const {loading, error, status, data} = useMoonJson("/api/moon-v3/user/following", {fallback: {following: []}});

  if (loading) {
    return <LoadingView label="Moon is gathering the titles you asked it to surface first." />;
  }

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to view followed titles"
        detail="Moon uses your Discord session to keep followed series and chapter alerts tied to you."
      />
    );
  }

  if (error) {
    return <ErrorView detail={error} />;
  }

  return (
    <section className="moon-panel moon-section">
      <div className="moon-section-head">
        <div>
          <span className="moon-kicker">Following</span>
          <h2>Your watched titles</h2>
        </div>
      </div>
      {data.following?.length ? (
        <div className="moon-list">
          {data.following.map((entry) => (
            <Link key={entry.titleId} className="moon-list-row" href={buildTitlePath(entry.libraryTypeSlug || entry.mediaType || "manga", entry.titleId)}>
              <div>
                <strong>{entry.title}</strong>
                <div className="moon-muted">{entry.libraryTypeLabel || entry.mediaType || "Title"}</div>
              </div>
              <div className="moon-muted">{entry.latestChapter || "Watching"}</div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyView title="Nothing followed yet" detail="Follow a title from its detail page and Moon will keep it close." />
      )}
    </section>
  );
};

export default FollowingPageClient;
