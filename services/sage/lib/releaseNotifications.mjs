/**
 * @file Release digest state and payload helpers for Portal Discord posts.
 */

export const RELEASE_NOTIFICATION_ACK_KEY = "portal.releaseNotifications";

export const RELEASE_DIGEST_VISIBLE_LIMIT = 10;

const MAX_RELEASE_ACK_IDS = 1000;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeScalarString = (value, fallback = "") => {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || fallback;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized || fallback;
  }
  return fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

const normalizeTitleKey = (value) => normalizeString(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const titleIdentityKey = (titleName, typeSlug) => {
  const normalizedTitle = normalizeTitleKey(titleName);
  if (!normalizedTitle) {
    return "";
  }
  return `${normalizeTypeSlug(typeSlug)}::${normalizedTitle}`;
};

const parseTimestamp = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return Number.NaN;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const toIso = (value) => {
  const parsed = parseTimestamp(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
};

const uniqueStrings = (values) => {
  const seen = new Set();
  const normalized = [];
  for (const value of normalizeArray(values)) {
    const entry = normalizeString(value);
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    normalized.push(entry);
  }
  return normalized;
};

const releaseNotificationId = (taskId) => `release:${normalizeScalarString(taskId)}`;

const taskCompletedAt = (task = {}) => normalizeString(
  task.completedAt,
  normalizeString(
    task.finishedAt,
    normalizeString(task.updatedAt, normalizeString(task.createdAt))
  )
);

const buildLibraryLookup = (titles = []) => {
  const byId = new Map();
  const bySourceUrl = new Map();
  const byIdentity = new Map();

  for (const title of normalizeArray(titles)) {
    const titleId = normalizeScalarString(title?.id);
    if (titleId && !byId.has(titleId)) {
      byId.set(titleId, title);
    }

    const sourceUrl = normalizeString(title?.sourceUrl);
    if (sourceUrl && !bySourceUrl.has(sourceUrl)) {
      bySourceUrl.set(sourceUrl, title);
    }

    const typeSlug = title?.libraryTypeSlug || title?.mediaType;
    const primaryIdentity = titleIdentityKey(title?.title, typeSlug);
    if (primaryIdentity && !byIdentity.has(primaryIdentity)) {
      byIdentity.set(primaryIdentity, title);
    }
    for (const alias of normalizeArray(title?.aliases)) {
      const aliasIdentity = titleIdentityKey(alias, typeSlug);
      if (aliasIdentity && !byIdentity.has(aliasIdentity)) {
        byIdentity.set(aliasIdentity, title);
      }
    }
  }

  return {byId, bySourceUrl, byIdentity};
};

const resolveLibraryTitle = (lookup, task = {}) => {
  const titleId = normalizeScalarString(task.titleId);
  if (titleId && lookup.byId.has(titleId)) {
    return lookup.byId.get(titleId);
  }

  const sourceUrl = normalizeString(task.titleUrl);
  if (sourceUrl && lookup.bySourceUrl.has(sourceUrl)) {
    return lookup.bySourceUrl.get(sourceUrl);
  }

  const identity = titleIdentityKey(task.titleName, task.libraryTypeSlug || task.mediaType || task.requestType);
  return identity && lookup.byIdentity.has(identity) ? lookup.byIdentity.get(identity) : null;
};

const newestChapter = (title = {}) => [...normalizeArray(title?.chapters)]
  .filter((chapter) => normalizeString(chapter?.id) && chapter?.available !== false)
  .sort((left, right) => {
    const rightTime = parseTimestamp(right?.releaseDate || right?.updatedAt);
    const leftTime = parseTimestamp(left?.releaseDate || left?.updatedAt);
    if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    const rightNumber = Number.parseFloat(String(right?.chapterNumber || "0"));
    const leftNumber = Number.parseFloat(String(left?.chapterNumber || "0"));
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return rightNumber - leftNumber;
    }
    return normalizeString(right?.label).localeCompare(normalizeString(left?.label));
  })[0] || null;

const isGenericTaskMessage = (value) => {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!normalized) {
    return true;
  }
  return /^(raven\s+)?download(ed)?\s+completed\.?$/.test(normalized)
    || normalized === "completed"
    || normalized === "raven completed";
};

