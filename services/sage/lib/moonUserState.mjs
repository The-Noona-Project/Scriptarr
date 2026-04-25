/**
 * @file Shared Moon user-state helpers for tag preferences, read state, and bookshelf derivation.
 */

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const normalizeIso = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const normalizeTag = (value) => normalizeString(value);
const normalizeTagKey = (value) => normalizeTag(value).toLowerCase();

const dedupeTags = (values = []) => {
  const seen = new Set();
  const next = [];
  for (const value of normalizeArray(values)) {
    const normalized = normalizeTag(value);
    if (!normalized) {
      continue;
    }
    const key = normalizeTagKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(normalized);
  }
  return next;
};

const sortChaptersAscending = (chapters = []) => [...normalizeArray(chapters)].sort((left, right) => {
  const leftNumber = Number.parseFloat(String(left?.chapterNumber || ""));
  const rightNumber = Number.parseFloat(String(right?.chapterNumber || ""));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return Date.parse(String(left?.releaseDate || "")) - Date.parse(String(right?.releaseDate || ""));
});

const newestTimestamp = (...values) => values.reduce((latest, value) => {
  const parsed = Date.parse(normalizeString(value));
  return Number.isFinite(parsed) && parsed > latest ? parsed : latest;
}, 0);

/**
 * Normalize the persisted user tag preference store.
 *
 * @param {unknown} value
 * @returns {{likedTags: string[], dislikedTags: string[]}}
 */
export const normalizeTagPreferenceStore = (value) => {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const likedTags = dedupeTags(raw.likedTags || raw.liked || []);
  const likedKeys = new Set(likedTags.map((tag) => normalizeTagKey(tag)));
  const dislikedTags = dedupeTags(raw.dislikedTags || raw.disliked || []).filter((tag) => !likedKeys.has(normalizeTagKey(tag)));
  return {
    likedTags,
    dislikedTags
  };
};

/**
 * Apply one tag preference mutation to the persisted preference store.
 *
 * @param {unknown} value
 * @param {string} tag
 * @param {"like" | "dislike" | "clear" | "" | null | undefined} preference
 * @returns {{likedTags: string[], dislikedTags: string[]}}
 */
export const setTagPreference = (value, tag, preference) => {
  const store = normalizeTagPreferenceStore(value);
  const normalizedTag = normalizeTag(tag);
  if (!normalizedTag) {
    return store;
  }
  const key = normalizeTagKey(normalizedTag);
  const nextLikedTags = store.likedTags.filter((entry) => normalizeTagKey(entry) !== key);
  const nextDislikedTags = store.dislikedTags.filter((entry) => normalizeTagKey(entry) !== key);
  if (preference === "like") {
    nextLikedTags.push(normalizedTag);
  }
  if (preference === "dislike") {
    nextDislikedTags.push(normalizedTag);
  }
  return normalizeTagPreferenceStore({
    likedTags: nextLikedTags,
    dislikedTags: nextDislikedTags
  });
};

/**
 * Build a normalized user-state payload for the supplied library titles.
 *
 * @param {{
 *   titles?: Array<Record<string, any>>,
 *   progress?: Array<Record<string, any>>,
 *   readState?: {titleStates?: Array<Record<string, any>>, chapterReads?: Array<Record<string, any>>},
 *   following?: Array<Record<string, any>>
 * }} input
 * @returns {{
 *   titles: Array<Record<string, any>>,
 *   titleStateMap: Map<string, Record<string, any>>,
 *   bookshelf: Array<Record<string, any>>,
 *   startedTitles: Array<Record<string, any>>,
 *   completedTitles: Array<Record<string, any>>,
 *   followingTitles: Array<Record<string, any>>
 * }}
 */
