import {escapeHtml, renderCoverThumb, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";
import {formatDate, formatPercent} from "../format.js";

/**
 * Map an activity route id to its Moon v3 API path and empty-state copy.
 *
 * @param {string} routeId
 * @returns {{path: string, emptyTitle: string, emptyBody: string}}
 */
const activityConfig = (routeId) => ({
  "activity-queue": {
    path: "/api/moon/v3/admin/activity/queue",
    emptyTitle: "Queue is empty",
    emptyBody: "No Raven tasks are currently running."
  },
  "activity-history": {
    path: "/api/moon/v3/admin/activity/history",
    emptyTitle: "No task history yet",
    emptyBody: "Completed and failed task history will show up here."
  },
  "activity-blocklist": {
    path: "/api/moon/v3/admin/activity/blocklist",
    emptyTitle: "Nothing is blocked",
    emptyBody: "Denied and blocked requests will appear here."
  }
}[routeId]);

/**
 * Load an activity route payload.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   route: import("../routes.js").AdminRoute
 * }} context
 * @returns {Promise<import("../api.js").ApiResult & {routeId: string}>}
 */
export const loadActivityPage = async ({api, route}) => ({
  ...(await api.get(activityConfig(route.id).path)),
  routeId: route.id
});

/**
 * Render an activity page.
 *
 * @param {Awaited<ReturnType<typeof loadActivityPage>>} result
 * @returns {string}
 */
export const renderActivityPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Activity unavailable", result.payload?.error || "Unable to load activity data.");
  }

  const config = activityConfig(result.routeId);
  const rows = result.routeId === "activity-blocklist"
    ? (result.payload?.entries || []).map((entry) => [
      `<strong>${escapeHtml(entry.title)}</strong>`,
      escapeHtml(entry.requestedBy?.username || entry.requestedBy?.discordUserId || "Unknown"),
      renderStatusBadge(entry.status),
      escapeHtml(formatDate(entry.updatedAt, {includeTime: true}))
    ])
    : (result.payload?.tasks || []).map((task) => [
      `<div class="table-title-cell with-cover-row">${renderCoverThumb(task.coverUrl, task.titleName)}<div><strong>${escapeHtml(task.titleName)}</strong><span class="muted-copy">${escapeHtml(task.actor || task.requestedBy || "scriptarr")}</span></div></div>`,
      escapeHtml(task.requestType),
      renderStatusBadge(task.status),
      escapeHtml(formatPercent(task.percent)),
      escapeHtml(formatDate(task.updatedAt || task.queuedAt, {includeTime: true}))
    ]);

  const columns = result.routeId === "activity-blocklist"
    ? ["Title", "Requester", "Status", "Updated"]
    : ["Title", "Type", "Status", "Progress", "Updated"];

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Activity</span>
          <h2>${escapeHtml(result.routeId === "activity-blocklist" ? "Blocklist" : "Download tasks")}</h2>
        </div>
      </div>
      ${renderTable({
        columns,
        rows,
        emptyTitle: config.emptyTitle,
        emptyBody: config.emptyBody
      })}
    </section>
  `;
};

export default {
  loadActivityPage,
  renderActivityPage
};
