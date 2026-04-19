import {escapeHtml, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";

/**
 * Load add-title search results for the current query string.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   searchParams: URLSearchParams
 * }} context
 * @returns {Promise<import("../api.js").ApiResult & {query: string}>}
 */
export const loadAddPage = async ({api, searchParams}) => {
  const query = searchParams.get("q") || "";
  if (!query) {
    return {
      ok: true,
      status: 200,
      payload: {query: "", results: []},
      query
    };
  }

  const result = await api.get(`/api/moon/v3/admin/add/search?query=${encodeURIComponent(query)}`);
  return {...result, query};
};

/**
 * Render the add-title page.
 *
 * @param {Awaited<ReturnType<typeof loadAddPage>>} result
 * @returns {string}
 */
export const renderAddPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Search unavailable", result.payload?.error || "Raven search is not available right now.");
  }

  const results = result.payload?.results || [];

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Raven intake</span>
          <h2>Search and queue titles</h2>
        </div>
      </div>
      <form id="admin-add-search-form" class="toolbar-form">
        <input type="search" id="admin-add-query" name="query" value="${escapeHtml(result.query || "")}" placeholder="Search MangaDex or other configured sources">
        <button class="solid-button" type="submit">Search</button>
      </form>
      ${results.length ? renderTable({
        columns: ["Title", "Type", "Source", "Status", "Queue"],
        rows: results.map((entry) => [
          `<strong>${escapeHtml(entry.titleName || entry.title || "Untitled result")}</strong>`,
          escapeHtml(entry.requestType || "manga"),
          escapeHtml(entry.source || entry.provider || "Raven"),
          renderStatusBadge(entry.status || "Available"),
          `<button class="ghost-button small" type="button" data-action="queue-title" data-title-name="${escapeHtml(entry.titleName || entry.title || "")}" data-title-url="${escapeHtml(entry.titleUrl || entry.url || "")}" data-request-type="${escapeHtml(entry.requestType || "manga")}">Queue</button>`
        ])
      }) : renderEmptyState("Search for a title", "Use the search box to load Raven intake results and queue them into Scriptarr.")}
      <div class="inline-note" id="admin-add-feedback"></div>
    </section>
  `;
};

/**
 * Wire the add-title search and queue actions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   navigate: (path: string) => void,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @returns {Promise<void>}
 */
export const enhanceAddPage = async (root, {api, navigate, rerender, setFlash}) => {
  const form = root.querySelector("#admin-add-search-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = root.querySelector("#admin-add-query")?.value.trim() || "";
    navigate(query ? `/admin/add?q=${encodeURIComponent(query)}` : "/admin/add");
  });

  root.querySelectorAll("[data-action='queue-title']").forEach((button) => {
    button.addEventListener("click", async () => {
      const result = await api.post("/api/moon/v3/admin/add/queue", {
        titleName: button.dataset.titleName,
        titleUrl: button.dataset.titleUrl,
        requestType: button.dataset.requestType || "manga"
      });

      if (!result.ok) {
        setFlash("bad", result.payload?.error || "Unable to queue the selected title.");
        await rerender();
        return;
      }

      setFlash("good", `${button.dataset.titleName} was sent to Raven's queue.`);
      await rerender();
    });
  });
};

export default {
  loadAddPage,
  renderAddPage,
  enhanceAddPage
};