const resolveChapterLabel = ({task, matchedTitle, chapter}) => {
  const taskMessage = normalizeString(task?.message);
  if (taskMessage && !isGenericTaskMessage(taskMessage)) {
    return taskMessage;
  }
  return normalizeString(
    chapter?.label,
    normalizeString(
      chapter?.title,
      normalizeString(task?.latestChapter, normalizeString(matchedTitle?.latestChapter, "Latest chapter"))
    )
  );
};

const compareReleaseItems = (left, right) => {
  const rightTime = parseTimestamp(right?.completedAt);
  const leftTime = parseTimestamp(left?.completedAt);
  if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  if (Number.isFinite(rightTime) !== Number.isFinite(leftTime)) {
    return Number.isFinite(rightTime) ? 1 : -1;
  }
  return normalizeString(right?.taskId).localeCompare(normalizeString(left?.taskId));
};

/**
 * Normalize the durable release notification state stored in Vault.
 *
 * @param {unknown} value
 * @returns {{ackedIds: string[], silenceBefore: string, lastDigestAt: string, updatedAt: string}}
 */
export const normalizeReleaseNotificationState = (value = {}) => {
  if (Array.isArray(value)) {
    return {
      ackedIds: uniqueStrings(value).slice(-MAX_RELEASE_ACK_IDS),
      silenceBefore: "",
      lastDigestAt: "",
      updatedAt: ""
    };
  }

  const source = normalizeObject(value, {}) || {};
  return {
    ackedIds: uniqueStrings(source.ackedIds).slice(-MAX_RELEASE_ACK_IDS),
    silenceBefore: toIso(source.silenceBefore),
    lastDigestAt: toIso(source.lastDigestAt),
    updatedAt: toIso(source.updatedAt)
  };
};

/**
 * Build at most one digest notification from completed Raven tasks.
 *
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.channelId
 * @param {unknown[]} options.tasks
 * @param {unknown[]} options.libraryTitles
 * @param {unknown} options.state
 * @param {number} [options.maxItems]
 * @returns {Array<Record<string, unknown>>}
 */
