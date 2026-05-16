/**
 * @file Browse helpers for Moon's compact user-library catalogue.
 */

export const BROWSE_LETTERS = ["#", ...Array.from({length: 26}, (_, index) => String.fromCharCode(65 + index))];
export const BROWSE_PAGE_SIZE = 72;

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

export default {
  BROWSE_LETTERS,
  BROWSE_PAGE_SIZE,
  buildBrowseApiUrl,
  buildBrowseLetterState,
  buildBrowsePageUrl,
  buildBrowseSections,
  normalizeBrowseLetter,
  normalizeBrowseSearchParams,
  normalizeBrowseType,
  resolveBrowseLetter,
  sortBrowseTitles
};
