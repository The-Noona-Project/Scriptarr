"use client";

/**
 * @file Route dispatcher for the incremental Next admin rewrite.
 */

import {canAccessAdmin, hasAdminGrant} from "../lib/access.js";
import {matchAdminRoute} from "../lib/routes.js";
import AddTitlePage from "./AddTitlePage.jsx";
import AdminDataPage from "./AdminDataPage.jsx";
import {useAdminChrome} from "./AdminProviders.jsx";
import DatabaseExplorerPage from "./DatabaseExplorerPage.jsx";
import MediaManagementPage from "./MediaManagementPage.jsx";
import QueuePage from "./QueuePage.jsx";
import RequestsPage from "./RequestsPage.jsx";
import SettingsPage from "./SettingsPage.jsx";
import SystemApiPage from "./SystemApiPage.jsx";
import SystemAiPage from "./SystemAiPage.jsx";
import SystemEventsPage from "./SystemEventsPage.jsx";
import SystemLogsPage from "./SystemLogsPage.jsx";
import SystemStatusPage from "./SystemStatusPage.jsx";
import SystemTasksPage from "./SystemTasksPage.jsx";
import SystemUpdatesPage from "./SystemUpdatesPage.jsx";
import UsersPage from "./UsersPage.jsx";

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

  if (route.id === "activity-queue") {
    return <QueuePage user={chrome.user} />;
  }

  if (route.id === "add") {
    return <AddTitlePage />;
  }

  if (route.id === "mediamanagement") {
    return <MediaManagementPage user={chrome.user} />;
  }

  if (route.id === "settings") {
    return <SettingsPage user={chrome.user} />;
  }

  if (route.id === "requests") {
    return <RequestsPage user={chrome.user} />;
  }

  if (route.id === "users") {
    return <UsersPage user={chrome.user} />;
  }

  if (route.id === "settings-database") {
    return <DatabaseExplorerPage user={chrome.user} />;
  }

  if (route.id === "system-api") {
    return <SystemApiPage user={chrome.user} />;
  }

  if (route.id === "system-logs") {
    return <SystemLogsPage />;
  }

  if (route.id === "system-events") {
    return <SystemEventsPage />;
  }

  if (route.id === "system-updates") {
    return <SystemUpdatesPage user={chrome.user} />;
  }

  if (route.id === "system-status") {
    return <SystemStatusPage />;
  }

  if (route.id === "system-tasks") {
    return <SystemTasksPage user={chrome.user} />;
  }

  if (route.id === "system-ai") {
    return <SystemAiPage user={chrome.user} />;
  }

  return <AdminDataPage route={route} />;
};

export default AdminPageRouter;
