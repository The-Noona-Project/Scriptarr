"use client";

/**
 * @file Route dispatcher for the incremental Next admin rewrite.
 */

import {canAccessAdmin, hasAdminGrant} from "../lib/access.js";
import {matchAdminRoute} from "../lib/routes.js";
import dynamic from "next/dynamic";
import {useAdminChrome} from "./AdminProviders.jsx";

const AdminRouteLoadingPanel = () => (
  <section className="admin-panel admin-state-panel">
    <div className="admin-kicker">Loading</div>
    <h2>Loading admin page</h2>
    <p>Moon is opening this admin surface.</p>
  </section>
);

const dynamicAdminPage = (loader) => dynamic(loader, {
  loading: AdminRouteLoadingPanel
});

const AdminDataPage = dynamicAdminPage(() => import("./AdminDataPage.jsx"));

const adminPageComponents = Object.freeze({
  "activity-queue": dynamicAdminPage(() => import("./QueuePage.jsx")),
  add: dynamicAdminPage(() => import("./AddTitlePage.jsx")),
  calendar: dynamicAdminPage(() => import("./CalendarPage.jsx")),
  discord: dynamicAdminPage(() => import("./DiscordPage.jsx")),
  import: dynamicAdminPage(() => import("./ImportPage.jsx")),
  ingest: dynamicAdminPage(() => import("./IngestPage.jsx")),
  mediamanagement: dynamicAdminPage(() => import("./MediaManagementPage.jsx")),
  requests: dynamicAdminPage(() => import("./RequestsPage.jsx")),
  "settings-database": dynamicAdminPage(() => import("./DatabaseExplorerPage.jsx")),
  settings: dynamicAdminPage(() => import("./SettingsPage.jsx")),
  "system-ai": dynamicAdminPage(() => import("./SystemAiPage.jsx")),
  "system-api": dynamicAdminPage(() => import("./SystemApiPage.jsx")),
  "system-events": dynamicAdminPage(() => import("./SystemEventsPage.jsx")),
  "system-logs": dynamicAdminPage(() => import("./SystemLogsPage.jsx")),
  "system-status": dynamicAdminPage(() => import("./SystemStatusPage.jsx")),
  "system-tasks": dynamicAdminPage(() => import("./SystemTasksPage.jsx")),
  "system-updates": dynamicAdminPage(() => import("./SystemUpdatesPage.jsx")),
  users: dynamicAdminPage(() => import("./UsersPage.jsx")),
  "wanted-metadata": dynamicAdminPage(() => import("./MetadataPage.jsx")),
  "wanted-missing": dynamicAdminPage(() => import("./MissingChaptersPage.jsx"))
});

/**
 * Render the active admin page or a guarded state.
 *
 * @param {{pathname: string}} props
 * @returns {import("react").ReactNode}
 */
export const AdminPageRouter = ({pathname}) => {
  const chrome = useAdminChrome();
  const route = matchAdminRoute(pathname);

  if (chrome.loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Loading</div>
        <h2>Loading admin session</h2>
        <p>Moon is checking your Discord-backed admin grants.</p>
      </section>
    );
  }

  if (!chrome.user) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Account</div>
        <h2>Admin sign-in required</h2>
        <p>Sign in with a Discord account that has Moon admin access.</p>
        {chrome.loginUrl ? <a className="admin-button solid" href={chrome.loginUrl}>Continue with Discord</a> : null}
      </section>
    );
  }

  if (!canAccessAdmin(chrome.user)) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">Access</div>
        <h2>Admin access required</h2>
        <p>This signed-in account does not have Moon admin grants.</p>
      </section>
    );
  }

  if (route.domain && !hasAdminGrant(chrome.user, route.domain, "read")) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">Access</div>
        <h2>Route grant required</h2>
        <p>Your current permission groups do not include read access for this admin area.</p>
      </section>
    );
  }

  const PageComponent = adminPageComponents[route.id] || AdminDataPage;
  return <PageComponent route={route} user={chrome.user} />;
};

export default AdminPageRouter;
