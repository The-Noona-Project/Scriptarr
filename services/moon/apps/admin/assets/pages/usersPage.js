import {escapeHtml, renderChipList, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";

/**
 * Load the admin user directory.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadUsersPage = ({api}) => api.get("/api/moon/v3/admin/users");

/**
 * Render the admin users page.
 *
 * @param {Awaited<ReturnType<typeof loadUsersPage>>} result
 * @returns {string}
 */
export const renderUsersPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Users unavailable", result.payload?.error || "Unable to load Scriptarr user records.");
  }

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Access</span>
          <h2>Users and roles</h2>
        </div>
      </div>
      ${renderTable({
        columns: ["Username", "Discord ID", "Role", "Permissions"],
        rows: (result.payload?.users || []).map((user) => [
          `<strong>${escapeHtml(user.username || "Unknown user")}</strong>`,
          escapeHtml(user.discordUserId || "Unknown"),
          renderStatusBadge(user.role || "member"),
          renderChipList(user.permissions || [])
        ]),
        emptyTitle: "No users yet",
        emptyBody: "Users appear after Discord claim or login flows create sessions."
      })}
    </section>
  `;
};

export default {
  loadUsersPage,
  renderUsersPage
};
