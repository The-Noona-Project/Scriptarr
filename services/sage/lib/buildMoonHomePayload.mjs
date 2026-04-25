/**
 * @file Build the personalized Moon user-home payload.
 */

import {normalizeTagPreferenceStore} from "./moonUserState.mjs";

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

const normalizeTagKey = (value) => normalizeString(value).toLowerCase();

const titleHasTag = (title, tag) =>
  normalizeArray(title?.tags).some((entry) => normalizeTagKey(entry) === normalizeTagKey(tag));

const chapterReleaseScore = (title = {}) =>
  normalizeArray(title.chapters).reduce((latest, chapter) => {
    const score = parseTimestamp(chapter?.releaseDate);
    return score > latest ? score : latest;
  }, 0);

const titleRecencyScore = (title = {}) =>
  Math.max(
    parseTimestamp(title.userState?.lastActivityAt),
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

const buildTagShelves = ({titles = [], bookshelf = [], tagPreferences = {}}) => {
  const normalizedPreferences = normalizeTagPreferenceStore(tagPreferences);
  const disliked = new Set(normalizedPreferences.dislikedTags.map((tag) => normalizeTagKey(tag)));
  const liked = normalizedPreferences.likedTags.filter((tag) => !disliked.has(normalizeTagKey(tag)));
  const inferredSources = titles.filter((title) =>
    title.userState?.completed || title.userState?.bookshelf || title.userState?.following
  );
  const inferredTags = collectTopTags(inferredSources).filter((tag) => {
    const key = normalizeTagKey(tag);
    return !disliked.has(key) && !liked.some((entry) => normalizeTagKey(entry) === key);
  });
  const orderedTags = [...liked, ...inferredTags].slice(0, 6);
  const bookshelfIds = new Set(uniqueByTitleId(bookshelf).map((entry) => normalizeString(entry.titleId || entry.id)));

  return orderedTags.flatMap((tag) => {
    const tagKey = normalizeTagKey(tag);
    if (disliked.has(tagKey)) {
      return [];
    }

    const preferredMatches = sortTitlesByRecency(titles.filter((title) =>
      titleHasTag(title, tag) && !bookshelfIds.has(normalizeString(title.id))
    ));
    const fallbackMatches = sortTitlesByRecency(titles.filter((title) => titleHasTag(title, tag)));
    const items = (preferredMatches.length ? preferredMatches : fallbackMatches).slice(0, 18);

    if (!items.length) {
      return [];
    }

    const explicitLike = liked.some((entry) => normalizeTagKey(entry) === tagKey);
    return [{
      id: `tag:${tagKey}`,
      kind: "tag",
      tag,
      title: explicitLike ? `Because you like ${tag}` : `Because you read ${tag}`,
      subtitle: explicitLike
        ? `Moon is leaning into your explicit ${tag.toLowerCase()} taste.`
        : `More ${tag.toLowerCase()} from the library you already gravitate toward.`,
      items
    }];
  });
};

/**
 * Build the Moon home payload from normalized library and user state.
 *
 * @param {{
 *   titles?: Array<Record<string, any>>,
 *   requests?: Array<Record<string, any>>,
 *   bookshelf?: Array<Record<string, any>>,
 *   following?: Array<Record<string, any>>,
 *   discordUserId?: string,
 *   tagPreferences?: {likedTags?: string[], dislikedTags?: string[]}
 * }} input
 * @returns {{
 *   latestTitles: Array<Record<string, any>>,
 *   continueReading: Array<Record<string, any>>,
 *   requests: Array<Record<string, any>>,
 *   following: Array<Record<string, any>>,
 *   tagPreferences: {likedTags: string[], dislikedTags: string[]},
 *   shelves: Array<Record<string, any>>
 * }}
 */
export const buildMoonHomePayload = ({
  titles = [],
  requests = [],
  bookshelf = [],
  following = [],
  discordUserId = "",
  tagPreferences = {}
} = {}) => {
  const normalizedTitles = uniqueByTitleId(titles);
  const normalizedBookshelf = uniqueByTitleId(bookshelf);
  const latestTitles = sortTitlesByRecency(normalizedTitles).slice(0, 12);
  const shelves = [];

  if (normalizedBookshelf.length) {
    shelves.push({
      id: "bookshelf",
      kind: "bookshelf",
      title: "Your Bookshelf",
      subtitle: "Pick up where you left off and keep the story moving.",
      items: normalizedBookshelf
    });
  }

  shelves.push(...buildRecentShelves(normalizedTitles));
  shelves.push(...buildTagShelves({
    titles: normalizedTitles,
    bookshelf: normalizedBookshelf,
    tagPreferences
  }));

  return {
    latestTitles,
    continueReading: normalizedBookshelf,
    requests: normalizeArray(requests).filter((entry) => normalizeString(entry.requestedBy?.discordUserId) === normalizeString(discordUserId)),
    following: normalizeArray(following),
    tagPreferences: normalizeTagPreferenceStore(tagPreferences),
    shelves
  };
};

export default {
  buildMoonHomePayload
};
