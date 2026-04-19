import {escapeHtml, renderEmptyState} from "../dom.js";

/**
 * Load import-library status data.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadImportPage = ({api}) => api.get("/api/moon/v3/admin/import");

/**
 * Render the import-library admin page.
 *
 * @param {Awaited<ReturnType<typeof loadImportPage>>} result
 * @returns {string}
 */
export const renderImportPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Import unavailable", result.payload?.error || "Import status is not available.");
  }

  const summary = result.payload?.summary || {};

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Import</span>
          <h2>Existing library paths</h2>
        </div>
      </div>
      <div class="callout">
        <strong>${escapeHtml(String(summary.detected || 0))} paths detected</strong>
        <p>${escapeHtml(summary.note || "Import scanning is not wired into the scaffold yet.")}</p>
      </div>
    </section>
  `;
};

export default {
  loadImportPage,
  renderImportPage
};
