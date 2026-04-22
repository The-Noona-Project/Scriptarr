"use client";

/**
 * @file My Requests page for Moon's Once UI Next user app.
 */

import {useMoonJson} from "../../lib/api.js";
import {formatDate} from "../../lib/date.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

/**
 * Render the requests page.
 *
 * @returns {import("react").ReactNode}
 */
export const RequestsPageClient = () => {
  const {auth, loginUrl} = useMoonChrome();
  const {loading, error, status, data} = useMoonJson("/api/moon-v3/user/requests", {fallback: {requests: []}});

  if (loading) {
    return <LoadingView label="Moon is collecting your request history across the web app and Discord." />;
  }

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to view your requests"
        detail="Moon can show your web and Discord requests after you connect your Discord account."
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
          <span className="moon-kicker">Requests</span>
          <h2>Everything you have asked Moon to track</h2>
        </div>
      </div>
      {data.requests?.length ? (
        <div className="moon-list">
          {data.requests.map((request) => (
            <div key={request.id} className="moon-list-row">
              <div>
                <strong>{request.title}</strong>
                <div className="moon-muted">
                  {request.notes || "No request notes."}
                </div>
              </div>
              <div className="moon-muted">
                {request.status} · {formatDate(request.updatedAt, {includeTime: true})}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyView title="No requests yet" detail="Search and request a title from Moon or Noona and it will show up here." />
      )}
    </section>
  );
};

export default RequestsPageClient;
