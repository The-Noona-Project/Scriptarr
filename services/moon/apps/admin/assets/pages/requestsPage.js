import {escapeHtml, renderChipList, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";
import {formatDate} from "../format.js";

/**
 * Load the moderation request queue.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadRequestsPage = ({api}) => api.get("/api/moon/v3/admin/requests");

/**
 * Render the request moderation page.
 *
 * @param {Awaited<ReturnType<typeof loadRequestsPage>>} result
 * @returns {string}
 */
export const renderRequestsPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Requests unavailable", result.payload?.error || "Unable to load moderated requests.");
  }

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Moderation</span>
          <h2>Unified request queue</h2>
        </div>
      </div>
      ${renderTable({
        columns: ["Title", "Requester", "Source", "Status", "Notes", "Updated", "Actions"],
        rows: (result.payload?.requests || []).map((entry) => [
          `<div class="table-title-cell"><strong>${escapeHtml(entry.title)}</strong>${renderChipList([entry.requestType])}</div>`,
          escapeHtml(entry.requestedBy?.username || entry.requestedBy?.discordUserId || "Unknown"),
          escapeHtml(entry.source),
          renderStatusBadge(entry.status),
          escapeHtml(entry.notes || "No notes"),
          escapeHtml(formatDate(entry.updatedAt, {includeTime: true})),
          entry.status === "pending"
            ? `<div class="action-row">
                <button class="solid-button small" type="button" data-review-action="approved" data-request-id="${escapeHtml(entry.id)}">Approve</button>
                <button class="ghost-button small" type="button" data-review-action="denied" data-request-id="${escapeHtml(entry.id)}">Deny</button>
              </div>`
            : renderStatusBadge(entry.status)
        ]),
        emptyTitle: "No requests yet",
        emptyBody: "Moon and Discord requests will appear here once users start filing them."
      })}
    </section>
  `;
};

/**
 * Wire request moderation actions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @returns {Promise<void>}
 */
export const enhanceRequestsPage = async (root, {api, rerender, setFlash}) => {
  root.querySelectorAll("[data-review-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextStatus = button.dataset.reviewAction;
      const comment = window.prompt(
        nextStatus === "approved" ? "Approval note for this request:" : "Reason for denying this request:",
        nextStatus === "approved" ? "Approved from Moon admin." : "Denied from Moon admin."
      );

      if (comment == null) {
        return;
      }

      const result = await api.post(`/api/moon/admin/requests/${encodeURIComponent(button.dataset.requestId || "")}/review`, {
        status: nextStatus,
        comment
      });

      setFlash(result.ok ? "good" : "bad", result.ok
        ? `Request was marked ${nextStatus}.`
        : result.payload?.error || "Unable to update the selected request.");
      await rerender();
    });
  });
};

export default {
  loadRequestsPage,
  renderRequestsPage,
  enhanceRequestsPage
};
