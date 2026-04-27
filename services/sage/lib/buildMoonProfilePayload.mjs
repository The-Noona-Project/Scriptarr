/**
 * @file Build the tabbed Moon profile payload from trusted user-library state.
 */

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const parseTimestamp = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return 0;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortByTimestamp = (entries = [], resolver) => [...normalizeArray(entries)].sort((left, right) =>
  resolver(right) - resolver(left)
);

const summarizeTitle = (title = {}) => ({
  titleId: normalizeString(title.id, normalizeString(title.titleId)),
  title: normalizeString(title.title, "Untitled"),
  libraryTypeLabel: normalizeString(title.libraryTypeLabel, normalizeString(title.mediaType, "Manga")),
  libraryTypeSlug: normalizeString(title.libraryTypeSlug, normalizeString(title.mediaType, "manga")),
  coverUrl: normalizeString(title.coverUrl),
  latestChapter: normalizeString(title.latestChapter),
  chapterLabel: normalizeString(title.userState?.chapterLabel, normalizeString(title.latestChapter)),
  positionRatio: Number(title.userState?.positionRatio || 0),
  unreadAvailableCount: Number(title.userState?.unreadAvailableCount || 0),
  lastActivityAt: normalizeString(title.userState?.lastActivityAt, normalizeString(title.updatedAt)),
  completedAt: normalizeString(title.userState?.completedAt),
  following: title.userState?.following === true,
  bookshelf: title.userState?.bookshelf === true
});

const summarizeRequest = (request = {}) => ({
  id: normalizeString(request.id),
  title: normalizeString(request.title, "Untitled request"),
  status: normalizeString(request.status, "pending"),
  requestType: normalizeString(request.requestType, "manga"),
  updatedAt: normalizeString(request.updatedAt),
  createdAt: normalizeString(request.createdAt),
  notes: normalizeString(request.notes),
  coverUrl: normalizeString(request.coverUrl, normalizeString(request.details?.coverUrl))
});

const buildRequestCounts = (requests = []) => {
  const counts = {
    total: 0,
    active: 0,
    completed: 0,
    closed: 0
  };

  for (const request of normalizeArray(requests)) {
    counts.total += 1;
    const status = normalizeString(request.status).toLowerCase();
    if (["pending", "queued", "running", "downloading", "failed", "unavailable"].includes(status)) {
      counts.active += 1;
      continue;
    }
    if (status === "completed") {
      counts.completed += 1;
      continue;
    }
    counts.closed += 1;
  }

  return counts;
};

const buildRecentActivity = ({bookshelf = [], completedTitles = [], requests = []}) => {
  const readingEntries = normalizeArray(bookshelf).map((title) => ({
    id: `reading:${normalizeString(title.titleId)}`,
    kind: "reading",
    label: normalizeString(title.chapterLabel, "Continue reading"),
    titleId: normalizeString(title.titleId),
    title: normalizeString(title.title, "Untitled"),
    typeLabel: normalizeString(title.libraryTypeLabel, "Manga"),
    at: normalizeString(title.updatedAt, normalizeString(title.lastActivityAt))
  }));
  const completedEntries = normalizeArray(completedTitles).map((title) => ({
    id: `completed:${normalizeString(title.titleId)}`,
    kind: "completed",
    label: "Completed",
    titleId: normalizeString(title.titleId),
    title: normalizeString(title.title, "Untitled"),
    typeLabel: normalizeString(title.libraryTypeLabel, "Manga"),
    at: normalizeString(title.completedAt, normalizeString(title.lastActivityAt))
  }));
  const requestEntries = normalizeArray(requests).map((request) => ({
    id: `request:${normalizeString(request.id)}`,
    kind: "request",
    label: normalizeString(request.status, "updated"),
    requestId: normalizeString(request.id),
    title: normalizeString(request.title, "Untitled request"),
    typeLabel: normalizeString(request.requestType, "manga"),
    at: normalizeString(request.updatedAt, normalizeString(request.createdAt))
  }));

  return sortByTimestamp(
    [...readingEntries, ...completedEntries, ...requestEntries].filter((entry) => entry.at),
    (entry) => parseTimestamp(entry.at)
  ).slice(0, 8);
};

/**
 * Build the user-facing Moon profile payload.
 *
 * @param {{
 *   userLibrary?: {
 *     bookshelf?: Array<Record<string, any>>,
 *     startedTitles?: Array<Record<string, any>>,
 *     completedTitles?: Array<Record<string, any>>,
 *     followingTitles?: Array<Record<string, any>>,
 *     tagPreferences?: {likedTags?: string[], dislikedTags?: string[]}
 *   },
 *   requests?: Array<Record<string, any>>
 * }} input
 * @returns {{
 *   stats: {
 *     bookshelfCount: number,
 *     inProgressCount: number,
 *     completedCount: number,
 *     followingCount: number,
 *     requestCounts: {total: number, active: number, completed: number, closed: number},
 *     likedTagCount: number,
 *     dislikedTagCount: number
 *   },
 *   overview: {
 *     bookshelfPreview: Array<Record<string, any>>,
 *     requestPreview: Array<Record<string, any>>,
 *     followingPreview: Array<Record<string, any>>
 *   },
 *   statsPanels: {
 *     inProgressTitles: Array<Record<string, any>>,
 *     completedTitles: Array<Record<string, any>>,
 *     followingTitles: Array<Record<string, any>>,
 *     recentActivity: Array<Record<string, any>>
 *   }
 * }}
 */
export const buildMoonProfilePayload = ({
  userLibrary = {},
  requests = []
} = {}) => {
  const bookshelf = normalizeArray(userLibrary.bookshelf).map(summarizeTitle);
  const startedTitles = normalizeArray(userLibrary.startedTitles).map(summarizeTitle);
  const completedTitles = normalizeArray(userLibrary.completedTitles).map(summarizeTitle);
  const followingTitles = normalizeArray(userLibrary.followingTitles).map(summarizeTitle);
  const normalizedRequests = normalizeArray(requests).map(summarizeRequest);
  const requestCounts = buildRequestCounts(normalizedRequests);
  const likedTags = normalizeArray(userLibrary.tagPreferences?.likedTags);
  const dislikedTags = normalizeArray(userLibrary.tagPreferences?.dislikedTags);

  return {
    stats: {
      bookshelfCount: bookshelf.length,
      inProgressCount: startedTitles.filter((title) => !title.completedAt).length,
      completedCount: completedTitles.length,
      followingCount: followingTitles.length,
      requestCounts,
      likedTagCount: likedTags.length,
      dislikedTagCount: dislikedTags.length
    },
    overview: {
      bookshelfPreview: bookshelf.slice(0, 4),
      requestPreview: sortByTimestamp(normalizedRequests, (request) => parseTimestamp(request.updatedAt || request.createdAt)).slice(0, 4),
      followingPreview: followingTitles.slice(0, 4)
    },
    statsPanels: {
      inProgressTitles: startedTitles.filter((title) => !title.completedAt).slice(0, 6),
      completedTitles: sortByTimestamp(completedTitles, (title) => parseTimestamp(title.completedAt || title.lastActivityAt)).slice(0, 6),
      followingTitles: followingTitles.slice(0, 6),
      recentActivity: buildRecentActivity({
        bookshelf,
        completedTitles,
        requests: normalizedRequests
      })
    }
  };
};

export default {
  buildMoonProfilePayload
};
