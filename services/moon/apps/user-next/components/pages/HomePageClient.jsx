"use client";

/**
 * @file Personalized homepage for Moon's Once UI Next user app.
 */

import HomeShelfRow from "../home/HomeShelfRow.jsx";
import {useMoonJson} from "../../lib/api.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

/**
 * Render Moon's personalized home surface.
 *
 * @returns {import("react").ReactNode}
 */
export const HomePageClient = () => {
  const {auth, loginUrl} = useMoonChrome();
  const {loading, error, status, data} = useMoonJson("/api/moon-v3/user/home", {
    fallback: {
      latestTitles: [],
      continueReading: [],
      requests: [],
      following: [],
      shelves: []
    }
  });

  if (loading) {
    return <LoadingView label="Moon is building your shelves, recent arrivals, and reading-pattern rows." />;
  }

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        detail="Sign in with Discord to unlock your bookshelf, recent library drops, and personalized reading rows."
      />
    );
  }

  if (error) {
    return <ErrorView detail={error} />;
  }

  const shelves = Array.isArray(data?.shelves) ? data.shelves : [];
  const bookshelf = shelves.find((shelf) => shelf.id === "bookshelf") || null;
  const secondaryShelves = shelves.filter((shelf) => shelf.id !== "bookshelf");

  return (
    <div className="moon-home-layout">
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
            detail="Open any chapter and Moon will turn this into a continue-reading row that feels more like Plex or Kavita."
          />
        </section>
      )}

      {secondaryShelves.length ? secondaryShelves.map((shelf) => (
        <HomeShelfRow key={shelf.id} shelf={shelf} />
      )) : null}

      {!bookshelf && !secondaryShelves.length ? (
        <section className="moon-panel moon-section">
          <EmptyView
            title="Moon is still empty"
            detail="Once Raven imports real titles, the home screen will light up with recent rows and personalized tag shelves."
          />
        </section>
      ) : null}
    </div>
  );
};

export default HomePageClient;