export const buildMoonUserLibraryState = ({
  titles = [],
  progress = [],
  readState = {},
  following = []
} = {}) => {
  const progressByMediaId = new Map(normalizeArray(progress).map((entry) => [normalizeString(entry.mediaId || entry.titleId), entry]));
  const titleStateByMediaId = new Map(normalizeArray(readState?.titleStates).map((entry) => [normalizeString(entry.mediaId), entry]));
  const chapterReadsByMediaId = new Map();
  for (const entry of normalizeArray(readState?.chapterReads)) {
    const mediaId = normalizeString(entry.mediaId);
    const chapterId = normalizeString(entry.chapterId);
    if (!mediaId || !chapterId) {
      continue;
    }
    if (!chapterReadsByMediaId.has(mediaId)) {
      chapterReadsByMediaId.set(mediaId, new Map());
    }
    chapterReadsByMediaId.get(mediaId).set(chapterId, {
      ...entry,
      readAt: normalizeIso(entry.readAt),
      updatedAt: normalizeIso(entry.updatedAt)
    });
  }
  const followingIds = new Set(normalizeArray(following).map((entry) => normalizeString(entry.titleId)).filter(Boolean));

  const enrichedTitles = normalizeArray(titles).map((title) => {
    const mediaId = normalizeString(title.id);
    const progressEntry = progressByMediaId.get(mediaId) || null;
    const titleState = titleStateByMediaId.get(mediaId) || null;
    const chapterReads = chapterReadsByMediaId.get(mediaId) || new Map();
    const chaptersAscending = sortChaptersAscending(title.chapters);
    const chapters = chaptersAscending.map((chapter) => ({
      ...chapter,
      read: chapterReads.has(normalizeString(chapter.id)),
      readAt: chapterReads.get(normalizeString(chapter.id))?.readAt || null
    }));
    const availableChapters = chapters.filter((chapter) => chapter.available !== false);
    const readAvailableCount = availableChapters.filter((chapter) => chapter.read).length;
    const unreadAvailableCount = Math.max(0, availableChapters.length - readAvailableCount);
    const nextUnreadChapter = availableChapters.find((chapter) => !chapter.read) || null;
    const started = Boolean(progressEntry || titleState?.startedAt || titleState?.completedAt || chapterReads.size);
    const completed = availableChapters.length > 0
      ? unreadAvailableCount === 0
      : Boolean(titleState?.completedAt);
    const bookshelf = started && unreadAvailableCount > 0;
    const lastActivityAt = newestTimestamp(
      progressEntry?.updatedAt,
      titleState?.updatedAt,
      ...Array.from(chapterReads.values()).flatMap((entry) => [entry.readAt, entry.updatedAt])
    );
    const bookmark = progressEntry?.bookmark && typeof progressEntry.bookmark === "object"
      ? progressEntry.bookmark
      : nextUnreadChapter
        ? {chapterId: nextUnreadChapter.id, pageIndex: 0}
        : null;
    return {
      ...title,
      chapters,
      userState: {
        started,
        completed,
        bookshelf,
        following: followingIds.has(mediaId),
        readChapterIds: chapters.filter((chapter) => chapter.read).map((chapter) => chapter.id),
        readAvailableCount,
        unreadAvailableCount,
        totalAvailableChapters: availableChapters.length,
        nextUnreadChapterId: nextUnreadChapter?.id || "",
        nextUnreadChapterLabel: normalizeString(nextUnreadChapter?.label),
        lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
        positionRatio: typeof progressEntry?.positionRatio === "number" ? progressEntry.positionRatio : 0,
        bookmark,
        chapterLabel: normalizeString(progressEntry?.chapterLabel, normalizeString(nextUnreadChapter?.label, normalizeString(title.latestChapter, "Continue reading"))),
        startedAt: normalizeIso(titleState?.startedAt),
        completedAt: completed ? normalizeIso(titleState?.completedAt || titleState?.updatedAt || title.updatedAt) : null
      }
    };
  });

  const titleStateMap = new Map(enrichedTitles.map((title) => [normalizeString(title.id), title.userState]));
  const sortByActivity = (entries = []) => [...normalizeArray(entries)].sort((left, right) => {
    const delta = newestTimestamp(right?.userState?.lastActivityAt, right?.updatedAt, right?.metadataMatchedAt)
      - newestTimestamp(left?.userState?.lastActivityAt, left?.updatedAt, left?.metadataMatchedAt);
    if (delta !== 0) {
      return delta;
    }
    return normalizeString(left?.title).localeCompare(normalizeString(right?.title));
  });
  const bookshelf = sortByActivity(enrichedTitles.filter((title) => title.userState?.bookshelf)).map((title) => ({
    ...title,
    titleId: normalizeString(title.id),
    bookmark: title.userState?.bookmark || null,
    chapterLabel: normalizeString(title.userState?.chapterLabel, normalizeString(title.latestChapter, "Continue reading")),
    positionRatio: Number(title.userState?.positionRatio || 0),
    updatedAt: title.userState?.lastActivityAt || title.updatedAt || title.metadataMatchedAt || null
  }));

  return {
    titles: enrichedTitles,
    titleStateMap,
    bookshelf,
    startedTitles: sortByActivity(enrichedTitles.filter((title) => title.userState?.started)),
    completedTitles: sortByActivity(enrichedTitles.filter((title) => title.userState?.completed)),
    followingTitles: sortByActivity(enrichedTitles.filter((title) => title.userState?.following))
  };
};

/**
 * Resolve the preference state for one tag label.
 *
 * @param {unknown} store
 * @param {string} tag
 * @returns {"" | "like" | "dislike"}
 */
export const getTagPreference = (store, tag) => {
  const normalizedStore = normalizeTagPreferenceStore(store);
  const key = normalizeTagKey(tag);
  if (normalizedStore.likedTags.some((entry) => normalizeTagKey(entry) === key)) {
    return "like";
  }
  if (normalizedStore.dislikedTags.some((entry) => normalizeTagKey(entry) === key)) {
    return "dislike";
  }
  return "";
};

export default {
  buildMoonUserLibraryState,
  getTagPreference,
  normalizeTagPreferenceStore,
  setTagPreference
};
