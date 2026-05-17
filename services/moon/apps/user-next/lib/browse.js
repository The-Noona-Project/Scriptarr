/**
 * @file Catalogue helpers for Moon's compact user-library surfaces.
 */

export const BROWSE_LETTERS = ["#", ...Array.from({length: 26}, (_, index) => String.fromCharCode(65 + index))];
export const BROWSE_PAGE_SIZE = 72;
export const CATALOGUE_GRID_PAGE_SIZE = 72;
export const CATALOGUE_ROW_PAGE_SIZE = 100;
export const CATALOGUE_VIEW_STORAGE_KEY = "scriptarr.catalog.view";

const CATALOGUE_VIEWS = new Set(["grid", "rows"]);

const browseCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base"
});

/**
 * Sort titles alphabetically by display title.
 *
 * @param {Array<Record<string, any>> | null | undefined} titles
 * @returns {Array<Record<string, any>>}
 */
export const sortBrowseTitles = (titles) => [...(Array.isArray(titles) ? titles : [])].sort((left, right) => {
  const titleCompare = browseCollator.compare(String(left?.title || ""), String(right?.title || ""));
  if (titleCompare !== 0) {
    return titleCompare;
  }
  return browseCollator.compare(String(left?.id || ""), String(right?.id || ""));
});

/**
 * Normalize a media type slug for shareable browse URLs.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export const normalizeBrowseType = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+/, "")
  .replace(/-+$/, "") || "all";

/**
 * Normalize an A-Z browse bucket.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export const normalizeBrowseLetter = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  return BROWSE_LETTERS.includes(normalized) ? normalized : "";
};

/**
 * Normalize a catalogue view id.
 *
 * @param {string | null | undefined} value
 * @param {"grid" | "rows"} [fallback]
 * @returns {"grid" | "rows"}
 */
export const normalizeCatalogueView = (value, fallback = "grid") => {
  const normalizedFallback = CATALOGUE_VIEWS.has(fallback) ? fallback : "grid";
  const normalized = String(value || "").trim().toLowerCase();
  return CATALOGUE_VIEWS.has(normalized) ? /** @type {"grid" | "rows"} */ (normalized) : normalizedFallback;
};

/**
 * Normalize catalogue page size while preserving compact payload bounds.
 *
 * @param {unknown} value
 * @param {"grid" | "rows"} [view]
 * @returns {number}
 */
export const normalizeCataloguePageSize = (value, view = "grid") => {
  const fallback = normalizeCatalogueView(view) === "rows" ? CATALOGUE_ROW_PAGE_SIZE : CATALOGUE_GRID_PAGE_SIZE;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(100, Math.max(1, parsed)) : fallback;
};

/**
 * Resolve the first render view from URL, saved preference, and route intent.
 *
 * @param {{explicitView?: string, savedView?: string, routeFallback?: "grid" | "rows"}} options
 * @returns {"grid" | "rows"}
 */
export const resolveCatalogueInitialView = ({explicitView = "", savedView = "", routeFallback = "grid"} = {}) => {
  if (CATALOGUE_VIEWS.has(String(explicitView || "").trim().toLowerCase())) {
    return normalizeCatalogueView(explicitView, routeFallback);
  }
  if (CATALOGUE_VIEWS.has(String(savedView || "").trim().toLowerCase())) {
    return normalizeCatalogueView(savedView, routeFallback);
  }
  return normalizeCatalogueView(routeFallback, "grid");
};

/**
 * Resolve a title's alphabetical bucket.
 *
 * @param {Record<string, any> | null | undefined} title
 * @returns {string}
 */
export const resolveBrowseLetter = (title) => {
  const first = String(title?.title || "")
    .trim()
    .toUpperCase()
    .charAt(0);
  return /^[A-Z]$/.test(first) ? first : "#";
};

/**
 * Build the visible A-Z sections for browse.
 *
 * @param {Array<Record<string, any>> | null | undefined} titles
 * @returns {Array<{letter: string, titles: Array<Record<string, any>>}>}
 */
