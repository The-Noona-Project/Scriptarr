import {escapeHtml, renderChipList, renderCoverThumb, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";
import {formatDate} from "../format.js";

/**
 * Load the admin library grid.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadLibraryPage = ({api}) => api.get("/api/moon/v3/admin/library");

/**
 * Render the library grid page.
 *
 * @param {Awaited<ReturnType<typeof loadLibraryPage>>} result
 * @returns {string}
 */
export const renderLibraryPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Library unavailable", result.payload?.error || "Unable to load Scriptarr library data.");
  }

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Tracked titles</span>
          <h2>Library index</h2>
        </div>
      </div>
      ${renderTable({
        columns: ["Title", "Type", "Status", "Latest", "Provider", "Coverage", "Matched"],
        rows: (result.payload?.titles || []).map((title) => [
          `<div class="table-title-cell with-cover-row">${renderCoverThumb(title.coverUrl, title.title)}<div><strong>${escapeHtml(title.title)}</strong>${renderChipList(title.tags)}</div></div>`,
          escapeHtml(title.mediaType),
          renderStatusBadge(title.status),
          escapeHtml(title.latestChapter),
          escapeHtml(title.metadataProvider || "Unmatched"),
          escapeHtml(`${title.chaptersDownloaded}/${title.chapterCount}`),
          escapeHtml(formatDate(title.metadataMatchedAt))
        ]),
        emptyTitle: "Library is empty",
        emptyBody: "No real titles have been imported yet. This index will stay empty until Raven has real library ingest."
      })}
    </section>
  `;
};

export default {
  loadLibraryPage,
  renderLibraryPage
};
