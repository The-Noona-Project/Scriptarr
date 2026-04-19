import {escapeHtml, renderEmptyState, renderSeriesCard} from "../dom.js";

/**
 * Load the shared browse/library payload.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   searchParams: URLSearchParams
 * }} context
 * @returns {Promise<import("../api.js").ApiResult & {query: string, mediaType: string}>}
 */
export const loadBrowsePage = async ({api, searchParams}) => {
  const query = searchParams.get("q")?.trim().toLowerCase() || "";
  const mediaType = searchParams.get("type")?.trim().toLowerCase() || "";
  const result = await api.get("/api/moon/v3/user/library");

  if (!result.ok) {
    return {...result, query, mediaType};
  }

  const allTitles = result.payload?.titles || [];
  const titles = allTitles.filter((title) => {
    const matchesType = mediaType ? String(title.mediaType || "").toLowerCase() === mediaType : true;
    const haystack = [title.title, title.author, ...(title.tags || []), ...(title.aliases || [])].join(" ").toLowerCase();
    return matchesType && (!query || haystack.includes(query));
  });

  return {
    ok: true,
    status: 200,
    payload: {titles},
    query,
    mediaType,
    libraryEmpty: allTitles.length === 0
  };
};

/**
 * Render the browse page.
 *
 * @param {Awaited<ReturnType<typeof loadBrowsePage>>} result
 * @returns {string}
 */
export const renderBrowsePage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Browse unavailable", result.payload?.error || "Moon needs a session before it can load the library.");
  }

  const titles = result.payload?.titles || [];
  const emptyTitle = result.libraryEmpty ? "Library is empty" : "No titles match";
  const emptyBody = result.libraryEmpty
    ? "No titles have been imported into Scriptarr yet. This view will stay empty until Raven has real titles to surface."
    : "Try a broader search or clear the current media-type filter.";

  return `
    <section class="panel-section">
      <div class="section-head">
        <div>
          <span class="section-kicker">Library filters</span>
          <h2>Browse Scriptarr</h2>
        </div>
      </div>
      <form id="browse-filter-form" class="filter-bar">
        <input type="search" id="browse-query" value="${escapeHtml(result.query || "")}" placeholder="Search titles, creators, or tags">
        <select id="browse-type">
          <option value="">All types</option>
          <option value="manga" ${result.mediaType === "manga" ? "selected" : ""}>Manga</option>
          <option value="webtoon" ${result.mediaType === "webtoon" ? "selected" : ""}>Webtoon</option>
          <option value="comic" ${result.mediaType === "comic" ? "selected" : ""}>Comic</option>
        </select>
        <button class="solid-button" type="submit">Apply</button>
      </form>
    </section>
    <section class="library-shelf">
      <div class="card-grid">
        ${titles.length
          ? titles.map((title) => renderSeriesCard({
            ...title,
            href: `/title/${title.id}`
          })).join("")
          : renderEmptyState(emptyTitle, emptyBody)}
      </div>
    </section>
  `;
};

/**
 * Wire the browse filter form.
 *
 * @param {HTMLElement} root
 * @param {{navigate: (path: string) => void}} context
 * @returns {Promise<void>}
 */
export const enhanceBrowsePage = async (root, {navigate}) => {
  root.querySelector("#browse-filter-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = root.querySelector("#browse-query")?.value.trim() || "";
    const mediaType = root.querySelector("#browse-type")?.value || "";
    const params = new URLSearchParams();
    if (query) {
      params.set("q", query);
    }
    if (mediaType) {
      params.set("type", mediaType);
    }
    navigate(`/browse${params.toString() ? `?${params.toString()}` : ""}`);
  });
};

export default {
  loadBrowsePage,
  renderBrowsePage,
  enhanceBrowsePage
};
