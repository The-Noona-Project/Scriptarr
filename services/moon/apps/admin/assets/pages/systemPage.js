import {escapeHtml, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";
import {formatDate, joinValues} from "../format.js";

/**
 * Resolve system route config.
 *
 * @param {string} routeId
 * @returns {{path: string, title: string, emptyTitle: string, emptyBody: string}}
 */
const systemConfig = (routeId) => ({
  "system-status": {
    path: "/api/moon/v3/admin/system/status",
    title: "System status",
    emptyTitle: "Status unavailable",
    emptyBody: "Moon could not load Warden and service status details."
  },
  "system-tasks": {
    path: "/api/moon/v3/admin/system/tasks",
    title: "Tasks",
    emptyTitle: "No tasks available",
    emptyBody: "There are no pending requests or active service tasks to show."
  },
  "system-updates": {
    path: "/api/moon/v3/admin/system/updates",
    title: "Updates",
    emptyTitle: "No update data",
    emptyBody: "Image publish data is not available."
  },
  "system-events": {
    path: "/api/moon/v3/admin/system/events",
    title: "Events",
    emptyTitle: "No recent events",
    emptyBody: "Recent request and task timeline events will appear here."
  },
  "system-logs": {
    path: "/api/moon/v3/admin/system/logs",
    title: "Logs",
    emptyTitle: "No log summary",
    emptyBody: "Sanitized service log lines will appear here."
  }
}[routeId]);

/**
 * Load a system page payload.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   route: import("../routes.js").AdminRoute
 * }} context
 * @returns {Promise<import("../api.js").ApiResult & {routeId: string}>}
 */
export const loadSystemPage = async ({api, route}) => ({
  ...(await api.get(systemConfig(route.id).path)),
  routeId: route.id
});

/**
 * Render the system page family.
 *
 * @param {Awaited<ReturnType<typeof loadSystemPage>>} result
 * @returns {string}
 */
export const renderSystemPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("System page unavailable", result.payload?.error || "Unable to load system data.");
  }

  if (result.routeId === "system-status") {
    const services = result.payload?.services || {};
    const bootstrap = result.payload?.bootstrap || {};
    const runtime = result.payload?.runtime || {};

    return `
      <div class="content-grid two-up">
        <section class="panel-section">
          <div class="section-heading">
            <div>
              <span class="section-kicker">Runtime</span>
              <h2>Service health</h2>
            </div>
          </div>
          <div class="service-strip">
            ${Object.entries(services).map(([name, payload]) => `
              <article class="service-card">
                <div class="service-card-head">
                  <strong>${escapeHtml(name)}</strong>
                  ${renderStatusBadge(payload?.ok === false ? "Degraded" : "Online")}
                </div>
                <p>${escapeHtml(payload?.error || payload?.service || payload?.message || "Healthy")}</p>
              </article>
            `).join("")}
          </div>
        </section>
        <section class="panel-section">
          <div class="section-heading">
            <div>
              <span class="section-kicker">Bootstrap</span>
              <h2>Managed stack</h2>
            </div>
          </div>
          ${renderTable({
            columns: ["Service", "Image", "Container"],
            rows: (bootstrap.services || []).map((service) => [
              `<strong>${escapeHtml(service.name)}</strong>`,
              escapeHtml(service.image),
              escapeHtml(service.containerName)
            ]),
            emptyTitle: "No managed services found",
            emptyBody: "Bootstrap data has not been surfaced yet."
          })}
          <div class="callout subtle">
            <strong>Network</strong>
            <p>${escapeHtml(runtime.networkName || bootstrap.networkName || "scriptarr-network")} · ${escapeHtml(runtime.stackMode || "production")} · ${escapeHtml(runtime.mysqlMode || "selfhost")}</p>
          </div>
        </section>
      </div>
    `;
  }

  if (result.routeId === "system-tasks") {
    return `
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">System tasks</span>
            <h2>Requests and service work</h2>
          </div>
        </div>
        ${renderTable({
          columns: ["Title", "Status", "Progress", "Updated"],
          rows: (result.payload?.tasks || []).map((task) => [
            `<strong>${escapeHtml(task.titleName)}</strong>`,
            renderStatusBadge(task.status),
            escapeHtml(`${task.percent || 0}%`),
            escapeHtml(formatDate(task.updatedAt || task.queuedAt, {includeTime: true}))
          ]),
          emptyTitle: "No active tasks",
          emptyBody: "Raven has no queued or completed task history to show right now."
        })}
      </section>
    `;
  }

  if (result.routeId === "system-updates") {
    return `
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Images</span>
            <h2>Published channels</h2>
          </div>
        </div>
        ${renderTable({
          columns: ["Service", "Image", "Container", "Registry"],
          rows: (result.payload?.services || []).map((service) => [
            `<strong>${escapeHtml(service.name)}</strong>`,
            escapeHtml(service.image),
            escapeHtml(service.containerName),
            escapeHtml(service.channel)
          ]),
          emptyTitle: "No image data",
          emptyBody: "Warden has not surfaced image tags for the managed stack yet."
        })}
      </section>
    `;
  }

  if (result.routeId === "system-events") {
    return `
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Timeline</span>
            <h2>Recent events</h2>
          </div>
        </div>
        ${renderTable({
          columns: ["Service", "Type", "Actor", "Message", "When"],
          rows: (result.payload?.events || []).map((event) => [
            escapeHtml(event.service),
            renderStatusBadge(event.type),
            escapeHtml(event.actor || "system"),
            escapeHtml(event.message),
            escapeHtml(formatDate(event.at, {includeTime: true}))
          ]),
          emptyTitle: "No recent events",
          emptyBody: "Recent request and task activity will be summarized here."
        })}
      </section>
    `;
  }

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Logs</span>
          <h2>Sanitized log summary</h2>
        </div>
      </div>
      ${renderTable({
        columns: ["Line"],
        rows: (result.payload?.entries || []).map((entry) => [escapeHtml(entry)]),
        emptyTitle: "No log lines",
        emptyBody: "Service log lines will show here once Warden and the services publish them."
      })}
    </section>
  `;
};

export default {
  loadSystemPage,
  renderSystemPage
};
