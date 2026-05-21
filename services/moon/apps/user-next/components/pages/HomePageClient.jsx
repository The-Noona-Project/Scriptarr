"use client";

/**
 * @file Personalized homepage for Moon's Next user app.
 */

import HomeShelfRow from "../home/HomeShelfRow.jsx";
import {useMoonJson} from "../../lib/api.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView} from "../StateView.jsx";
import {HomeShelfSkeleton} from "../TitleListLoading.jsx";

/**
 * Render Moon's personalized home surface.
 *
 * @returns {import("react").ReactNode}
 */
export const HomePageClient = () => {
  const {auth, branding, loaded: chromeLoaded = false, loginUrl} = useMoonChrome();
  const siteName = branding?.siteName || "Scriptarr";
  const {loading, refreshing, error, status, data} = useMoonJson("/api/moon-v3/user/home", {
    enabled: Boolean(chromeLoaded && auth),
    fallback: {
      latestTitles: [],
      continueReading: [],
      requests: [],
      following: [],
      shelves: []
    },
    persistentCache: {userKey: auth?.discordUserId, scope: "home"}
  });

  if (chromeLoaded && (!auth || status === 401)) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        detail="Sign in with Discord to unlock your bookshelf, recent library drops, and personalized reading rows."
      />
    );
  }

  const shelves = Array.isArray(data?.shelves) ? data.shelves : [];
  const bookshelf = shelves.find((shelf) => shelf.id === "bookshelf") || null;
  const secondaryShelves = shelves.filter((shelf) => shelf.id !== "bookshelf");

  if (error && !shelves.length) {
    return <ErrorView detail={error} />;
  }

  if ((!chromeLoaded || loading) && !shelves.length) {
    return <HomeShelfSkeleton shelves={3} itemsPerShelf={5} />;
  }

  return (
    <div className="moon-home-layout">
      {error ? <div className="moon-inline-error" role="status">{error}</div> : null}
      {refreshing ? <span className="moon-browse-refresh-dot moon-home-refresh-dot" aria-live="polite">Refreshing</span> : null}
      {bookshelf ? (
        <HomeShelfRow shelf={bookshelf} />
      ) : (
        <section className="moon-panel moon-section">
          <div className="moon-section-head">
            <div>
              <span className="moon-kicker">Personalized</span>
              <h2>Your Bookshelf</h2>
            </div>
          </div>
          <EmptyView
            title="Your bookshelf is waiting"
            detail={`Open any chapter and ${siteName} will turn this into a continue-reading row for the titles you are actively reading.`}
          />
        </section>
      )}

      {secondaryShelves.length ? secondaryShelves.map((shelf) => (
        <HomeShelfRow key={shelf.id} shelf={shelf} />
      )) : null}

      {!bookshelf && !secondaryShelves.length ? (
        <section className="moon-panel moon-section">
          <EmptyView
            title={`${siteName} is still empty`}
            detail="Once the library importer brings in real titles, the home screen will light up with recent rows and personalized tag shelves."
          />
        </section>
      ) : null}
    </div>
  );
};

export default HomePageClient;
