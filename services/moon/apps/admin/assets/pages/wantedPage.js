import {escapeHtml, renderChipList, renderEmptyState, renderTable} from "../dom.js";

/**
 * Resolve wanted-route API configuration.
 *
 * @param {string} routeId
 * @returns {{path: string, title: string, emptyTitle: string, emptyBody: string}}
 */
const wantedConfig = (routeId) => ({
  "wanted-missing": {
    path: "/api/moon/v3/admin/wanted/missing-chapters",
    title: "Missing chapters",
    emptyTitle: "No missing chapter gaps",
    emptyBody: "Tracked titles are caught up on chapter downloads."
  },
  "wanted-metadata": {
    path: "/api/moon/v3/admin/wanted/metadata-gaps",
    title: "Metadata gaps",
    emptyTitle: "Metadata is in good shape",
    emptyBody: "Raven has provider coverage and summary data for the tracked library."
  }
}[routeId]);

/**
 * Load a wanted-route payload.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   route: import("../routes.js").AdminRoute
 * }} context
 * @returns {Promise<import("../api.js").ApiResult & {routeId: string}>}
 */
export const loadWantedPage = async ({api, route}) => ({
  ...(await api.get(wantedConfig(route.id).path)),
  routeId: route.id
});

/**
 * Render the wanted page family.
 *
 * @param {Awaited<ReturnType<typeof loadWantedPage>>} result
 * @returns {string}
 */
export const renderWantedPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Wanted view unavailable", result.payload?.error || "Unable to load wanted data.");
  }

  const config = wantedConfig(result.routeId);
  const entries = result.payload?.entries || [];

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Wanted</span>
          <h2>${escapeHtml(config.title)}</h2>
        </div>
      </div>
      ${renderTable({
        columns: result.routeId === "wanted-missing"
          ? ["Title", "Latest", "Coverage", "Missing"]
          : ["Title", "Provider", "Gaps", "Tags"],
        rows: entries.map((entry) => result.routeId === "wanted-missing"
          ? [
            `<strong>${escapeHtml(entry.title)}</strong>`,
            escapeHtml(entry.latestChapter),
            escapeHtml(`${entry.chaptersDownloaded}/${entry.chapterCount}`),
            `<strong>${escapeHtml(entry.missingCount)}</strong>`
          ]
          : [
            `<strong>${escapeHtml(entry.title)}</strong>`,
            escapeHtml(entry.metadataProvider || "Unmatched"),
            renderChipList(entry.gaps),
            renderChipList(entry.tags)
          ]),
        emptyTitle: config.emptyTitle,
        emptyBody: config.emptyBody
      })}
    </section>
  `;
};

export default {
  loadWantedPage,
  renderWantedPage
};
