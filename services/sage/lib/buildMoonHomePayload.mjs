/**
 * @file Build the personalized Moon user-home payload.
 */

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const formatTypeLabel = (value, fallback = "Library") => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallback;
  }

  return normalized
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const parseTimestamp = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return 0;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const chapterReleaseScore = (title = {}) =>
  normalizeArray(title.chapters).reduce((latest, chapter) => {
    const score = parseTimestamp(chapter?.releaseDate);
    return score > latest ? score : latest;
  }, 0);

const titleRecencyScore = (title = {}) =>
  Math.max(
    parseTimestamp(title.updatedAt),
    parseTimestamp(title.metadataMatchedAt),
    chapterReleaseScore(title)
  );

const sortTitlesByRecency = (titles = []) => [...normalizeArray(titles)].sort((left, right) => {
  const scoreDelta = titleRecencyScore(right) - titleRecencyScore(left);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return normalizeString(left.title).localeCompare(normalizeString(right.title));
});

const uniqueByTitleId = (entries = []) => {
  const seen = new Set();
  return normalizeArray(entries).filter((entry) => {
    const key = normalizeString(entry.titleId || entry.id || entry.mediaId);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const collectTopTags = (entries = []) => {
  const counts = new Map();

  for (const entry of uniqueByTitleId(entries)) {
    const tags = new Set(
      normalizeArray(entry.tags)
        .map((tag) => normalizeString(tag))
        .filter(Boolean)
    );
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((left, right) => {
      const countDelta = right[1] - left[1];
      if (countDelta !== 0) {
        return countDelta;
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([tag]) => tag);
};

const titleHasTag = (title, tag) =>
  normalizeArray(title?.tags).some((entry) => normalizeString(entry).toLowerCase() === tag.toLowerCase());

const buildRecentShelves = (titles = []) => {
  const groups = new Map();

  for (const title of sortTitlesByRecency(titles)) {
    const typeSlug = normalizeString(title.libraryTypeSlug || title.mediaType, "manga");
    if (!groups.has(typeSlug)) {
      groups.set(typeSlug, []);
    }
    groups.get(typeSlug).push(title);
  }

  return Array.from(groups.entries()).map(([typeSlug, items]) => {
    const typeLabel = normalizeString(items[0]?.libraryTypeLabel, formatTypeLabel(typeSlug));
    return {
      id: `recent:${typeSlug}`,
      kind: "recent",
      typeSlug,
      typeLabel,
      title: `Recently added to ${typeLabel}`,
      subtitle: `Fresh ${typeLabel.toLowerCase()} pulled into Moon.`,
      items: items.slice(0, 18)
    };
  });
};

const buildTagShelves = ({titles = [], continueReading = []}) => {
  const tags = collectTopTags(continueReading);
  const continueIds = new Set(uniqueByTitleId(continueReading).map((entry) => normalizeString(entry.titleId || entry.id)));

  return tags.flatMap((tag) => {
    const unseenMatches = sortTitlesByRecency(titles.filter((title) =>
      titleHasTag(title, tag) && !continueIds.has(normalizeString(title.id))
    ));
    const fallbackMatches = sortTitlesByRecency(titles.filter((title) => titleHasTag(title, tag)));
    const items = (unseenMatches.length ? unseenMatches : fallbackMatches).slice(0, 18);

    if (!items.length) {
      return [];
    }

    return [{
      id: `tag:${tag.toLowerCase()}`,
      kind: "tag",
      tag,
      title: `Because you read ${tag}`,
      subtitle: `More ${tag.toLowerCase()} from the library you already gravitate toward.`,
      items
    }];
  }).slice(0, 4);
};

/**
 * Build the Moon home payload from normalized library and user state.
 *
 * @param {{
 *   titles?: Array<Record<string, any>>,
 *   requests?: Array<Record<string, any>>,
 *   progress?: Array<Record<string, any>>,
 *   following?: Array<Record<string, any>>,
 *   discordUserId?: string
 * }} input
 * @returns {{
 *   latestTitles: Array<Record<string, any>>,
 *   continueReading: Array<Record<string, any>>,
 *   requests: Array<Record<string, any>>,
 *   following: Array<Record<string, any>>,
 *   shelves: Array<Record<string, any>>
 * }}
 */
export const buildMoonHomePayload = ({
  titles = [],
  requests = [],
  progress = [],
  following = [],
  discordUserId = ""
} = {}) => {
  const continueReading = uniqueByTitleId(progress);
  const latestTitles = sortTitlesByRecency(titles).slice(0, 12);
  const shelves = [];

  if (continueReading.length) {
    shelves.push({
      id: "bookshelf",
      kind: "bookshelf",
      title: "Your Bookshelf",
      subtitle: "Pick up where you left off and keep the story moving.",
      items: continueReading
    });
  }

  shelves.push(...buildRecentShelves(titles));
  shelves.push(...buildTagShelves({titles, continueReading}));

  return {
    latestTitles,
    continueReading,
    requests: normalizeArray(requests).filter((entry) => normalizeString(entry.requestedBy?.discordUserId) === normalizeString(discordUserId)),
    following: normalizeArray(following),
    shelves
  };
};

export default {
  buildMoonHomePayload
};