export const buildBrowseSections = (titles) => {
  const groups = new Map(BROWSE_LETTERS.map((letter) => [letter, []]));

  for (const title of sortBrowseTitles(titles)) {
    const letter = resolveBrowseLetter(title);
    groups.get(letter)?.push(title);
  }

  const sections = [];
  for (const letter of BROWSE_LETTERS) {
    const bucket = groups.get(letter);
    if (bucket?.length) {
      sections.push({letter, titles: bucket});
    }
  }

  return sections;
};

/**
 * Resolve the A-Z rail state for the current filtered library set.
 *
 * @param {Array<Record<string, any>> | Record<string, number> | null | undefined} value
 * @returns {Array<{letter: string, count: number, disabled: boolean}>}
 */
export const buildBrowseLetterState = (value) => {
  const counts = new Map(BROWSE_LETTERS.map((letter) => [letter, 0]));

  if (Array.isArray(value)) {
    for (const title of value) {
      const letter = resolveBrowseLetter(title);
      counts.set(letter, (counts.get(letter) || 0) + 1);
    }
  } else if (value && typeof value === "object") {
    for (const letter of BROWSE_LETTERS) {
      counts.set(letter, Number.parseInt(String(value[letter] || 0), 10) || 0);
    }
  }

  return BROWSE_LETTERS.map((letter) => {
    const count = counts.get(letter) || 0;
    return {
      letter,
      count,
      disabled: count === 0
    };
  });
};

/**
 * Normalize initial browse filters from a Next searchParams object.
 *
 * @param {URLSearchParams | Record<string, string | string[] | undefined> | null | undefined} searchParams
 * @returns {{query: string, type: string, letter: string}}
 */
export const normalizeBrowseSearchParams = (searchParams = {}) => {
  const read = (key) => {
    if (searchParams instanceof URLSearchParams) {
      return searchParams.get(key) || "";
    }
    const value = searchParams?.[key];
    return Array.isArray(value) ? value[0] || "" : value || "";
  };

  return {
    query: String(read("q") || read("query") || "").trim(),
    type: normalizeBrowseType(read("type")),
    letter: normalizeBrowseLetter(read("letter"))
  };
};

/**
 * Normalize catalogue URL state from Next search params and route aliases.
 *
 * @param {URLSearchParams | Record<string, string | string[] | undefined> | null | undefined} searchParams
 * @param {{fallbackType?: string, fallbackView?: "grid" | "rows"}} [options]
 * @returns {{query: string, type: string, letter: string, view: "grid" | "rows", explicitView: string, pageSize: number}}
 */
export const normalizeCatalogueSearchParams = (searchParams = {}, {fallbackType = "", fallbackView = "grid"} = {}) => {
  const read = (key) => {
    if (searchParams instanceof URLSearchParams) {
      return searchParams.get(key) || "";
    }
    const value = searchParams?.[key];
    return Array.isArray(value) ? value[0] || "" : value || "";
  };
  const explicitView = String(read("view") || "").trim().toLowerCase();
  const routeType = normalizeBrowseType(fallbackType);
  const requestedType = normalizeBrowseType(read("type") || (routeType === "all" ? "" : routeType));

  const view = resolveCatalogueInitialView({explicitView, routeFallback: fallbackView});

  return {
    query: String(read("q") || read("query") || "").trim(),
    type: requestedType,
    letter: normalizeBrowseLetter(read("letter")),
    view,
    explicitView,
    pageSize: normalizeCataloguePageSize(read("pageSize"), view)
  };
};

/**
 * Build a shareable Moon browse URL.
 *
 * @param {{query?: string, type?: string, letter?: string}} filters
 * @returns {string}
 */
