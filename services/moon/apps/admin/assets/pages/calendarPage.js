import {escapeHtml, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";
import {formatDate} from "../format.js";

/**
 * Load calendar entries for Moon admin.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadCalendarPage = ({api}) => api.get("/api/moon/v3/admin/calendar");

/**
 * Render the admin calendar view.
 *
 * @param {Awaited<ReturnType<typeof loadCalendarPage>>} result
 * @returns {string}
 */
export const renderCalendarPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Calendar unavailable", result.payload?.error || "Unable to load release calendar data.");
  }

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Release calendar</span>
          <h2>Upcoming chapters</h2>
        </div>
      </div>
      ${renderTable({
        columns: ["Date", "Title", "Chapter", "Type", "Availability"],
        rows: (result.payload?.entries || []).map((entry) => [
          escapeHtml(formatDate(entry.releaseDate)),
          `<strong>${escapeHtml(entry.title)}</strong>`,
          escapeHtml(entry.chapterLabel || entry.chapterId),
          escapeHtml(entry.mediaType),
          renderStatusBadge(entry.available ? "Available" : "Pending")
        ]),
        emptyTitle: "No calendar entries",
        emptyBody: "Release dates will show here once Raven starts tracking more title schedules."
      })}
    </section>
  `;
};

export default {
  loadCalendarPage,
  renderCalendarPage
};
