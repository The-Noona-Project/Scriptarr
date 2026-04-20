import {escapeHtml, renderEmptyState, renderSeriesCard} from "../dom.js";
import {buildLibraryPath, buildTitlePathForTitle, resolveTitleTypeSlug} from "../routes.js";

const normalizeTypeSlug = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+/, "")
  .replace(/-+$/, "");

const buildTypeOptions = (titles) => {
  const bySlug = new Map();
  for (const title of titles) {
    const slug = resolveTitleTypeSlug(title);
    if (!bySlug.has(slug)) {
      bySlug.set(slug, {
        slug,
        label: title.libraryTypeLabel || title.mediaType || slug,
        count: 0
      });
    }
    bySlug.get(slug).count += 1;
  }
  return [...bySlug.values()].sort((left, right) => left.label.localeCompare(right.label));
};

/**
 * Load the shared browse/library payload.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   route: ReturnType<import("../routes.js").matchUserRoute>,
 *   searchParams: URLSearchParams
 * }} context
 * @returns {Promise<import("../api.js").ApiResult & {
 *   query: string,
 *   mediaType: string,
 *   availableTypes?: Array<{slug: string, label: string, count: number}>,
 *   selectedTypeSlug?: string,
 *   requiresCanonicalLibrary?: boolean,
 *   libraryEmpty?: boolean
 * }>}
 */
export const loadBrowsePage = async ({api, route, searchParams}) => {
  const query = searchParams.get("q")?.trim().toLowerCase() || "";
  const routeTypeSlug = normalizeTypeSlug(route.params?.typeSlug || "");
  const mediaType = route.id === "library"
    ? routeTypeSlug
    : normalizeTypeSlug(searchParams.get("type")?.trim().toLowerCase() || "");
  const result = await api.get("/api/moon/v3/user/library");

  if (!result.ok) {
    return {...result, query, mediaType};
  }

  const allTitles = result.payload?.titles || [];
  const availableTypes = buildTypeOptions(allTitles);
  const selectedTypeSlug = route.id === "library"
    ? (routeTypeSlug || availableTypes[0]?.slug || "manga")
    : mediaType;
  const requiresCanonicalLibrary = route.id === "library" && Boolean(selectedTypeSlug) && selectedTypeSlug !== routeTypeSlug;
  const titles = allTitles.filter((title) => {
    const matchesType = selectedTypeSlug ? resolveTitleTypeSlug(title) === selectedTypeSlug : true;
    const haystack = [
      title.title,
      title.author,
      title.libraryTypeLabel,
      ...(title.tags || []),
      ...(title.aliases || [])
    ].join(" ").toLowerCase();
    return matchesType && (!query || haystack.includes(query));
  });

  return {
    ok: true,
    status: 200,
    payload: {titles},
    query,
    mediaType,
    selectedTypeSlug,
    availableTypes,
    requiresCanonicalLibrary,
    libraryEmpty: allTitles.length === 0
  };
};

/**
 * Render the browse or typed library page.
 *
 * @param {Awaited<ReturnType<typeof loadBrowsePage>>} result
 * @param {{route?: ReturnType<import("../routes.js").matchUserRoute>, branding?: {siteName?: string} | null}} [chrome]
 * @returns {string}
 */
export const renderBrowsePage = (result, chrome = {}) => {
  if (!result.ok) {
    return renderEmptyState("Browse unavailable", result.payload?.error || "Moon needs a session before it can load the library.");
  }

  const titles = result.payload?.titles || [];
  const siteName = chrome.branding?.siteName || "Scriptarr";
  const currentRoute = chrome.route;
  const isLibraryRoute = currentRoute?.id === "library";
  const emptyTitle = result.libraryEmpty ? "Library is empty" : "No titles match";
  const emptyBody = result.libraryEmpty
    ? `No titles have been imported into ${siteName} yet. This view will stay empty until Raven has real titles to surface.`
    : "Try a broader search or switch to a different title type.";

  return `
    <section class="panel-section">
      <div class="section-head">
        <div>
          <span class="section-kicker">${isLibraryRoute ? "Type-scoped library" : "Library filters"}</span>
          <h2>${isLibraryRoute ? "Read by title type" : "Browse the library"}</h2>
        </div>
      </div>
      ${(result.availableTypes || []).length
        ? `
          <div class="type-tab-row">
            ${(result.availableTypes || []).map((type) => `
              <a class="nav-pill ${type.slug === result.selectedTypeSlug ? "is-active" : ""}" href="${escapeHtml(buildLibraryPath(type.slug))}" data-link>
                <span>${escapeHtml(type.label)}</span>
                <small>${escapeHtml(type.count)}</small>
              </a>
            `).join("")}
          </div>
        `
        : ""}
      <form id="browse-filter-form" class="filter-bar">
        <input type="search" id="browse-query" value="${escapeHtml(result.query || "")}" placeholder="Search titles, creators, or tags">
        <select id="browse-type">
          <option value="">${isLibraryRoute ? "Switch to browse" : "All types"}</option>
          ${(result.availableTypes || []).map((type) => `
            <option value="${escapeHtml(type.slug)}" ${type.slug === result.selectedTypeSlug ? "selected" : ""}>${escapeHtml(type.label)}</option>
          `).join("")}
        </select>
        <button class="solid-button" type="submit">${isLibraryRoute ? "Open type" : "Apply"}</button>
      </form>
    </section>
    <section class="library-shelf">
      <div class="card-grid">
        ${titles.length
          ? titles.map((title) => renderSeriesCard({
            ...title,
            href: buildTitlePathForTitle(title)
          })).join("")
          : renderEmptyState(emptyTitle, emptyBody)}
      </div>
    </section>
  `;
};

/**
 * Wire the browse or library filter form.
 *
 * @param {HTMLElement} root
 * @param {{navigate: (path: string, options?: {replace?: boolean}) => void, route: ReturnType<import("../routes.js").matchUserRoute>}} context
 * @param {Awaited<ReturnType<typeof loadBrowsePage>>} result
 * @returns {Promise<void>}
 */
export const enhanceBrowsePage = async (root, {navigate, route}, result) => {
  if (route.id === "library" && result.requiresCanonicalLibrary && result.selectedTypeSlug) {
    navigate(buildLibraryPath(result.selectedTypeSlug), {replace: true});
    return;
  }

  root.querySelector("#browse-filter-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = root.querySelector("#browse-query")?.value.trim() || "";
    const mediaType = root.querySelector("#browse-type")?.value || "";
    const params = new URLSearchParams();
    if (query) {
      params.set("q", query);
    }

    if (route.id === "library") {
      if (mediaType) {
        navigate(`${buildLibraryPath(mediaType)}${params.toString() ? `?${params.toString()}` : ""}`);
        return;
      }
      navigate(`/browse${params.toString() ? `?${params.toString()}` : ""}`);
      return;
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