export const buildReleaseNotificationDigests = ({
  config = {},
  channelId = "",
  tasks = [],
  libraryTitles = [],
  state = {},
  maxItems = RELEASE_DIGEST_VISIBLE_LIMIT
} = {}) => {
  const normalizedChannelId = normalizeScalarString(channelId);
  if (!normalizedChannelId) {
    return [];
  }

  const normalizedState = normalizeReleaseNotificationState(state);
  const ackedSet = new Set(normalizedState.ackedIds);
  const silenceBeforeTime = parseTimestamp(normalizedState.silenceBefore);
  const lookup = buildLibraryLookup(libraryTitles);

  const items = normalizeArray(tasks)
    .filter((task) => normalizeString(task?.status) === "completed")
    .map((task) => {
      const taskId = normalizeScalarString(task?.taskId || task?.id);
      const id = releaseNotificationId(taskId);
      const matchedTitle = resolveLibraryTitle(lookup, task);
      const chapter = newestChapter(matchedTitle);
      const titleId = normalizeScalarString(task?.titleId, normalizeScalarString(matchedTitle?.id));
      const typeSlug = normalizeTypeSlug(
        task?.libraryTypeSlug
        || matchedTitle?.libraryTypeSlug
        || task?.mediaType
        || task?.requestType
        || matchedTitle?.mediaType
      );
      const titleUrl = titleId
        ? `${normalizeString(config.publicBaseUrl).replace(/\/+$/g, "")}/title/${encodeURIComponent(typeSlug)}/${encodeURIComponent(titleId)}`
        : "";
      const readerUrl = titleId && chapter?.id
        ? `${normalizeString(config.publicBaseUrl).replace(/\/+$/g, "")}/reader/${encodeURIComponent(typeSlug)}/${encodeURIComponent(chapter.id)}`
        : "";
      return {
        id,
        taskId,
        titleId,
        titleName: normalizeString(task?.titleName, normalizeString(matchedTitle?.title, "Untitled")),
        libraryTypeSlug: typeSlug,
        chapterId: normalizeString(chapter?.id),
        chapterLabel: resolveChapterLabel({task, matchedTitle, chapter}),
        coverUrl: normalizeString(task?.coverUrl, normalizeString(matchedTitle?.coverUrl)),
        titleUrl,
        readerUrl,
        linkUrl: readerUrl || titleUrl,
        completedAt: taskCompletedAt(task)
      };
    })
    .filter((item) => {
      if (!item.taskId || !item.id || ackedSet.has(item.id)) {
        return false;
      }
      if (!Number.isFinite(silenceBeforeTime)) {
        return true;
      }
      const completedTime = parseTimestamp(item.completedAt);
      return Number.isFinite(completedTime) && completedTime > silenceBeforeTime;
    })
    .sort(compareReleaseItems);

  if (!items.length) {
    return [];
  }

  const visibleLimit = Math.min(
    Math.max(1, Number.parseInt(String(maxItems || RELEASE_DIGEST_VISIBLE_LIMIT), 10) || RELEASE_DIGEST_VISIBLE_LIMIT),
    RELEASE_DIGEST_VISIBLE_LIMIT
  );
  const visibleItems = items.slice(0, visibleLimit);
  const newest = items[0];
  const oldest = items[items.length - 1];

  return [{
    id: `release:digest:${newest.taskId}:${items.length}`,
    channelId: normalizedChannelId,
    digest: true,
    items: visibleItems,
    totalCount: items.length,
    hiddenCount: Math.max(0, items.length - visibleItems.length),
    newestCompletedAt: normalizeString(newest.completedAt),
    oldestCompletedAt: normalizeString(oldest.completedAt),
    silenceThrough: toIso(newest.completedAt),
    ackItemIds: visibleItems.map((item) => item.id)
  }];
};

/**
 * Merge Portal's post-send acknowledgment metadata into the durable release state.
 *
 * @param {unknown} state
 * @param {object} ack
 * @param {string} ack.notificationId
 * @param {unknown[]} [ack.ackItemIds]
 * @param {string} [ack.silenceThrough]
 * @param {string} [nowIsoValue]
 * @returns {{ackedIds: string[], silenceBefore: string, lastDigestAt: string, updatedAt: string}}
 */
export const mergeReleaseNotificationAck = (state, {
  notificationId = "",
  ackItemIds = [],
  silenceThrough = ""
} = {}, nowIsoValue = new Date().toISOString()) => {
  const current = normalizeReleaseNotificationState(state);
  const nextAcked = uniqueStrings([
    ...current.ackedIds,
    normalizeString(notificationId),
    ...normalizeArray(ackItemIds)
  ]).slice(-MAX_RELEASE_ACK_IDS);

  const currentSilence = parseTimestamp(current.silenceBefore);
  const ackSilence = parseTimestamp(silenceThrough);
  const silenceBefore = Number.isFinite(ackSilence) && (!Number.isFinite(currentSilence) || ackSilence > currentSilence)
    ? new Date(ackSilence).toISOString()
    : current.silenceBefore;
  const normalizedNow = toIso(nowIsoValue) || new Date().toISOString();

  return {
    ackedIds: nextAcked,
    silenceBefore,
    lastDigestAt: normalizeString(notificationId).startsWith("release:digest:")
      ? normalizedNow
      : current.lastDigestAt,
    updatedAt: normalizedNow
  };
};