export const buildBrowsePageUrl = ({query = "", type = "all", letter = ""} = {}) => {
  const params = new URLSearchParams();
  const normalizedQuery = String(query || "").trim();
  const normalizedType = normalizeBrowseType(type);
  const normalizedLetter = normalizeBrowseLetter(letter);
  if (normalizedQuery) {
    params.set("q", normalizedQuery);
  }
  if (normalizedType && normalizedType !== "all") {
    params.set("type", normalizedType);
  }
  if (normalizedLetter) {
    params.set("letter", normalizedLetter);
  }
  const suffix = params.toString();
  return suffix ? `/browse?${suffix}` : "/browse";
};

/**
 * Build the canonical catalogue page URL.
 *
 * @param {{query?: string, type?: string, letter?: string, view?: "grid" | "rows", pageSize?: number}} filters
 * @returns {string}
 */
export const buildCataloguePageUrl = ({query = "", type = "all", letter = "", view = "grid", pageSize} = {}) => {
  const params = new URLSearchParams();
  const normalizedQuery = String(query || "").trim();
  const normalizedType = normalizeBrowseType(type);
  const normalizedLetter = normalizeBrowseLetter(letter);
  const normalizedView = normalizeCatalogueView(view);
  const normalizedPageSize = normalizeCataloguePageSize(pageSize, normalizedView);
  if (normalizedQuery) {
    params.set("q", normalizedQuery);
  }
  if (normalizedType && normalizedType !== "all") {
    params.set("type", normalizedType);
  }
  if (normalizedLetter) {
    params.set("letter", normalizedLetter);
  }
  params.set("view", normalizedView);
  params.set("pageSize", String(normalizedPageSize));
  return `/library?${params.toString()}`;
};

/**
 * Build the same-origin Moon card API URL for browse results.
 *
 * @param {{query?: string, type?: string, letter?: string, cursor?: string, pageSize?: number}} filters
 * @returns {string}
 */
export const buildBrowseApiUrl = ({query = "", type = "all", letter = "", cursor = "", pageSize = BROWSE_PAGE_SIZE} = {}) => {
  const params = new URLSearchParams({
    view: "card",
    pageSize: String(pageSize)
  });
  const normalizedQuery = String(query || "").trim();
  const normalizedType = normalizeBrowseType(type);
  const normalizedLetter = normalizeBrowseLetter(letter);
  if (normalizedQuery) {
    params.set("q", normalizedQuery);
  }
  if (normalizedType && normalizedType !== "all") {
    params.set("type", normalizedType);
  }
  if (normalizedLetter) {
    params.set("letter", normalizedLetter);
  }
  if (cursor) {
    params.set("cursor", String(cursor));
  }
  return `/api/moon-v3/user/library?${params.toString()}`;
};

/**
 * Build the same-origin compact title-card API URL for the catalogue.
 *
 * @param {{query?: string, type?: string, letter?: string, cursor?: string, pageSize?: number, view?: "grid" | "rows"}} filters
 * @returns {string}
 */
export const buildCatalogueApiUrl = ({query = "", type = "all", letter = "", cursor = "", pageSize, view = "grid"} = {}) =>
  buildBrowseApiUrl({
    query,
    type,
    letter,
    cursor,
    pageSize: pageSize || (normalizeCatalogueView(view) === "rows" ? CATALOGUE_ROW_PAGE_SIZE : CATALOGUE_GRID_PAGE_SIZE)
  });

export default {
  BROWSE_LETTERS,
  BROWSE_PAGE_SIZE,
  CATALOGUE_GRID_PAGE_SIZE,
  CATALOGUE_ROW_PAGE_SIZE,
  CATALOGUE_VIEW_STORAGE_KEY,
  buildCatalogueApiUrl,
  buildCataloguePageUrl,
  buildBrowseApiUrl,
  buildBrowseLetterState,
  buildBrowsePageUrl,
  buildBrowseSections,
  normalizeCatalogueSearchParams,
  normalizeCataloguePageSize,
  normalizeCatalogueView,
  normalizeBrowseLetter,
  normalizeBrowseSearchParams,
  normalizeBrowseType,
  resolveCatalogueInitialView,
  resolveBrowseLetter,
  sortBrowseTitles
};
