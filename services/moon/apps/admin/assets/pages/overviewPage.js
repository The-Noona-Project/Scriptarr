import {escapeHtml, renderChipList, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";
import {formatDate, formatPercent} from "../format.js";

/**
 * Load the Moon admin overview payload.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadOverviewPage = ({api}) => api.get("/api/moon/v3/admin/overview");

/**
 * Render the admin overview surface.
 *
 * @param {Awaited<ReturnType<typeof loadOverviewPage>>} result
 * @returns {string}
 */
export const renderOverviewPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Overview unavailable", result.payload?.error || "Admin access is required to load overview data.");
  }

  const {counts = {}, services = {}, queue = [], requests = [], titles = []} = result.payload || {};
  const metrics = [
    {label: "Titles", value: counts.titles || 0},
    {label: "Active Tasks", value: counts.activeTasks || 0},
    {label: "Pending Requests", value: counts.pendingRequests || 0},
    {label: "Missing Chapters", value: counts.missingChapters || 0},
    {label: "Metadata Gaps", value: counts.metadataGaps || 0}
  ];

  return `
    <section class="metric-grid">
      ${metrics.map((metric) => `
        <article class="metric-card">
          <span>${escapeHtml(metric.label)}</span>
          <strong>${escapeHtml(metric.value)}</strong>
        </article>
      `).join("")}
    </section>
    <section class="content-grid two-up">
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Health</span>
            <h2>Service status</h2>
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
            <span class="section-kicker">Queue</span>
            <h2>Active work</h2>
          </div>
        </div>
        ${renderTable({
          columns: ["Title", "Status", "Progress", "Updated"],
          rows: queue.map((entry) => [
            `<strong>${escapeHtml(entry.titleName)}</strong>`,
            renderStatusBadge(entry.status),
            escapeHtml(formatPercent(entry.percent)),
            escapeHtml(formatDate(entry.updatedAt || entry.queuedAt, {includeTime: true}))
          ]),
          emptyTitle: "Queue is clear",
          emptyBody: "Raven is not actively processing a download right now."
        })}
      </section>
    </section>
    <section class="content-grid two-up">
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Moderation</span>
            <h2>Pending requests</h2>
          </div>
        </div>
        ${renderTable({
          columns: ["Title", "Requester", "Status", "Updated"],
          rows: requests.map((entry) => [
            `<strong>${escapeHtml(entry.title)}</strong>`,
            escapeHtml(entry.requestedBy?.username || entry.requestedBy?.discordUserId || "Unknown"),
            renderStatusBadge(entry.status),
            escapeHtml(formatDate(entry.updatedAt, {includeTime: true}))
          ]),
          emptyTitle: "No pending requests",
          emptyBody: "Moon and Discord queues are caught up."
        })}
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Library</span>
            <h2>Focus titles</h2>
          </div>
        </div>
        <div class="stack-list">
          ${titles.map((title) => `
            <article class="list-card">
              <div class="list-card-head">
                <div>
                  <strong>${escapeHtml(title.title)}</strong>
                  <span>${escapeHtml(title.author || "Unknown creator")}</span>
                </div>
                ${renderStatusBadge(title.status)}
              </div>
              <p>${escapeHtml(title.summary || "No summary yet.")}</p>
              ${renderChipList(title.tags)}
            </article>
          `).join("")}
        </div>
      </section>
    </section>
  `;
};

export default {
  loadOverviewPage,
  renderOverviewPage
};
