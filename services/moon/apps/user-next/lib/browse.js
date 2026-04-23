/**
 * @file Browse helpers for Moon's alphabetical user-library surface.
 */

export const BROWSE_LETTERS = Array.from({length: 26}, (_, index) => String.fromCharCode(65 + index));

const browseCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base"
});

const toSearchString = (title) => [
  title?.title,
  title?.libraryTypeLabel,
  title?.libraryTypeSlug,
  title?.mediaType,
  ...(Array.isArray(title?.aliases) ? title.aliases : []),
  ...(Array.isArray(title?.tags) ? title.tags : [])
]
  .filter(Boolean)
  .join(" ")
  .toLowerCase();

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
 * Filter and sort the browse payload by the current search key.
 *
 * @param {Array<Record<string, any>> | null | undefined} titles
 * @param {string | null | undefined} search
 * @returns {Array<Record<string, any>>}
 */
export const filterBrowseTitles = (titles, search = "") => {
  const sorted = sortBrowseTitles(titles);
  const key = String(search || "").trim().toLowerCase();
  if (!key) {
    return sorted;
  }
  return sorted.filter((title) => toSearchString(title).includes(key));
};

/**
 * Resolve a title's alphabetical bucket.
 *
 * @param {Record<string, any> | null | undefined} title
 * @returns {string}
 */
export const resolveBrowseLetter = (title) => {
  const match = String(title?.title || "")
    .trim()
    .toUpperCase()
    .match(/[A-Z]/);
  return match ? match[0] : "#";
};

/**
 * Build the visible A-Z sections for browse.
 *
 * @param {Array<Record<string, any>> | null | undefined} titles
 * @returns {Array<{letter: string, titles: Array<Record<string, any>>}>}
 */
export const buildBrowseSections = (titles) => {
  const groups = new Map(BROWSE_LETTERS.map((letter) => [letter, []]));
  const overflow = [];

  for (const title of sortBrowseTitles(titles)) {
    const letter = resolveBrowseLetter(title);
    if (groups.has(letter)) {
      groups.get(letter).push(title);
      continue;
    }
    overflow.push(title);
  }

  const sections = [];
  if (overflow.length) {
    sections.push({letter: "#", titles: overflow});
  }

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
 * @param {Array<Record<string, any>> | null | undefined} titles
 * @returns {Array<{letter: string, count: number, disabled: boolean}>}
 */
export const buildBrowseLetterState = (titles) => {
  const counts = new Map(BROWSE_LETTERS.map((letter) => [letter, 0]));

  for (const title of Array.isArray(titles) ? titles : []) {
    const letter = resolveBrowseLetter(title);
    if (counts.has(letter)) {
      counts.set(letter, (counts.get(letter) || 0) + 1);
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

export default {
  BROWSE_LETTERS,
  buildBrowseLetterState,
  buildBrowseSections,
  filterBrowseTitles,
  resolveBrowseLetter,
  sortBrowseTitles
};
