import {createHash, randomUUID} from "node:crypto";

import mysql from "mysql2/promise";
import {deriveLegacyPermissions, seedPermissionGroups} from "@scriptarr/access";
import {createCachedStore} from "./createCachedStore.mjs";
import {
  buildEffectiveUserAccess,
  ensureSeedPermissionGroups,
  ensureSingleDefaultGroup,
  getDefaultGroupId,
  normalizePermissionGroup
} from "./accessControl.mjs";
import {
  buildMemoryDatabaseOverview,
  buildMysqlDatabaseOverview,
  normalizeDatabaseSettingUpdate,
  readMemoryDatabaseTable,
  readMysqlDatabaseTable
} from "./databaseExplorer.mjs";
import {DEFAULT_EVENT_RETENTION_DAYS, normalizeEventFilters, normalizeVaultEvent} from "./vaultEvents.mjs";

const nowIso = () => new Date().toISOString();
const randomToken = (prefix) => `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const toMysqlDateTime = (value, fallback = null) => {
  if (!value) {
    return fallback;
  }

  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return date.toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
};
const toIsoTimestamp = (value, fallback = null) => {
  if (!value) {
    return fallback;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
};
const parseJsonColumn = (value, fallback = null) => {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
};
const cloneJsonValue = (value, fallback = null) => {
  if (value == null) {
    return fallback;
  }
  return JSON.parse(JSON.stringify(value));
};
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
const normalizeBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};
const readStateKey = (discordUserId, mediaId) => `${normalizeString(discordUserId)}::${normalizeString(mediaId)}`;
const normalizeReadStateTimestamp = (value, fallback = null) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallback;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
};
const toTitleReadState = (value = {}) => ({
  mediaId: normalizeString(value.mediaId || value.media_id),
  discordUserId: normalizeString(value.discordUserId || value.discord_user_id),
  startedAt: normalizeReadStateTimestamp(value.startedAt || value.started_at),
  completedAt: normalizeReadStateTimestamp(value.completedAt || value.completed_at),
  updatedAt: normalizeReadStateTimestamp(value.updatedAt || value.updated_at, nowIso())
});
const toChapterReadState = (value = {}) => ({
  mediaId: normalizeString(value.mediaId || value.media_id),
  chapterId: normalizeString(value.chapterId || value.chapter_id),
  discordUserId: normalizeString(value.discordUserId || value.discord_user_id),
  readAt: normalizeReadStateTimestamp(value.readAt || value.read_at, nowIso()),
  updatedAt: normalizeReadStateTimestamp(value.updatedAt || value.updated_at, nowIso())
});
const CONTENT_RESET_SETTING_PREFIXES = Object.freeze([
  "moon.following.",
  "moon.reader.bookmarks."
]);
const API_KEY_KINDS = new Set(["system", "user"]);
const normalizeApiKeyKind = (value, fallback = "system") => {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return API_KEY_KINDS.has(normalized) ? normalized : fallback;
};
const normalizeApiKeyCreatedBy = (value = {}) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      actorType: normalizeString(value.actorType, "user"),
      actorId: normalizeString(value.actorId || value.discordUserId || value.id),
      actorLabel: normalizeString(value.actorLabel || value.username || value.name, "Scriptarr user")
    };
  }
  const actorId = normalizeString(value);
  return {
    actorType: actorId ? "user" : "service",
    actorId,
    actorLabel: actorId || "Scriptarr"
  };
};
const normalizeApiKeyGroupIds = (value = []) => Array.from(new Set(
  (Array.isArray(value) ? value : [])
    .map((entry) => normalizeString(entry).toLowerCase())
    .filter(Boolean)
)).sort();
const normalizeApiKeyRecord = (value = {}, fallback = {}) => {
  const kind = normalizeApiKeyKind(value.kind ?? value.keyKind ?? fallback.kind, "system");
  const createdAt = toIsoTimestamp(value.createdAt || value.created_at, fallback.createdAt || nowIso()) || nowIso();
  const updatedAt = toIsoTimestamp(value.updatedAt || value.updated_at, fallback.updatedAt || createdAt) || createdAt;
  return {
    id: normalizeString(value.id || value.apiKeyId || value.api_key_id || fallback.id),
    name: normalizeString(value.name || value.keyName || value.key_name, normalizeString(fallback.name, "API key")),
    kind,
    enabled: normalizeBoolean(value.enabled, fallback.enabled !== false),
    keyHash: normalizeString(value.keyHash || value.key_hash, normalizeString(fallback.keyHash)),
    keyPrefix: normalizeString(value.keyPrefix || value.key_prefix, normalizeString(fallback.keyPrefix)),
    ownerDiscordUserId: kind === "user"
      ? normalizeString(value.ownerDiscordUserId || value.owner_discord_user_id, normalizeString(fallback.ownerDiscordUserId))
      : "",
    createdBy: normalizeApiKeyCreatedBy(value.createdBy ?? value.created_by ?? fallback.createdBy),
    groupIds: kind === "system" ? normalizeApiKeyGroupIds(value.groupIds ?? value.group_ids ?? fallback.groupIds) : [],
    lastUsedAt: toIsoTimestamp(value.lastUsedAt || value.last_used_at, fallback.lastUsedAt || null),
    createdAt,
    updatedAt,
    revokedAt: toIsoTimestamp(value.revokedAt || value.revoked_at, fallback.revokedAt || null)
  };
};
const validateApiKeyCreate = (entry) => {
  if (!entry.keyHash) {
    throw createConflictError("API key hash is required.", "API_KEY_REQUIRED");
  }
  if (entry.kind === "user" && !entry.ownerDiscordUserId) {
    throw createConflictError("User API keys require an owner.", "API_KEY_REQUIRED");
  }
};
const REQUEST_STATUSES = new Set([
  "pending",
  "unavailable",
  "denied",
  "blocked",
  "queued",
  "downloading",
  "completed",
  "failed",
  "expired",
  "cancelled"
]);
const ACTIVE_REQUEST_WORK_STATUSES = new Set(["pending", "unavailable", "queued", "downloading"]);
const normalizeRequestStatus = (value, fallback = "pending") => {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return REQUEST_STATUSES.has(normalized) ? normalized : fallback;
};
const normalizeAvailabilityState = (value, fallback = "unavailable") => {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return normalized === "available" ? "available" : "unavailable";
};
const normalizeRequestDetails = (value = {}) => {
  const next = value && typeof value === "object" ? cloneJsonValue(value, {}) : {};
  next.query = normalizeString(next.query);
  next.selectedMetadata = next.selectedMetadata && typeof next.selectedMetadata === "object"
    ? cloneJsonValue(next.selectedMetadata, null)
    : null;
  next.selectedDownload = next.selectedDownload && typeof next.selectedDownload === "object"
    ? cloneJsonValue(next.selectedDownload, null)
    : null;
  next.availability = normalizeAvailabilityState(
    next.availability,
    next.selectedDownload ? "available" : "unavailable"
  );
  next.sourceFoundAt = normalizeString(next.sourceFoundAt);
  next.sourceFoundOptions = Array.isArray(next.sourceFoundOptions) ? cloneJsonValue(next.sourceFoundOptions, []) : [];
  next.waitlist = Array.isArray(next.waitlist) ? cloneJsonValue(next.waitlist, []) : [];
  next.jobId = normalizeString(next.jobId || next.linkedJobId);
  next.taskId = normalizeString(next.taskId || next.linkedTaskId);
  delete next.linkedJobId;
  delete next.linkedTaskId;
  delete next.requestWorkKey;
  delete next.requestWorkKind;
  delete next.requestWorkHash;
  delete next.workKey;
  delete next.workKeyKind;
  delete next.workKeyHash;
  return next;
};
const mergeRequestDetails = (currentValue, patchValue) => {
  if (!patchValue || typeof patchValue !== "object") {
    return normalizeRequestDetails(currentValue);
  }
  return normalizeRequestDetails({
    ...cloneJsonValue(currentValue, {}),
    ...cloneJsonValue(patchValue, {})
  });
};
const defaultRequestEventMessage = (eventType) => {
  switch (normalizeString(eventType).toLowerCase()) {
    case "created":
      return "Request created.";
    case "approved":
      return "Request approved.";
    case "queued":
      return "Request queued for Raven.";
    case "downloading":
      return "Raven is downloading this title.";
    case "completed":
      return "Request completed.";
    case "failed":
      return "Request failed.";
    case "unavailable":
      return "No enabled download provider matched this request yet.";
    case "denied":
      return "Request denied.";
    case "blocked":
      return "Request blocked because Scriptarr is already tracking that title.";
    case "expired":
      return "Request expired after waiting too long without a source.";
    case "cancelled":
      return "Request cancelled by the requester.";
    case "source-found":
      return "Scriptarr found a new download source for this request.";
    default:
      return "Request updated.";
  }
};
const buildRequestTimelineEntry = ({
  eventType,
  message,
  actor,
  at = nowIso()
}) => ({
  type: normalizeString(eventType, "updated"),
  message: normalizeString(message, defaultRequestEventMessage(eventType)),
  at,
  actor: normalizeString(actor)
});
const buildInitialRequestTimeline = ({requestedBy, status}) => {
  const timeline = [buildRequestTimelineEntry({
    eventType: "created",
    actor: requestedBy
  })];
  const normalizedStatus = normalizeRequestStatus(status, "pending");
  if (normalizedStatus === "unavailable") {
    timeline.push(buildRequestTimelineEntry({
      eventType: "unavailable",
      actor: requestedBy
    }));
  }
  return timeline;
};
const buildRequestWorkIdentity = (value = {}) => {
  const details = value?.details && typeof value.details === "object" ? value.details : value;
  const selectedDownload = details?.selectedDownload && typeof details.selectedDownload === "object"
    ? details.selectedDownload
    : null;
  const selectedMetadata = details?.selectedMetadata && typeof details.selectedMetadata === "object"
    ? details.selectedMetadata
    : null;
  const providerId = normalizeString(selectedDownload?.providerId).toLowerCase();
  const titleUrl = normalizeString(selectedDownload?.titleUrl);
  if (providerId && titleUrl) {
    const key = `download:${providerId}::${titleUrl}`;
    return {
      key,
      hash: createHash("sha256").update(key).digest("hex"),
      kind: "download"
    };
  }

  const metadataProviderId = normalizeString(selectedMetadata?.provider).toLowerCase();
  const providerSeriesId = normalizeScalarString(selectedMetadata?.providerSeriesId);
  if (metadataProviderId && providerSeriesId) {
    const key = `metadata:${metadataProviderId}::${providerSeriesId}`;
    return {
      key,
      hash: createHash("sha256").update(key).digest("hex"),
      kind: "metadata"
    };
  }

  return {
    key: "",
    hash: "",
    kind: ""
  };
};
const requestStatusUsesWorkLock = (status) => ACTIVE_REQUEST_WORK_STATUSES.has(normalizeRequestStatus(status, "pending"));
const applyRequestWorkIdentity = (request = {}) => {
  const workIdentity = buildRequestWorkIdentity(request);
  const details = request.details && typeof request.details === "object"
    ? cloneJsonValue(request.details, {})
    : {};
  if (workIdentity.key) {
    details.requestWorkKey = workIdentity.key;
    details.requestWorkKind = workIdentity.kind;
    details.requestWorkHash = workIdentity.hash;
  }
  return {
    ...request,
    details,
    workKey: workIdentity.key,
    workKeyHash: workIdentity.hash,
    workKeyKind: workIdentity.kind
  };
};
const buildRequestWorkConflict = (existingRequestId, workIdentity) => {
  const error = createConflictError("That title is already queued or has an active request.", "REQUEST_WORK_KEY_CONFLICT");
  error.requestId = normalizeScalarString(existingRequestId);
  error.workKey = normalizeString(workIdentity?.key);
  error.workKeyKind = normalizeString(workIdentity?.kind);
  return error;
};
const applyRequestUpdate = (existing, update = {}) => {
  const next = {
    ...existing,
    title: Object.hasOwn(update, "title") ? normalizeString(update.title, existing.title) : existing.title,
    requestType: Object.hasOwn(update, "requestType") ? normalizeString(update.requestType, existing.requestType) : existing.requestType,
    notes: Object.hasOwn(update, "notes") ? normalizeString(update.notes) : existing.notes,
    status: Object.hasOwn(update, "status")
      ? normalizeRequestStatus(update.status, existing.status || "pending")
      : normalizeRequestStatus(existing.status, "pending"),
    moderatorComment: Object.hasOwn(update, "moderatorComment")
      ? normalizeString(update.moderatorComment)
      : normalizeString(existing.moderatorComment),
    details: Object.hasOwn(update, "details")
      ? normalizeRequestDetails(update.details)
      : mergeRequestDetails(existing.details, update.detailsMerge),
    updatedAt: nowIso(),
    revision: Number.parseInt(String(existing.revision || 1), 10) + 1
  };

  const nextTimeline = Array.isArray(existing.timeline) ? [...existing.timeline] : [];
  const requestedEventType = normalizeString(update.eventType);
  const shouldAppendStatusEvent = Object.hasOwn(update, "status")
    && next.status !== normalizeRequestStatus(existing.status, "pending")
    && update.appendStatusEvent !== false;
  const eventType = requestedEventType || (shouldAppendStatusEvent ? next.status : "");

  if (eventType) {
    nextTimeline.push(buildRequestTimelineEntry({
      eventType,
      message: update.eventMessage || update.comment,
      actor: update.actor
    }));
  }

  next.timeline = nextTimeline;
  return applyRequestWorkIdentity(next);
};

const sortRavenTitles = (titles) => [...titles].sort((left, right) => String(left.title || "").localeCompare(String(right.title || "")));
const RAVEN_TITLE_CARD_PAGE_SIZE_DEFAULT = 60;
const RAVEN_TITLE_CARD_PAGE_SIZE_MAX = 100;
const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = normalizeScalarString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};
const normalizeCardLetter = (value) => {
  const normalized = normalizeScalarString(value).toUpperCase();
  return /^[A-Z]$/.test(normalized) ? normalized : normalized === "#" ? "#" : "";
};
const resolveCardLetter = (title = "") => {
  const first = normalizeScalarString(title).trim().toUpperCase().charAt(0);
  return /^[A-Z]$/.test(first) ? first : "#";
};
const parseCardPageSize = (value) => Math.min(
  RAVEN_TITLE_CARD_PAGE_SIZE_MAX,
  Math.max(1, Number.parseInt(String(value || RAVEN_TITLE_CARD_PAGE_SIZE_DEFAULT), 10) || RAVEN_TITLE_CARD_PAGE_SIZE_DEFAULT)
);
const parseCardCursor = (value) => Math.max(0, Number.parseInt(String(value || 0), 10) || 0);
const normalizeCardSort = (value) => {
  const normalized = normalizeScalarString(value, "title").toLowerCase();
  return ["recent", "updated"].includes(normalized) ? "recent" : "title";
};
const normalizeCardIds = (value) => Array.from(new Set(
  (Array.isArray(value) ? value : String(value || "").split(","))
    .map((entry) => normalizeScalarString(entry))
    .filter(Boolean)
)).slice(0, RAVEN_TITLE_CARD_PAGE_SIZE_MAX);
const compactStringArray = (value, maxItems = 8) => {
  const seen = new Set();
  const entries = [];
  for (const item of Array.isArray(value) ? value : []) {
    const normalized = normalizeScalarString(item);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(normalized);
    if (entries.length >= maxItems) {
      break;
    }
  }
  return entries;
};
const truncateText = (value, maxLength = 280) => {
  const normalized = normalizeScalarString(value);
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...` : normalized;
};
const toRavenTitleCard = (title = {}) => ({
  id: normalizeScalarString(title.id),
  title: normalizeScalarString(title.title, "Untitled"),
  mediaType: normalizeScalarString(title.mediaType, "manga"),
  libraryTypeLabel: normalizeScalarString(title.libraryTypeLabel, normalizeScalarString(title.mediaType, "Manga")),
  libraryTypeSlug: normalizeTypeSlug(title.libraryTypeSlug || title.mediaType),
  status: normalizeScalarString(title.status, "active"),
  latestChapter: normalizeScalarString(title.latestChapter, "Unknown"),
  coverAccent: normalizeScalarString(title.coverAccent, "#4f8f88"),
  coverUrl: normalizeScalarString(title.coverUrl),
  coverThumbUrl: "",
  summary: truncateText(title.summary, 280),
  releaseLabel: normalizeScalarString(title.releaseLabel),
  chapterCount: Number.parseInt(String(title.chapterCount || 0), 10) || 0,
  chaptersDownloaded: Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0,
  author: normalizeScalarString(title.author),
  tags: compactStringArray(title.tags, 8),
  aliases: compactStringArray(title.aliases, 8),
  metadataProvider: normalizeScalarString(title.metadataProvider),
  metadataMatchedAt: toIsoTimestamp(title.metadataMatchedAt),
  updatedAt: toIsoTimestamp(title.updatedAt),
  qualityStatus: normalizeRavenQualityStatus(title.qualityStatus),
  cleanChapterCount: Math.max(0, Number.parseInt(String(title.cleanChapterCount || 0), 10) || 0),
  partialChapterCount: Math.max(0, Number.parseInt(String(title.partialChapterCount || 0), 10) || 0),
  missingContentCount: Math.max(0, Number.parseInt(String(title.missingContentCount || 0), 10) || 0),
  qualitySummary: truncateText(title.qualitySummary, 180)
});
const buildRavenTitleCardPage = (titles = [], query = {}) => {
  const q = normalizeScalarString(query.q || query.query).toLowerCase();
  const type = normalizeTypeSlug(query.type || "", "");
  const letter = normalizeCardLetter(query.letter);
  const exactIds = normalizeCardIds(query.ids);
  const pageSize = parseCardPageSize(query.pageSize);
  const cursor = parseCardCursor(query.cursor);
  const sort = normalizeCardSort(query.sort);
  const cards = (Array.isArray(titles) ? titles : []).map(toRavenTitleCard).filter((card) => {
    if (exactIds.length && !exactIds.includes(card.id)) {
      return false;
    }
    if (type && normalizeTypeSlug(card.libraryTypeSlug || card.mediaType) !== type) {
      return false;
    }
    if (q) {
      const haystack = [
        card.title,
        card.libraryTypeLabel,
        card.libraryTypeSlug,
        card.mediaType,
        card.status,
        card.author,
        ...card.tags,
        ...card.aliases
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) {
        return false;
      }
    }
    return true;
  });
  cards.sort((left, right) => {
    if (exactIds.length) {
      return exactIds.indexOf(left.id) - exactIds.indexOf(right.id);
    }
    if (sort === "recent") {
      const delta = (Date.parse(right.updatedAt || right.metadataMatchedAt || "") || 0)
        - (Date.parse(left.updatedAt || left.metadataMatchedAt || "") || 0);
      if (delta !== 0) {
        return delta;
      }
    }
    const titleCompare = normalizeScalarString(left.title).localeCompare(normalizeScalarString(right.title), "en", {
      numeric: true,
      sensitivity: "base"
    });
    return titleCompare || normalizeScalarString(left.id).localeCompare(normalizeScalarString(right.id), "en", {numeric: true});
  });
  const byLetter = {"#": 0};
  const byType = {};
  for (let index = 0; index < 26; index += 1) {
    byLetter[String.fromCharCode(65 + index)] = 0;
  }
  for (const card of cards) {
    const resolvedLetter = resolveCardLetter(card.title);
    byLetter[resolvedLetter] = (byLetter[resolvedLetter] || 0) + 1;
    const resolvedType = normalizeTypeSlug(card.libraryTypeSlug || card.mediaType);
    byType[resolvedType] = (byType[resolvedType] || 0) + 1;
  }
  const letterFiltered = letter ? cards.filter((card) => resolveCardLetter(card.title) === letter) : cards;
  const page = letterFiltered.slice(cursor, cursor + pageSize);
  const nextOffset = cursor + page.length;
  return {
    titles: page,
    counts: {total: cards.length, byLetter, byType},
    filters: {q, type, letter, ids: exactIds, pageSize, sort},
    pageInfo: {
      cursor: String(cursor),
      nextCursor: nextOffset < letterFiltered.length ? String(nextOffset) : "",
      hasMore: nextOffset < letterFiltered.length,
      pageSize,
      total: letterFiltered.length
    }
  };
};
const sortRavenChapters = (chapters) => [...chapters].sort((left, right) => {
  const leftNumber = Number.parseFloat(String(left.chapterNumber || "0"));
  const rightNumber = Number.parseFloat(String(right.chapterNumber || "0"));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }
  return String(right.chapterNumber || right.label || "").localeCompare(String(left.chapterNumber || left.label || ""));
});
const normalizeRavenQualityStatus = (value, fallback = "clean") => {
  const normalized = normalizeScalarString(value, fallback).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback;
};
const normalizeIntegerArray = (value) => Array.isArray(value)
  ? value.map((entry) => Number.parseInt(String(entry), 10)).filter((entry) => Number.isFinite(entry) && entry > 0)
  : [];
const normalizeStringArray = (value) => Array.isArray(value)
  ? value.map((entry) => normalizeScalarString(entry)).filter(Boolean)
  : [];
const normalizeRavenChapter = (chapter = {}) => ({
  id: chapter.id,
  label: chapter.label,
  chapterNumber: chapter.chapterNumber,
  pageCount: Number.parseInt(String(chapter.pageCount || 0), 10) || 0,
  releaseDate: chapter.releaseDate || null,
  available: chapter.available !== false,
  archivePath: chapter.archivePath || "",
  sourceUrl: chapter.sourceUrl || "",
  qualityStatus: normalizeRavenQualityStatus(chapter.qualityStatus),
  expectedPageCount: Math.max(0, Number.parseInt(String(chapter.expectedPageCount || chapter.pageCount || 0), 10) || 0),
  missingPageCount: Math.max(0, Number.parseInt(String(chapter.missingPageCount || 0), 10) || 0),
  missingPages: normalizeIntegerArray(chapter.missingPages),
  qualityNotes: normalizeStringArray(chapter.qualityNotes),
  updatedAt: toIsoTimestamp(chapter.updatedAt || chapter.updated_at)
});
const normalizeRavenTitle = (title, chapters = []) => ({
  id: title.id,
  title: title.title,
  mediaType: title.mediaType || "manga",
  libraryTypeLabel: title.libraryTypeLabel || title.mediaType || "manga",
  libraryTypeSlug: title.libraryTypeSlug || title.mediaType || "manga",
  status: title.status || "active",
  latestChapter: title.latestChapter || "",
  coverAccent: title.coverAccent || "#4f8f88",
  summary: title.summary || "",
  releaseLabel: title.releaseLabel || "",
  chapterCount: Number.parseInt(String(title.chapterCount || 0), 10) || 0,
  chaptersDownloaded: Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0,
  author: title.author || "",
  tags: Array.isArray(title.tags) ? title.tags : [],
  aliases: Array.isArray(title.aliases) ? title.aliases : [],
  metadataProvider: title.metadataProvider || "",
  metadataMatchedAt: toIsoTimestamp(title.metadataMatchedAt),
  relations: Array.isArray(title.relations) ? title.relations : [],
  sourceUrl: title.sourceUrl || "",
  coverUrl: title.coverUrl || "",
  workingRoot: title.workingRoot || "",
  downloadRoot: title.downloadRoot || "",
  qualityStatus: normalizeRavenQualityStatus(title.qualityStatus),
  cleanChapterCount: Math.max(0, Number.parseInt(String(title.cleanChapterCount || 0), 10) || 0),
  partialChapterCount: Math.max(0, Number.parseInt(String(title.partialChapterCount || 0), 10) || 0),
  missingContentCount: Math.max(0, Number.parseInt(String(title.missingContentCount || 0), 10) || 0),
  qualitySummary: title.qualitySummary || "",
  updatedAt: toIsoTimestamp(title.updatedAt || title.updated_at),
  chapters: sortRavenChapters(chapters.map(normalizeRavenChapter))
});

const sortVaultJobs = (jobs) => [...jobs].sort((left, right) =>
  String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || ""))
);
const sortVaultJobTasks = (tasks) => [...tasks].sort((left, right) => {
  const leftOrder = Number.parseInt(String(left.sortOrder || 0), 10) || 0;
  const rightOrder = Number.parseInt(String(right.sortOrder || 0), 10) || 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return String(left.updatedAt || left.createdAt || "").localeCompare(String(right.updatedAt || right.createdAt || ""));
});
const normalizeVaultJob = (job = {}) => ({
  jobId: String(job.jobId || randomUUID()),
  kind: String(job.kind || "generic"),
  ownerService: String(job.ownerService || "scriptarr"),
  status: String(job.status || "queued"),
  label: String(job.label || ""),
  requestedBy: String(job.requestedBy || ""),
  payload: job.payload && typeof job.payload === "object" ? job.payload : {},
  result: job.result && typeof job.result === "object" ? job.result : {},
  createdAt: String(job.createdAt || nowIso()),
  startedAt: job.startedAt || null,
  finishedAt: job.finishedAt || null,
  updatedAt: String(job.updatedAt || nowIso())
});
const normalizeVaultJobTask = (jobId, task = {}) => ({
  taskId: String(task.taskId || randomUUID()),
  jobId: String(jobId),
  taskKey: String(task.taskKey || ""),
  label: String(task.label || task.taskKey || ""),
  status: String(task.status || "queued"),
  message: String(task.message || ""),
  percent: Number.parseInt(String(task.percent || 0), 10) || 0,
  sortOrder: Number.parseInt(String(task.sortOrder || 0), 10) || 0,
  payload: task.payload && typeof task.payload === "object" ? task.payload : {},
  result: task.result && typeof task.result === "object" ? task.result : {},
  createdAt: String(task.createdAt || nowIso()),
  startedAt: task.startedAt || null,
  finishedAt: task.finishedAt || null,
  updatedAt: String(task.updatedAt || nowIso())
});
const buildRequestFromPayload = (payload, requestId) => {
  const status = normalizeRequestStatus(payload.status, payload.selectedDownload || payload.details?.selectedDownload ? "pending" : "unavailable");
  return applyRequestWorkIdentity({
    id: requestId,
    source: normalizeString(payload.source, "moon"),
    title: normalizeString(payload.title, "Untitled request"),
    requestType: normalizeString(payload.requestType, "manga"),
    notes: normalizeString(payload.notes),
    requestedBy: normalizeString(payload.requestedBy),
    status,
    moderatorComment: normalizeString(payload.moderatorComment),
    details: normalizeRequestDetails(payload.details ?? {
      query: payload.query,
      selectedMetadata: payload.selectedMetadata,
      selectedDownload: payload.selectedDownload,
      availability: payload.availability,
      jobId: payload.jobId,
      taskId: payload.taskId
    }),
    revision: 1,
    timeline: buildInitialRequestTimeline({
      requestedBy: payload.requestedBy,
      status
    }),
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
};

const createConflictError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const createMemoryStore = () => {
  const state = {
    users: new Map(),
    permissionGroups: new Map(),
    userGroupAssignments: new Map(),
    apiKeys: new Map(),
    sessions: new Map(),
    settings: new Map(),
    secrets: new Map(),
    requests: new Map(),
    requestWorkLocks: new Map(),
    progress: new Map(),
    titleReadStates: new Map(),
    chapterReadStates: new Map(),
    ravenTitles: new Map(),
    ravenChapters: new Map(),
    ravenDownloadTasks: new Map(),
    ravenMetadataMatches: new Map(),
    jobs: new Map(),
    jobTasks: new Map(),
    events: new Map(),
    requestSeq: 1,
    eventSeq: 1
  };

  const readMemoryGroups = () => ensureSingleDefaultGroup(Array.from(state.permissionGroups.values()));
  const persistMemoryGroups = (groups) => {
    state.permissionGroups.clear();
    for (const group of ensureSingleDefaultGroup(groups)) {
      state.permissionGroups.set(group.id, group);
    }
  };
  const seedMemoryGroups = () => {
    persistMemoryGroups(ensureSeedPermissionGroups(Array.from(state.permissionGroups.values()), nowIso));
  };
  const getMemoryGroupIdsForUser = (discordUserId) => Array.from(state.userGroupAssignments.get(discordUserId) || []);
  const getMemoryGroupsForUser = (discordUserId) => getMemoryGroupIdsForUser(discordUserId)
    .map((groupId) => state.permissionGroups.get(groupId))
    .filter(Boolean);
  const refreshMemoryUserAccess = (discordUserId) => {
    const existing = state.users.get(discordUserId);
    if (!existing) {
      return null;
    }
    const next = buildEffectiveUserAccess(existing, existing.role === "owner" ? [] : getMemoryGroupsForUser(discordUserId));
    state.users.set(discordUserId, next);
    return next;
  };
  const refreshUsersForGroupIds = (groupIds = []) => {
    const affected = new Set();
    for (const [discordUserId, assignments] of state.userGroupAssignments.entries()) {
      if (Array.from(assignments).some((groupId) => groupIds.includes(groupId))) {
        affected.add(discordUserId);
      }
    }
    for (const discordUserId of affected) {
      refreshMemoryUserAccess(discordUserId);
    }
  };
  const ensureDefaultGroupAssignment = (discordUserId) => {
    const existing = state.userGroupAssignments.get(discordUserId);
    if (existing?.size) {
      return;
    }
    const defaultGroupId = getDefaultGroupId(readMemoryGroups());
    if (!defaultGroupId) {
      return;
    }
    state.userGroupAssignments.set(discordUserId, new Set([defaultGroupId]));
  };
  const clearMemorySessionsForUser = (discordUserId) => {
    for (const [token, session] of state.sessions.entries()) {
      if (session.discordUserId === discordUserId) {
        state.sessions.delete(token);
      }
    }
  };
  const getMemoryTitleState = (discordUserId, mediaId) => state.titleReadStates.get(readStateKey(discordUserId, mediaId)) || null;
  const setMemoryTitleState = (payload) => {
    const normalized = toTitleReadState(payload);
    state.titleReadStates.set(readStateKey(normalized.discordUserId, normalized.mediaId), normalized);
    return normalized;
  };
  const getMemoryChapterReads = (discordUserId, mediaId = "") => {
    const keyPrefix = mediaId ? `${readStateKey(discordUserId, mediaId)}::` : `${normalizeString(discordUserId)}::`;
    return Array.from(state.chapterReadStates.entries())
      .filter(([key]) => key.startsWith(keyPrefix))
      .map(([, value]) => value);
  };
  const setMemoryChapterRead = (payload) => {
    const normalized = toChapterReadState(payload);
    state.chapterReadStates.set(
      `${readStateKey(normalized.discordUserId, normalized.mediaId)}::${normalized.chapterId}`,
      normalized
    );
    return normalized;
  };
  const clearMemoryChapterReadsForTitle = (discordUserId, mediaId) => {
    const prefix = `${readStateKey(discordUserId, mediaId)}::`;
    let removed = 0;
    for (const key of Array.from(state.chapterReadStates.keys())) {
      if (key.startsWith(prefix)) {
        state.chapterReadStates.delete(key);
        removed += 1;
      }
    }
    return removed;
  };
  const clearMemoryContentReset = () => {
    const preview = {
      requests: state.requests.size,
      requestWorkLocks: state.requestWorkLocks.size,
      progress: state.progress.size,
      titleReadStates: state.titleReadStates.size,
      chapterReadStates: state.chapterReadStates.size,
      followingSettings: Array.from(state.settings.keys()).filter((key) => key.startsWith("moon.following.")).length,
      bookmarkSettings: Array.from(state.settings.keys()).filter((key) => key.startsWith("moon.reader.bookmarks.")).length,
      ravenTitles: state.ravenTitles.size,
      ravenChapters: Array.from(state.ravenChapters.values()).reduce((sum, entries) => sum + entries.size, 0),
      ravenMetadataMatches: state.ravenMetadataMatches.size,
      ravenDownloadTasks: state.ravenDownloadTasks.size,
      ravenJobs: Array.from(state.jobs.values()).filter((job) => job.ownerService === "scriptarr-raven").length,
      ravenJobTasks: Array.from(state.jobTasks.values()).filter((task) => {
        const job = state.jobs.get(task.jobId);
        return job?.ownerService === "scriptarr-raven";
      }).length
    };
    state.requests.clear();
    state.requestWorkLocks.clear();
    state.progress.clear();
    state.titleReadStates.clear();
    state.chapterReadStates.clear();
    for (const key of Array.from(state.settings.keys())) {
      if (CONTENT_RESET_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        state.settings.delete(key);
      }
    }
    state.ravenTitles.clear();
    state.ravenChapters.clear();
    state.ravenMetadataMatches.clear();
    state.ravenDownloadTasks.clear();
    const ravenJobIds = Array.from(state.jobs.values())
      .filter((job) => job.ownerService === "scriptarr-raven")
      .map((job) => job.jobId);
    for (const jobId of ravenJobIds) {
      state.jobs.delete(jobId);
    }
    for (const [taskId, task] of Array.from(state.jobTasks.entries())) {
      if (ravenJobIds.includes(task.jobId)) {
        state.jobTasks.delete(taskId);
      }
    }
    return preview;
  };
  const listMemoryEvents = (filters = {}) => {
    const normalized = normalizeEventFilters(filters);
    const query = normalized.query.toLowerCase();
    const sinceTime = normalized.since ? Date.parse(normalized.since) : Number.NaN;
    const untilTime = normalized.until ? Date.parse(normalized.until) : Number.NaN;
    const filtered = Array.from(state.events.values()).filter((event) => {
      const createdTime = Date.parse(event.createdAt || "");
      const matchesQuery = !query || [
        event.message,
        event.domain,
        event.eventType,
        event.actorLabel,
        event.actorId,
        event.targetType,
        event.targetId
      ].some((value) => normalizeScalarString(value).toLowerCase().includes(query));
      return (!normalized.domains.length || normalized.domains.includes(event.domain))
        && (!normalized.eventTypes.length || normalized.eventTypes.includes(event.eventType))
        && (!normalized.severities.length || normalized.severities.includes(event.severity))
        && (!normalized.actorType || event.actorType === normalized.actorType)
        && (!normalized.actorId || event.actorId === normalized.actorId)
        && (!normalized.targetType || event.targetType === normalized.targetType)
        && (!normalized.targetId || event.targetId === normalized.targetId)
        && (!normalized.afterSequence || Number(event.sequence || 0) > normalized.afterSequence)
        && (Number.isNaN(sinceTime) || (!Number.isNaN(createdTime) && createdTime >= sinceTime))
        && (Number.isNaN(untilTime) || (!Number.isNaN(createdTime) && createdTime <= untilTime))
        && matchesQuery;
    });
    filtered.sort((left, right) => normalized.newestFirst
      ? Number(right.sequence || 0) - Number(left.sequence || 0)
      : Number(left.sequence || 0) - Number(right.sequence || 0));
    return filtered.slice(0, normalized.limit);
  };

  return {
    driver: "memory",
    async init() {
      seedMemoryGroups();
      return true;
    },
    async health() {
      return {ready: true, degraded: true, reason: "Running with the in-memory development store."};
    },
    async getBootstrapStatus(superuserId) {
      const owner = Array.from(state.users.values()).find((user) => user.role === "owner");
      return {
        ownerClaimed: Boolean(owner),
        superuserIdConfigured: Boolean(superuserId),
        superuserId,
        ownerDiscordUserId: owner?.discordUserId || null
      };
    },
    async upsertDiscordUser({discordUserId, username, avatarUrl, role, permissions, claimOwner = false}) {
      const owner = Array.from(state.users.values()).find((user) => user.role === "owner");
      if (claimOwner && owner && owner.discordUserId !== discordUserId) {
        const error = new Error("Owner already claimed.");
        error.code = "OWNER_ALREADY_CLAIMED";
        throw error;
      }
      const existing = state.users.get(discordUserId);
      const nextRole = role || existing?.role || (claimOwner ? "owner" : "member");
      const next = {
        id: discordUserId,
        discordUserId,
        username,
        avatarUrl: avatarUrl || null,
        role: nextRole,
        permissions: Array.isArray(permissions) ? permissions : existing?.permissions || deriveLegacyPermissions({
          role: nextRole,
          isOwner: nextRole === "owner"
        }),
        createdAt: existing?.createdAt || nowIso(),
        updatedAt: nowIso()
      };
      state.users.set(discordUserId, next);
      if (nextRole !== "owner") {
        ensureDefaultGroupAssignment(discordUserId);
      }
      return refreshMemoryUserAccess(discordUserId);
    },
    async getUserByDiscordId(discordUserId) {
      const user = state.users.get(discordUserId);
      return user ? refreshMemoryUserAccess(discordUserId) : null;
    },
    async listUsers() {
      return Array.from(state.users.keys())
        .map((discordUserId) => refreshMemoryUserAccess(discordUserId))
        .filter(Boolean)
        .sort((left, right) => left.username.localeCompare(right.username));
    },
    async listPermissionGroups() {
      return readMemoryGroups();
    },
    async getPermissionGroup(groupId) {
      return state.permissionGroups.get(normalizeString(groupId)) || null;
    },
    async createPermissionGroup(payload) {
      const group = normalizePermissionGroup({
        ...payload,
        id: payload?.id || payload?.name,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      if (state.permissionGroups.has(group.id)) {
        throw createConflictError("Permission group already exists.", "PERMISSION_GROUP_CONFLICT");
      }
      persistMemoryGroups([...readMemoryGroups(), group]);
      return state.permissionGroups.get(group.id) || group;
    },
    async updatePermissionGroup(groupId, payload) {
      const existing = state.permissionGroups.get(normalizeString(groupId));
      if (!existing) {
        return null;
      }
      const next = normalizePermissionGroup({
        ...existing,
        ...payload,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: nowIso()
      }, existing);
      persistMemoryGroups(readMemoryGroups().map((group) => group.id === existing.id ? next : group));
      refreshUsersForGroupIds([existing.id]);
      return state.permissionGroups.get(existing.id) || next;
    },
    async deletePermissionGroup(groupId) {
      const existing = state.permissionGroups.get(normalizeString(groupId));
      if (!existing) {
        return null;
      }
      if (existing.isDefault) {
        throw createConflictError("Choose a new default group before deleting the current default.", "DEFAULT_GROUP_REQUIRED");
      }
      const affectedUserIds = Array.from(state.userGroupAssignments.entries())
        .filter(([, assignments]) => assignments.has(existing.id))
        .map(([discordUserId]) => discordUserId);
      state.permissionGroups.delete(existing.id);
      for (const assignments of state.userGroupAssignments.values()) {
        assignments.delete(existing.id);
      }
      affectedUserIds.forEach((discordUserId) => refreshMemoryUserAccess(discordUserId));
      return existing;
    },
    async assignUserGroups(discordUserId, groupIds = []) {
      const user = state.users.get(discordUserId);
      if (!user) {
        return null;
      }
      if (user.role === "owner") {
        throw createConflictError("The protected owner cannot be reassigned.", "PROTECTED_OWNER");
      }
      const validGroupIds = Array.from(new Set((Array.isArray(groupIds) ? groupIds : [])
        .map((groupId) => normalizeString(groupId))
        .filter((groupId) => state.permissionGroups.has(groupId))));
      state.userGroupAssignments.set(discordUserId, new Set(validGroupIds));
      return refreshMemoryUserAccess(discordUserId);
    },
    async deleteUser(discordUserId) {
      const existing = state.users.get(discordUserId);
      if (!existing) {
        return null;
      }
      if (existing.role === "owner") {
        throw createConflictError("The protected owner cannot be deleted.", "PROTECTED_OWNER");
      }
      clearMemorySessionsForUser(discordUserId);
      state.userGroupAssignments.delete(discordUserId);
      state.users.delete(discordUserId);
      return existing;
    },
    async getAccessOverview() {
      const groups = readMemoryGroups();
      return {
        users: await this.listUsers(),
        groups,
        defaultGroupId: getDefaultGroupId(groups)
      };
    },
    async createApiKey(payload = {}) {
      const entry = normalizeApiKeyRecord({
        ...payload,
        id: payload.id || `ak_${randomUUID()}`,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      validateApiKeyCreate(entry);
      if (Array.from(state.apiKeys.values()).some((key) => key.keyHash === entry.keyHash)) {
        throw createConflictError("API key already exists.", "API_KEY_CONFLICT");
      }
      state.apiKeys.set(entry.id, entry);
      return entry;
    },
    async listApiKeys(filters = {}) {
      const kind = normalizeString(filters.kind).toLowerCase();
      const ownerDiscordUserId = normalizeString(filters.ownerDiscordUserId);
      const includeRevoked = filters.includeRevoked !== false;
      return Array.from(state.apiKeys.values())
        .filter((entry) => (!kind || entry.kind === kind)
          && (!ownerDiscordUserId || entry.ownerDiscordUserId === ownerDiscordUserId)
          && (includeRevoked || !entry.revokedAt))
        .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
    },
    async getApiKey(apiKeyId) {
      return state.apiKeys.get(normalizeString(apiKeyId)) || null;
    },
    async updateApiKey(apiKeyId, payload = {}) {
      const existing = await this.getApiKey(apiKeyId);
      if (!existing) {
        return null;
      }
      const next = normalizeApiKeyRecord({
        ...existing,
        name: payload.name ?? existing.name,
        enabled: payload.enabled ?? existing.enabled,
        groupIds: Array.isArray(payload.groupIds) ? payload.groupIds : existing.groupIds,
        updatedAt: nowIso()
      }, existing);
      state.apiKeys.set(existing.id, next);
      return next;
    },
    async revokeApiKey(apiKeyId) {
      const existing = await this.getApiKey(apiKeyId);
      if (!existing) {
        return null;
      }
      const next = normalizeApiKeyRecord({
        ...existing,
        enabled: false,
        revokedAt: existing.revokedAt || nowIso(),
        updatedAt: nowIso()
      }, existing);
      state.apiKeys.set(existing.id, next);
      return next;
    },
    async resolveApiKey(keyHash) {
      const normalizedHash = normalizeString(keyHash);
      if (!normalizedHash) {
        return null;
      }
      const existing = Array.from(state.apiKeys.values()).find((entry) =>
        entry.keyHash === normalizedHash && entry.enabled && !entry.revokedAt
      );
      if (!existing) {
        return null;
      }
      const next = normalizeApiKeyRecord({
        ...existing,
        lastUsedAt: nowIso(),
        updatedAt: nowIso()
      }, existing);
      state.apiKeys.set(existing.id, next);
      return next;
    },
    async createSession({discordUserId}) {
      const token = randomToken("sess");
      const session = {
        token,
        discordUserId,
        createdAt: nowIso()
      };
      state.sessions.set(token, session);
      return session;
    },
    async clearSession(token) {
      const session = state.sessions.get(token) || null;
      if (session) {
        state.sessions.delete(token);
      }
      return session;
    },
    async clearSessionsForUser(discordUserId) {
      clearMemorySessionsForUser(discordUserId);
      return {ok: true};
    },
    async getSession(token) {
      return state.sessions.get(token) || null;
    },
    async getUserForSession(token) {
      const session = await this.getSession(token);
      if (!session) {
        return null;
      }
      return this.getUserByDiscordId(session.discordUserId);
    },
    async setSetting(key, value) {
      state.settings.set(key, {key, value, updatedAt: nowIso()});
      return state.settings.get(key);
    },
    async getSetting(key) {
      return state.settings.get(key) || null;
    },
    async getDatabaseOverview() {
      return buildMemoryDatabaseOverview(state);
    },
    async getDatabaseTable(tableName, options = {}) {
      return readMemoryDatabaseTable(state, tableName, options);
    },
    async updateDatabaseSetting(key, value) {
      const normalized = normalizeDatabaseSettingUpdate(key, value);
      return this.setSetting(normalized.key, normalized.value);
    },
    async setSecret(key, value) {
      state.secrets.set(key, {key, value, updatedAt: nowIso()});
      return state.secrets.get(key);
    },
    async getSecret(key) {
      return state.secrets.get(key) || null;
    },
    async appendEvent(payload) {
      const event = normalizeVaultEvent({
        ...payload,
        sequence: state.eventSeq++
      }, nowIso);
      state.events.set(event.sequence, event);
      return event;
    },
    async listEvents(filters = {}) {
      return listMemoryEvents(filters);
    },
    async pruneEvents(retentionDays = DEFAULT_EVENT_RETENTION_DAYS) {
      const cutoff = Date.now() - (Number(retentionDays) * 24 * 60 * 60 * 1000);
      let removed = 0;
      for (const [sequence, event] of state.events.entries()) {
        const timestamp = Date.parse(event.createdAt || "");
        if (Number.isFinite(timestamp) && timestamp < cutoff) {
          state.events.delete(sequence);
          removed += 1;
        }
      }
      return {removed};
    },
    async listRequests() {
      return Array.from(state.requests.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getRequest(id) {
      return state.requests.get(Number(id)) || null;
    },
    async createRequest(payload) {
      const id = state.requestSeq++;
      const request = buildRequestFromPayload(payload, id);
      if (requestStatusUsesWorkLock(request.status) && request.workKeyHash) {
        const existingLock = state.requestWorkLocks.get(request.workKeyHash);
        if (existingLock && existingLock.requestId !== id) {
          throw buildRequestWorkConflict(existingLock.requestId, request);
        }
      }
      state.requests.set(id, request);
      if (requestStatusUsesWorkLock(request.status) && request.workKeyHash) {
        state.requestWorkLocks.set(request.workKeyHash, {
          requestId: id,
          workKey: request.workKey
        });
      }
      return request;
    },
    async updateRequest(id, update) {
      const existing = state.requests.get(Number(id));
      if (!existing) {
        return null;
      }
      const expectedRevision = update.expectedRevision ?? update.revision;
      if (expectedRevision != null && Number(expectedRevision) !== Number(existing.revision || 1)) {
        throw createConflictError("Request revision conflict.", "REQUEST_REVISION_CONFLICT");
      }
      const next = applyRequestUpdate(existing, update);
      if (requestStatusUsesWorkLock(next.status) && next.workKeyHash) {
        const existingLock = state.requestWorkLocks.get(next.workKeyHash);
        if (existingLock && existingLock.requestId !== Number(id)) {
          throw buildRequestWorkConflict(existingLock.requestId, next);
        }
      }

      if (requestStatusUsesWorkLock(existing.status) && existing.workKeyHash && existing.workKeyHash !== next.workKeyHash) {
        const existingLock = state.requestWorkLocks.get(existing.workKeyHash);
        if (existingLock?.requestId === Number(id)) {
          state.requestWorkLocks.delete(existing.workKeyHash);
        }
      }
      if (requestStatusUsesWorkLock(existing.status) && existing.workKeyHash && !requestStatusUsesWorkLock(next.status)) {
        const existingLock = state.requestWorkLocks.get(existing.workKeyHash);
        if (existingLock?.requestId === Number(id)) {
          state.requestWorkLocks.delete(existing.workKeyHash);
        }
      }

      state.requests.set(Number(id), next);
      if (requestStatusUsesWorkLock(next.status) && next.workKeyHash) {
        state.requestWorkLocks.set(next.workKeyHash, {
          requestId: Number(id),
          workKey: next.workKey
        });
      }
      return next;
    },
    async reviewRequest(id, review) {
      return this.updateRequest(id, {
        status: review.status,
        moderatorComment: review.comment || "",
        comment: review.comment,
        actor: review.actor,
        expectedRevision: review.expectedRevision ?? review.revision
      });
    },
    async upsertProgress(entry) {
      state.progress.set(readStateKey(entry.discordUserId, entry.mediaId), {
        ...entry,
        updatedAt: nowIso()
      });
      return state.progress.get(readStateKey(entry.discordUserId, entry.mediaId));
    },
    async getProgressByUser(discordUserId) {
      return Array.from(state.progress.values()).filter((entry) => entry.discordUserId === discordUserId);
    },
    async deleteProgress(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      const removed = state.progress.get(readStateKey(normalizedUserId, normalizedMediaId)) || null;
      state.progress.delete(readStateKey(normalizedUserId, normalizedMediaId));
      return {
        removed: Boolean(removed),
        progress: removed
      };
    },
    async getReadStateByUser(discordUserId, mediaId = "") {
      const normalizedUserId = normalizeString(discordUserId);
      const normalizedMediaId = normalizeString(mediaId);
      const titleStates = normalizedMediaId
        ? [getMemoryTitleState(normalizedUserId, normalizedMediaId)].filter(Boolean)
        : Array.from(state.titleReadStates.values()).filter((entry) => entry.discordUserId === normalizedUserId);
      const chapterReads = getMemoryChapterReads(normalizedUserId, normalizedMediaId);
      return {
        titleStates,
        chapterReads
      };
    },
    async markTitleRead(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      const chapterIds = Array.from(new Set((Array.isArray(payload.chapterIds) ? payload.chapterIds : [])
        .map((chapterId) => normalizeString(chapterId))
        .filter(Boolean)));
      for (const chapterId of chapterIds) {
        setMemoryChapterRead({
          mediaId: normalizedMediaId,
          chapterId,
          discordUserId: normalizedUserId,
          readAt: payload.completedAt || nowIso(),
          updatedAt: nowIso()
        });
      }
      const titleState = setMemoryTitleState({
        mediaId: normalizedMediaId,
        discordUserId: normalizedUserId,
        startedAt: payload.startedAt || nowIso(),
        completedAt: payload.completedAt || nowIso(),
        updatedAt: nowIso()
      });
      return {
        titleState,
        chapterReads: getMemoryChapterReads(normalizedUserId, normalizedMediaId)
      };
    },
    async markTitleUnread(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      clearMemoryChapterReadsForTitle(normalizedUserId, normalizedMediaId);
      state.titleReadStates.delete(readStateKey(normalizedUserId, normalizedMediaId));
      state.progress.delete(readStateKey(normalizedUserId, normalizedMediaId));
      return {
        titleState: null,
        titleStates: [],
        chapterReads: []
      };
    },
    async markChapterRead(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      const chapterRead = setMemoryChapterRead({
        mediaId: normalizedMediaId,
        chapterId: payload.chapterId,
        discordUserId: normalizedUserId,
        readAt: payload.readAt || nowIso(),
        updatedAt: nowIso()
      });
      const existing = getMemoryTitleState(normalizedUserId, normalizedMediaId);
      const titleState = setMemoryTitleState({
        mediaId: normalizedMediaId,
        discordUserId: normalizedUserId,
        startedAt: existing?.startedAt || payload.startedAt || nowIso(),
        completedAt: payload.completedAt ?? existing?.completedAt ?? null,
        updatedAt: nowIso()
      });
      return {
        titleState,
        chapterRead
      };
    },
    async markChapterUnread(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      state.chapterReadStates.delete(`${readStateKey(normalizedUserId, normalizedMediaId)}::${normalizeString(payload.chapterId)}`);
      const existing = getMemoryTitleState(normalizedUserId, normalizedMediaId);
      const titleState = setMemoryTitleState({
        mediaId: normalizedMediaId,
        discordUserId: normalizedUserId,
        startedAt: existing?.startedAt || payload.startedAt || nowIso(),
        completedAt: payload.completedAt ?? null,
        updatedAt: nowIso()
      });
      return {
        titleState,
        chapterReads: getMemoryChapterReads(normalizedUserId, normalizedMediaId)
      };
    },
    async previewContentReset() {
      return {
        driver: "memory",
        counts: {
          requests: state.requests.size,
          requestWorkLocks: state.requestWorkLocks.size,
          progress: state.progress.size,
          titleReadStates: state.titleReadStates.size,
          chapterReadStates: state.chapterReadStates.size,
          followingSettings: Array.from(state.settings.keys()).filter((key) => key.startsWith("moon.following.")).length,
          bookmarkSettings: Array.from(state.settings.keys()).filter((key) => key.startsWith("moon.reader.bookmarks.")).length,
          ravenTitles: state.ravenTitles.size,
          ravenChapters: Array.from(state.ravenChapters.values()).reduce((sum, entries) => sum + entries.size, 0),
          ravenMetadataMatches: state.ravenMetadataMatches.size,
          ravenDownloadTasks: state.ravenDownloadTasks.size,
          ravenJobs: Array.from(state.jobs.values()).filter((job) => job.ownerService === "scriptarr-raven").length,
          ravenJobTasks: Array.from(state.jobTasks.values()).filter((task) => {
            const job = state.jobs.get(task.jobId);
            return job?.ownerService === "scriptarr-raven";
          }).length
        }
      };
    },
    async executeContentReset() {
      return {
        driver: "memory",
        counts: clearMemoryContentReset()
      };
    },
    async listRavenTitles() {
      return sortRavenTitles(Array.from(state.ravenTitles.values()).map((title) =>
        normalizeRavenTitle(title, Array.from((state.ravenChapters.get(title.id) || new Map()).values()))
      ));
    },
    async listRavenTitleCards(query = {}) {
      return buildRavenTitleCardPage(Array.from(state.ravenTitles.values()), query);
    },
    async getRavenTitle(titleId) {
      const title = state.ravenTitles.get(titleId);
      if (!title) {
        return null;
      }
      return normalizeRavenTitle(title, Array.from((state.ravenChapters.get(titleId) || new Map()).values()));
    },
    async upsertRavenTitle(title) {
      const existing = state.ravenTitles.get(title.id) || {};
      state.ravenTitles.set(title.id, {
        ...existing,
        ...normalizeRavenTitle(title, existing.chapters || []),
        updatedAt: nowIso()
      });
      return this.getRavenTitle(title.id);
    },
    async replaceRavenChapters(titleId, chapters) {
      state.ravenChapters.set(titleId, new Map(sortRavenChapters(chapters).map((chapter) => [chapter.id, {
        ...normalizeRavenChapter(chapter),
        updatedAt: nowIso()
      }])));
      return Array.from(state.ravenChapters.get(titleId).values());
    },
    async listRavenDownloadTasks() {
      return Array.from(state.ravenDownloadTasks.values()).sort((left, right) =>
        String(right.queuedAt || right.updatedAt || "").localeCompare(String(left.queuedAt || left.updatedAt || ""))
      );
    },
    async upsertRavenDownloadTask(task) {
      state.ravenDownloadTasks.set(task.taskId, {
        ...(state.ravenDownloadTasks.get(task.taskId) || {}),
        ...task,
        updatedAt: nowIso()
      });
      return state.ravenDownloadTasks.get(task.taskId);
    },
    async deleteRavenDownloadTask(taskId) {
      const existed = state.ravenDownloadTasks.delete(taskId);
      return {removed: existed ? 1 : 0};
    },
    async getRavenMetadataMatch(titleId) {
      return state.ravenMetadataMatches.get(titleId) || null;
    },
    async setRavenMetadataMatch(titleId, value) {
      const entry = {
        titleId,
        ...value,
        updatedAt: nowIso()
      };
      state.ravenMetadataMatches.set(titleId, entry);
      return entry;
    },
    async listJobs(filters = {}) {
      return sortVaultJobs(Array.from(state.jobs.values()).filter((job) =>
        (!filters.ownerService || job.ownerService === filters.ownerService)
        && (!filters.kind || job.kind === filters.kind)
        && (!filters.status || job.status === filters.status)
      ));
    },
    async getJob(jobId) {
      return state.jobs.get(jobId) || null;
    },
    async upsertJob(job) {
      const normalized = normalizeVaultJob({
        ...(state.jobs.get(job.jobId) || {}),
        ...job,
        updatedAt: nowIso()
      });
      state.jobs.set(normalized.jobId, normalized);
      return normalized;
    },
    async listJobTasks(filters = {}) {
      return sortVaultJobTasks(Array.from(state.jobTasks.values()).filter((task) =>
        (!filters.jobId || task.jobId === filters.jobId)
        && (!filters.status || task.status === filters.status)
      ));
    },
    async upsertJobTask(jobId, task) {
      const normalized = normalizeVaultJobTask(jobId, {
        ...(state.jobTasks.get(task.taskId) || {}),
        ...task,
        updatedAt: nowIso()
      });
      state.jobTasks.set(normalized.taskId, normalized);
      return normalized;
    }
  };
};

const createMysqlStore = (config) => {
  const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    connectionLimit: 5
  });

  const init = async () => {
    const ignoreKnownAlterError = async (sql) => {
      try {
        await pool.query(sql);
      } catch (error) {
        const message = String(error?.message || "");
        if (
          message.includes("Duplicate column name")
          || message.includes("Duplicate key name")
          || message.includes("already exists")
        ) {
          return;
        }
        throw error;
      }
    };

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        discord_user_id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        avatar_url TEXT NULL,
        role_name VARCHAR(32) NOT NULL,
        permissions_json JSON NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permission_groups (
        group_id VARCHAR(64) PRIMARY KEY,
        group_name VARCHAR(255) NOT NULL,
        description_text TEXT NULL,
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        permissions_json JSON NOT NULL,
        admin_grants_json JSON NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_permission_groups (
        discord_user_id VARCHAR(64) NOT NULL,
        group_id VARCHAR(64) NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (discord_user_id, group_id),
        INDEX idx_user_permission_groups_group (group_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        api_key_id VARCHAR(96) PRIMARY KEY,
        key_name VARCHAR(255) NOT NULL,
        key_kind VARCHAR(16) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        key_hash CHAR(64) NOT NULL,
        key_prefix VARCHAR(32) NOT NULL,
        owner_discord_user_id VARCHAR(64) NULL,
        created_by_json JSON NOT NULL,
        group_ids_json JSON NOT NULL,
        last_used_at DATETIME NULL,
        revoked_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY idx_api_keys_hash (key_hash),
        INDEX idx_api_keys_kind_owner (key_kind, owner_discord_user_id),
        INDEX idx_api_keys_revoked (revoked_at)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token VARCHAR(128) PRIMARY KEY,
        discord_user_id VARCHAR(64) NOT NULL,
        created_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_key VARCHAR(128) PRIMARY KEY,
        setting_value JSON NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        source VARCHAR(32) NOT NULL,
        title VARCHAR(255) NOT NULL,
        request_type VARCHAR(32) NOT NULL,
        notes TEXT NULL,
        requested_by VARCHAR(64) NOT NULL,
        status_name VARCHAR(32) NOT NULL,
        moderator_comment TEXT NULL,
        request_details_json JSON NULL,
        request_work_key TEXT NULL,
        request_work_key_hash CHAR(64) NULL,
        timeline_json JSON NOT NULL,
        revision_number INT NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS request_work_locks (
        request_work_key_hash CHAR(64) PRIMARY KEY,
        request_work_key TEXT NOT NULL,
        request_id BIGINT NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS media_progress (
        media_id VARCHAR(128) NOT NULL,
        discord_user_id VARCHAR(64) NOT NULL,
        chapter_label VARCHAR(128) NOT NULL,
        position_ratio DOUBLE NOT NULL,
        bookmark_json JSON NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (media_id, discord_user_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS media_title_state (
        media_id VARCHAR(128) NOT NULL,
        discord_user_id VARCHAR(64) NOT NULL,
        started_at DATETIME NULL,
        completed_at DATETIME NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (media_id, discord_user_id),
        INDEX idx_media_title_state_user (discord_user_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS media_chapter_reads (
        media_id VARCHAR(128) NOT NULL,
        chapter_id VARCHAR(191) NOT NULL,
        discord_user_id VARCHAR(64) NOT NULL,
        read_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (media_id, chapter_id, discord_user_id),
        INDEX idx_media_chapter_reads_user_media (discord_user_id, media_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS secrets (
        secret_key VARCHAR(128) PRIMARY KEY,
        secret_value JSON NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS raven_titles (
        title_id VARCHAR(191) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        media_type VARCHAR(64) NOT NULL,
        library_type_label VARCHAR(255) NULL,
        library_type_slug VARCHAR(191) NULL,
        status_name VARCHAR(64) NOT NULL,
        latest_chapter VARCHAR(64) NULL,
        cover_accent VARCHAR(32) NULL,
        summary TEXT NULL,
        release_label VARCHAR(64) NULL,
        chapter_count INT NOT NULL DEFAULT 0,
        chapters_downloaded INT NOT NULL DEFAULT 0,
        author_name VARCHAR(255) NULL,
        tags_json JSON NOT NULL,
        aliases_json JSON NOT NULL,
        relations_json JSON NOT NULL,
        metadata_provider VARCHAR(64) NULL,
        metadata_matched_at DATETIME NULL,
        source_url TEXT NULL,
        cover_url TEXT NULL,
        working_root TEXT NULL,
        download_root TEXT NULL,
        quality_status VARCHAR(64) NOT NULL DEFAULT 'clean',
        clean_chapter_count INT NOT NULL DEFAULT 0,
        partial_chapter_count INT NOT NULL DEFAULT 0,
        missing_content_count INT NOT NULL DEFAULT 0,
        quality_summary TEXT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS raven_chapters (
        title_id VARCHAR(191) NOT NULL,
        chapter_id VARCHAR(191) NOT NULL,
        label_name VARCHAR(255) NOT NULL,
        chapter_number VARCHAR(64) NULL,
        page_count INT NOT NULL DEFAULT 0,
        release_date VARCHAR(64) NULL,
        is_available TINYINT(1) NOT NULL DEFAULT 1,
        archive_path TEXT NULL,
        source_url TEXT NULL,
        quality_status VARCHAR(64) NOT NULL DEFAULT 'clean',
        expected_page_count INT NOT NULL DEFAULT 0,
        missing_page_count INT NOT NULL DEFAULT 0,
        missing_pages_json JSON NULL,
        quality_notes_json JSON NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (title_id, chapter_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS raven_download_tasks (
        task_id VARCHAR(191) PRIMARY KEY,
        title_id VARCHAR(191) NULL,
        title_name VARCHAR(255) NOT NULL,
        title_url TEXT NOT NULL,
        provider_id VARCHAR(128) NULL,
        request_id BIGINT NULL,
        request_type VARCHAR(64) NOT NULL,
        requested_by VARCHAR(64) NOT NULL,
        status_name VARCHAR(64) NOT NULL,
        message_text TEXT NULL,
        percent_value INT NOT NULL DEFAULT 0,
        details_json JSON NULL,
        queued_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS raven_metadata_matches (
        title_id VARCHAR(191) PRIMARY KEY,
        provider_id VARCHAR(64) NOT NULL,
        provider_series_id VARCHAR(191) NOT NULL,
        details_json JSON NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vault_jobs (
        job_id VARCHAR(191) PRIMARY KEY,
        job_kind VARCHAR(128) NOT NULL,
        owner_service VARCHAR(128) NOT NULL,
        status_name VARCHAR(64) NOT NULL,
        label_text VARCHAR(255) NULL,
        requested_by VARCHAR(255) NULL,
        payload_json JSON NOT NULL,
        result_json JSON NOT NULL,
        created_at DATETIME NOT NULL,
        started_at DATETIME NULL,
        finished_at DATETIME NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vault_job_tasks (
        task_id VARCHAR(191) PRIMARY KEY,
        job_id VARCHAR(191) NOT NULL,
        task_key VARCHAR(191) NULL,
        label_text VARCHAR(255) NULL,
        status_name VARCHAR(64) NOT NULL,
        message_text TEXT NULL,
        percent_value INT NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        payload_json JSON NOT NULL,
        result_json JSON NOT NULL,
        created_at DATETIME NOT NULL,
        started_at DATETIME NULL,
        finished_at DATETIME NULL,
        updated_at DATETIME NOT NULL,
        INDEX idx_vault_job_tasks_job (job_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vault_events (
        event_seq BIGINT PRIMARY KEY AUTO_INCREMENT,
        event_id VARCHAR(191) NOT NULL UNIQUE,
        domain_name VARCHAR(64) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        severity_name VARCHAR(32) NOT NULL,
        actor_type VARCHAR(64) NOT NULL,
        actor_id VARCHAR(191) NULL,
        actor_label VARCHAR(255) NULL,
        target_type VARCHAR(64) NULL,
        target_id VARCHAR(191) NULL,
        message_text TEXT NOT NULL,
        metadata_json JSON NOT NULL,
        created_at DATETIME NOT NULL,
        INDEX idx_vault_events_domain_created (domain_name, created_at),
        INDEX idx_vault_events_actor (actor_id),
        INDEX idx_vault_events_target (target_id)
      )
    `);
    await ignoreKnownAlterError("ALTER TABLE requests ADD COLUMN request_details_json JSON NULL AFTER moderator_comment");
    await ignoreKnownAlterError("ALTER TABLE requests ADD COLUMN request_work_key TEXT NULL AFTER request_details_json");
    await ignoreKnownAlterError("ALTER TABLE requests ADD COLUMN request_work_key_hash CHAR(64) NULL AFTER request_work_key");
    await ignoreKnownAlterError("ALTER TABLE requests ADD COLUMN revision_number INT NOT NULL DEFAULT 1");
    await ignoreKnownAlterError("ALTER TABLE requests ADD INDEX idx_requests_work_key_hash (request_work_key_hash)");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN library_type_label VARCHAR(255) NULL");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN library_type_slug VARCHAR(191) NULL");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN working_root TEXT NULL");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN quality_status VARCHAR(64) NOT NULL DEFAULT 'clean'");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN clean_chapter_count INT NOT NULL DEFAULT 0");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN partial_chapter_count INT NOT NULL DEFAULT 0");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN missing_content_count INT NOT NULL DEFAULT 0");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN quality_summary TEXT NULL");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD INDEX idx_raven_titles_type_title (library_type_slug, title)");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD INDEX idx_raven_titles_updated (updated_at)");
    await ignoreKnownAlterError("ALTER TABLE raven_chapters ADD COLUMN quality_status VARCHAR(64) NOT NULL DEFAULT 'clean'");
    await ignoreKnownAlterError("ALTER TABLE raven_chapters ADD COLUMN expected_page_count INT NOT NULL DEFAULT 0");
    await ignoreKnownAlterError("ALTER TABLE raven_chapters ADD COLUMN missing_page_count INT NOT NULL DEFAULT 0");
    await ignoreKnownAlterError("ALTER TABLE raven_chapters ADD COLUMN missing_pages_json JSON NULL");
    await ignoreKnownAlterError("ALTER TABLE raven_chapters ADD COLUMN quality_notes_json JSON NULL");
    await ignoreKnownAlterError("ALTER TABLE raven_download_tasks ADD COLUMN provider_id VARCHAR(128) NULL AFTER title_url");
    await ignoreKnownAlterError("ALTER TABLE raven_download_tasks ADD COLUMN request_id BIGINT NULL AFTER provider_id");
    await ignoreKnownAlterError("ALTER TABLE raven_download_tasks ADD COLUMN details_json JSON NULL AFTER percent_value");

    const [requestRows] = await pool.query("SELECT * FROM requests ORDER BY created_at ASC, id ASC");
    await pool.query("DELETE FROM request_work_locks");
    const claimedWorkKeys = new Set();
    for (const row of requestRows) {
      const request = toRequest(row);
      await pool.query(`
        UPDATE requests
        SET request_work_key = ?, request_work_key_hash = ?
        WHERE id = ?
      `, [
        request.workKey || null,
        request.workKeyHash || null,
        row.id
      ]);
      if (!requestStatusUsesWorkLock(request.status) || !request.workKeyHash || claimedWorkKeys.has(request.workKeyHash)) {
        continue;
      }
      await pool.query(`
        INSERT INTO request_work_locks (request_work_key_hash, request_work_key, request_id, created_at, updated_at)
        VALUES (?, ?, ?, NOW(), NOW())
      `, [
        request.workKeyHash,
        request.workKey,
        row.id
      ]);
      claimedWorkKeys.add(request.workKeyHash);
    }

    const [groupRows] = await pool.query("SELECT * FROM permission_groups ORDER BY created_at ASC, group_name ASC");
    const seededGroups = ensureSeedPermissionGroups(groupRows.map((row) => ({
      id: row.group_id,
      name: row.group_name,
      description: row.description_text,
      isDefault: row.is_default === 1,
      permissions: parseJsonColumn(row.permissions_json, []),
      adminGrants: parseJsonColumn(row.admin_grants_json, {}),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    })), nowIso);
    for (const group of seededGroups) {
      await pool.query(`
        INSERT INTO permission_groups (
          group_id, group_name, description_text, is_default, permissions_json, admin_grants_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          group_name = VALUES(group_name),
          description_text = VALUES(description_text),
          is_default = VALUES(is_default),
          permissions_json = VALUES(permissions_json),
          admin_grants_json = VALUES(admin_grants_json),
          updated_at = VALUES(updated_at)
      `, [
        group.id,
        group.name,
        group.description || null,
        group.isDefault ? 1 : 0,
        JSON.stringify(group.permissions || []),
        JSON.stringify(group.adminGrants || {}),
        toMysqlDateTime(group.createdAt, toMysqlDateTime(nowIso())),
        toMysqlDateTime(group.updatedAt, toMysqlDateTime(nowIso()))
      ]);
    }

    const defaultGroupId = getDefaultGroupId(seededGroups);
    if (defaultGroupId) {
      const [userRows] = await pool.query("SELECT discord_user_id, role_name FROM users WHERE role_name <> 'owner'");
      for (const row of userRows) {
        const [assignmentRows] = await pool.query(
          "SELECT group_id FROM user_permission_groups WHERE discord_user_id = ? LIMIT 1",
          [row.discord_user_id]
        );
        if (!assignmentRows[0]) {
          await pool.query(`
            INSERT INTO user_permission_groups (discord_user_id, group_id, created_at, updated_at)
            VALUES (?, ?, NOW(), NOW())
          `, [row.discord_user_id, defaultGroupId]);
        }
      }
      for (const row of userRows) {
        await refreshStoredUserAccess(pool, row.discord_user_id);
      }
    }

    const retentionCutoff = new Date(Date.now() - (DEFAULT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000));
    await pool.query("DELETE FROM vault_events WHERE created_at < ?", [toMysqlDateTime(retentionCutoff)]);
  };

  const toPermissionGroup = (row) => normalizePermissionGroup({
    id: row.group_id,
    name: row.group_name,
    description: row.description_text,
    isDefault: row.is_default === 1,
    permissions: parseJsonColumn(row.permissions_json, []),
    adminGrants: parseJsonColumn(row.admin_grants_json, {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  });
  const toStoredUser = (row) => ({
    id: row.discord_user_id,
    discordUserId: row.discord_user_id,
    username: row.username,
    avatarUrl: row.avatar_url,
    role: row.role_name,
    permissions: parseJsonColumn(row.permissions_json, []),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  });
  const toApiKey = (row) => normalizeApiKeyRecord({
    id: row.api_key_id,
    name: row.key_name,
    kind: row.key_kind,
    enabled: row.enabled === 1,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    ownerDiscordUserId: row.owner_discord_user_id,
    createdBy: parseJsonColumn(row.created_by_json, {}),
    groupIds: parseJsonColumn(row.group_ids_json, []),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  });
  const toVaultEvent = (row) => normalizeVaultEvent({
    sequence: Number.parseInt(String(row.event_seq || 0), 10) || 0,
    eventId: row.event_id,
    domain: row.domain_name,
    eventType: row.event_type,
    severity: row.severity_name,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    targetType: row.target_type,
    targetId: row.target_id,
    message: row.message_text,
    metadata: parseJsonColumn(row.metadata_json, {}),
    createdAt: row.created_at.toISOString()
  });
  const listPermissionGroupsFrom = async (executor = pool) => {
    const [rows] = await executor.query("SELECT * FROM permission_groups ORDER BY group_name ASC");
    return ensureSingleDefaultGroup(rows.map(toPermissionGroup));
  };
  const getPermissionGroupByIdFrom = async (executor, groupId) => {
    const [rows] = await executor.query("SELECT * FROM permission_groups WHERE group_id = ? LIMIT 1", [groupId]);
    return rows[0] ? toPermissionGroup(rows[0]) : null;
  };
  const listUserGroupAssignmentsFrom = async (executor = pool) => {
    const [rows] = await executor.query("SELECT * FROM user_permission_groups");
    return rows.map((row) => ({
      discordUserId: row.discord_user_id,
      groupId: row.group_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    }));
  };
  const listGroupsForUserFrom = async (executor, discordUserId) => {
    const [rows] = await executor.query(`
      SELECT permission_groups.*
      FROM user_permission_groups
      INNER JOIN permission_groups ON permission_groups.group_id = user_permission_groups.group_id
      WHERE user_permission_groups.discord_user_id = ?
      ORDER BY permission_groups.group_name ASC
    `, [discordUserId]);
    return rows.map(toPermissionGroup);
  };
  const hydrateUserRow = async (executor, row) => buildEffectiveUserAccess(
    toStoredUser(row),
    row.role_name === "owner" ? [] : await listGroupsForUserFrom(executor, row.discord_user_id)
  );
  const refreshStoredUserAccess = async (connection, discordUserId) => {
    const [rows] = await connection.query("SELECT * FROM users WHERE discord_user_id = ? LIMIT 1", [discordUserId]);
    if (!rows[0]) {
      return null;
    }
    const next = await hydrateUserRow(connection, rows[0]);
    await connection.query(`
      UPDATE users
      SET role_name = ?, permissions_json = ?, updated_at = NOW()
      WHERE discord_user_id = ?
    `, [next.role, JSON.stringify(next.permissions || []), discordUserId]);
    return {
      ...next,
      updatedAt: nowIso()
    };
  };
  const refreshUsersForGroups = async (connection, groupIds = []) => {
    const normalizedGroupIds = Array.from(new Set((Array.isArray(groupIds) ? groupIds : [])
      .map((groupId) => normalizeString(groupId))
      .filter(Boolean)));
    if (!normalizedGroupIds.length) {
      return [];
    }
    const placeholders = normalizedGroupIds.map(() => "?").join(", ");
    const [rows] = await connection.query(`
      SELECT DISTINCT discord_user_id
      FROM user_permission_groups
      WHERE group_id IN (${placeholders})
    `, normalizedGroupIds);
    const refreshed = [];
    for (const row of rows) {
      const user = await refreshStoredUserAccess(connection, row.discord_user_id);
      if (user) {
        refreshed.push(user);
      }
    }
    return refreshed;
  };
  const toRavenChapter = (row) => ({
    id: row.chapter_id,
    label: row.label_name,
    chapterNumber: row.chapter_number,
    pageCount: row.page_count,
    releaseDate: row.release_date,
    available: row.is_available === 1,
    archivePath: row.archive_path,
    sourceUrl: row.source_url,
    qualityStatus: row.quality_status,
    expectedPageCount: row.expected_page_count,
    missingPageCount: row.missing_page_count,
    missingPages: parseJsonColumn(row.missing_pages_json, []),
    qualityNotes: parseJsonColumn(row.quality_notes_json, []),
    updatedAt: row.updated_at.toISOString()
  });
  const toRavenTitle = (row, chapters = []) => normalizeRavenTitle({
    id: row.title_id,
    title: row.title,
    mediaType: row.media_type,
    libraryTypeLabel: row.library_type_label,
    libraryTypeSlug: row.library_type_slug,
    status: row.status_name,
    latestChapter: row.latest_chapter,
    coverAccent: row.cover_accent,
    summary: row.summary,
    releaseLabel: row.release_label,
    chapterCount: row.chapter_count,
    chaptersDownloaded: row.chapters_downloaded,
    author: row.author_name,
    tags: parseJsonColumn(row.tags_json, []),
    aliases: parseJsonColumn(row.aliases_json, []),
    metadataProvider: row.metadata_provider,
    metadataMatchedAt: row.metadata_matched_at ? row.metadata_matched_at.toISOString() : null,
    relations: parseJsonColumn(row.relations_json, []),
    sourceUrl: row.source_url,
    coverUrl: row.cover_url,
    workingRoot: row.working_root,
    downloadRoot: row.download_root,
    qualityStatus: row.quality_status,
    cleanChapterCount: row.clean_chapter_count,
    partialChapterCount: row.partial_chapter_count,
    missingContentCount: row.missing_content_count,
    qualitySummary: row.quality_summary,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null
  }, chapters);
  const toRequest = (row) => {
    const details = normalizeRequestDetails(parseJsonColumn(row.request_details_json, {}));
    const derived = applyRequestWorkIdentity({
      id: row.id,
      source: row.source,
      title: row.title,
      requestType: row.request_type,
      notes: row.notes,
      requestedBy: row.requested_by,
      status: row.status_name,
      moderatorComment: row.moderator_comment,
      details,
      timeline: parseJsonColumn(row.timeline_json, []),
      revision: Number.parseInt(String(row.revision_number || 1), 10) || 1,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    });
    const workKey = normalizeString(row.request_work_key, derived.workKey);
    const workKeyHash = normalizeString(row.request_work_key_hash, derived.workKeyHash);
    const workKeyKind = normalizeString(
      derived.workKeyKind,
      workKey.startsWith("download:") ? "download" : workKey.startsWith("metadata:") ? "metadata" : ""
    );
    return {
      ...derived,
      details: {
        ...derived.details,
        ...(workKey ? {
          requestWorkKey: workKey,
          requestWorkHash: workKeyHash,
          requestWorkKind: workKeyKind
        } : {})
      },
      workKey,
      workKeyHash,
      workKeyKind
    };
  };
  const toVaultJob = (row) => normalizeVaultJob({
    jobId: row.job_id,
    kind: row.job_kind,
    ownerService: row.owner_service,
    status: row.status_name,
    label: row.label_text,
    requestedBy: row.requested_by,
    payload: parseJsonColumn(row.payload_json, {}),
    result: parseJsonColumn(row.result_json, {}),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString()
  });
  const toVaultJobTask = (row) => normalizeVaultJobTask(row.job_id, {
    taskId: row.task_id,
    taskKey: row.task_key,
    label: row.label_text,
    status: row.status_name,
    message: row.message_text,
    percent: row.percent_value,
    sortOrder: row.sort_order,
    payload: parseJsonColumn(row.payload_json, {}),
    result: parseJsonColumn(row.result_json, {}),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString()
  });
  const withTransaction = async (handler) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await handler(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };
  const isDuplicateKeyError = (error) => Number(error?.errno) === 1062 || String(error?.code || "") === "ER_DUP_ENTRY";
  const acquireRequestWorkLock = async (connection, request, requestId) => {
    if (!requestStatusUsesWorkLock(request?.status) || !normalizeString(request?.workKeyHash) || !normalizeString(request?.workKey)) {
      return;
    }

    const workKeyHash = normalizeString(request.workKeyHash);
    const workKey = normalizeString(request.workKey);
    const normalizedRequestId = normalizeScalarString(requestId);
    const [existingRows] = await connection.query(`
      SELECT request_id, request_work_key
      FROM request_work_locks
      WHERE request_work_key_hash = ?
      LIMIT 1
      FOR UPDATE
    `, [workKeyHash]);
    if (existingRows[0]) {
      const existingRequestId = normalizeScalarString(existingRows[0].request_id);
      if (existingRequestId !== normalizedRequestId) {
        throw buildRequestWorkConflict(existingRequestId, request);
      }

      if (normalizeString(existingRows[0].request_work_key) !== workKey) {
        await connection.query(`
          UPDATE request_work_locks
          SET request_work_key = ?, updated_at = NOW()
          WHERE request_work_key_hash = ?
        `, [workKey, workKeyHash]);
      }
      return;
    }

    try {
      await connection.query(`
        INSERT INTO request_work_locks (request_work_key_hash, request_work_key, request_id, created_at, updated_at)
        VALUES (?, ?, ?, NOW(), NOW())
      `, [workKeyHash, workKey, normalizedRequestId]);
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const [conflictRows] = await connection.query(`
        SELECT request_id
        FROM request_work_locks
        WHERE request_work_key_hash = ?
        LIMIT 1
      `, [workKeyHash]);
      throw buildRequestWorkConflict(conflictRows[0]?.request_id, request);
    }
  };
  const releaseRequestWorkLock = async (connection, requestId, workKeyHash) => {
    const normalizedRequestId = normalizeScalarString(requestId);
    const normalizedWorkKeyHash = normalizeString(workKeyHash);
    if (!normalizedRequestId || !normalizedWorkKeyHash) {
      return;
    }
    await connection.query(`
      DELETE FROM request_work_locks
      WHERE request_work_key_hash = ? AND request_id = ?
    `, [normalizedWorkKeyHash, normalizedRequestId]);
  };

  return {
    driver: "mysql",
    init,
    async health() {
      await pool.query("SELECT 1");
      return {ready: true, degraded: false, reason: null};
    },
    async getBootstrapStatus(superuserId) {
      const [rows] = await pool.query("SELECT discord_user_id FROM users WHERE role_name = 'owner' LIMIT 1");
      return {
        ownerClaimed: rows.length > 0,
        superuserIdConfigured: Boolean(superuserId),
        superuserId,
        ownerDiscordUserId: rows[0]?.discord_user_id || null
      };
    },
    async upsertDiscordUser({discordUserId, username, avatarUrl, role, permissions, claimOwner = false}) {
      await withTransaction(async (connection) => {
        const [existingRows] = await connection.query("SELECT * FROM users WHERE discord_user_id = ? LIMIT 1 FOR UPDATE", [discordUserId]);
        const existing = existingRows[0];
        const [ownerRows] = await connection.query("SELECT discord_user_id FROM users WHERE role_name = 'owner' LIMIT 1 FOR UPDATE");
        const ownerDiscordUserId = ownerRows[0]?.discord_user_id || null;
        if (claimOwner && ownerDiscordUserId && ownerDiscordUserId !== discordUserId) {
          throw createConflictError("Owner already claimed.", "OWNER_ALREADY_CLAIMED");
        }

        const nextRole = role || existing?.role_name || (claimOwner ? "owner" : "member");
        const nextPermissions = Array.isArray(permissions) && permissions.length
          ? permissions
          : deriveLegacyPermissions({
            role: nextRole,
            isOwner: nextRole === "owner"
          });
        await connection.query(`
          INSERT INTO users (discord_user_id, username, avatar_url, role_name, permissions_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE username = VALUES(username), avatar_url = VALUES(avatar_url), role_name = VALUES(role_name),
          permissions_json = VALUES(permissions_json), updated_at = NOW()
        `, [discordUserId, username, avatarUrl || null, nextRole, JSON.stringify(nextPermissions)]);

        if (nextRole !== "owner") {
          const groups = await listPermissionGroupsFrom(connection);
          const defaultGroupId = getDefaultGroupId(groups);
          const [assignmentRows] = await connection.query(
            "SELECT group_id FROM user_permission_groups WHERE discord_user_id = ? LIMIT 1",
            [discordUserId]
          );
          if (!assignmentRows[0] && defaultGroupId) {
            await connection.query(`
              INSERT INTO user_permission_groups (discord_user_id, group_id, created_at, updated_at)
              VALUES (?, ?, NOW(), NOW())
            `, [discordUserId, defaultGroupId]);
          }
          await refreshStoredUserAccess(connection, discordUserId);
        }
      });
      return this.getUserByDiscordId(discordUserId);
    },
    async getUserByDiscordId(discordUserId) {
      const [rows] = await pool.query("SELECT * FROM users WHERE discord_user_id = ? LIMIT 1", [discordUserId]);
      return rows[0] ? hydrateUserRow(pool, rows[0]) : null;
    },
    async listUsers() {
      const [rows] = await pool.query("SELECT * FROM users ORDER BY username ASC");
      return Promise.all(rows.map((row) => hydrateUserRow(pool, row)));
    },
    async listPermissionGroups() {
      return listPermissionGroupsFrom(pool);
    },
    async getPermissionGroup(groupId) {
      return getPermissionGroupByIdFrom(pool, normalizeString(groupId));
    },
    async createPermissionGroup(payload) {
      const group = normalizePermissionGroup({
        ...payload,
        id: payload?.id || payload?.name,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      return withTransaction(async (connection) => {
        const [existingRows] = await connection.query("SELECT group_id FROM permission_groups WHERE group_id = ? LIMIT 1 FOR UPDATE", [group.id]);
        if (existingRows[0]) {
          throw createConflictError("Permission group already exists.", "PERMISSION_GROUP_CONFLICT");
        }
        const currentGroups = await listPermissionGroupsFrom(connection);
        const nextGroups = ensureSingleDefaultGroup([...currentGroups, group]);
        for (const entry of nextGroups) {
          await connection.query(`
            INSERT INTO permission_groups (
              group_id, group_name, description_text, is_default, permissions_json, admin_grants_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              group_name = VALUES(group_name),
              description_text = VALUES(description_text),
              is_default = VALUES(is_default),
              permissions_json = VALUES(permissions_json),
              admin_grants_json = VALUES(admin_grants_json),
              updated_at = VALUES(updated_at)
          `, [
            entry.id,
            entry.name,
            entry.description || null,
            entry.isDefault ? 1 : 0,
            JSON.stringify(entry.permissions || []),
            JSON.stringify(entry.adminGrants || {}),
            toMysqlDateTime(entry.createdAt, toMysqlDateTime(nowIso())),
            toMysqlDateTime(entry.updatedAt, toMysqlDateTime(nowIso()))
          ]);
        }
        return getPermissionGroupByIdFrom(connection, group.id);
      });
    },
    async updatePermissionGroup(groupId, payload) {
      const normalizedGroupId = normalizeString(groupId);
      return withTransaction(async (connection) => {
        const existing = await getPermissionGroupByIdFrom(connection, normalizedGroupId);
        if (!existing) {
          return null;
        }
        const next = normalizePermissionGroup({
          ...existing,
          ...payload,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: nowIso()
        }, existing);
        const currentGroups = await listPermissionGroupsFrom(connection);
        const nextGroups = ensureSingleDefaultGroup(currentGroups.map((group) => group.id === existing.id ? next : group));
        for (const entry of nextGroups) {
          await connection.query(`
            UPDATE permission_groups
            SET group_name = ?, description_text = ?, is_default = ?, permissions_json = ?, admin_grants_json = ?, updated_at = ?
            WHERE group_id = ?
          `, [
            entry.name,
            entry.description || null,
            entry.isDefault ? 1 : 0,
            JSON.stringify(entry.permissions || []),
            JSON.stringify(entry.adminGrants || {}),
            toMysqlDateTime(entry.updatedAt, toMysqlDateTime(nowIso())),
            entry.id
          ]);
        }
        await refreshUsersForGroups(connection, [existing.id]);
        return getPermissionGroupByIdFrom(connection, existing.id);
      });
    },
    async deletePermissionGroup(groupId) {
      const normalizedGroupId = normalizeString(groupId);
      return withTransaction(async (connection) => {
        const existing = await getPermissionGroupByIdFrom(connection, normalizedGroupId);
        if (!existing) {
          return null;
        }
        if (existing.isDefault) {
          throw createConflictError("Choose a new default group before deleting the current default.", "DEFAULT_GROUP_REQUIRED");
        }
        const [affectedRows] = await connection.query(
          "SELECT DISTINCT discord_user_id FROM user_permission_groups WHERE group_id = ?",
          [existing.id]
        );
        await connection.query("DELETE FROM user_permission_groups WHERE group_id = ?", [existing.id]);
        await connection.query("DELETE FROM permission_groups WHERE group_id = ?", [existing.id]);
        for (const row of affectedRows) {
          await refreshStoredUserAccess(connection, row.discord_user_id);
        }
        return existing;
      });
    },
    async assignUserGroups(discordUserId, groupIds = []) {
      const normalizedDiscordUserId = normalizeString(discordUserId);
      return withTransaction(async (connection) => {
        const [userRows] = await connection.query("SELECT * FROM users WHERE discord_user_id = ? LIMIT 1 FOR UPDATE", [normalizedDiscordUserId]);
        if (!userRows[0]) {
          return null;
        }
        if (userRows[0].role_name === "owner") {
          throw createConflictError("The protected owner cannot be reassigned.", "PROTECTED_OWNER");
        }
        const validGroupIds = Array.from(new Set((Array.isArray(groupIds) ? groupIds : [])
          .map((entry) => normalizeString(entry))
          .filter(Boolean)));
        if (validGroupIds.length) {
          const placeholders = validGroupIds.map(() => "?").join(", ");
          const [groupRows] = await connection.query(
            `SELECT group_id FROM permission_groups WHERE group_id IN (${placeholders})`,
            validGroupIds
          );
          const allowedIds = new Set(groupRows.map((row) => row.group_id));
          await connection.query("DELETE FROM user_permission_groups WHERE discord_user_id = ?", [normalizedDiscordUserId]);
          for (const groupId of validGroupIds.filter((entry) => allowedIds.has(entry))) {
            await connection.query(`
              INSERT INTO user_permission_groups (discord_user_id, group_id, created_at, updated_at)
              VALUES (?, ?, NOW(), NOW())
            `, [normalizedDiscordUserId, groupId]);
          }
        } else {
          await connection.query("DELETE FROM user_permission_groups WHERE discord_user_id = ?", [normalizedDiscordUserId]);
        }
        return refreshStoredUserAccess(connection, normalizedDiscordUserId);
      });
    },
    async deleteUser(discordUserId) {
      const normalizedDiscordUserId = normalizeString(discordUserId);
      return withTransaction(async (connection) => {
        const [userRows] = await connection.query("SELECT * FROM users WHERE discord_user_id = ? LIMIT 1 FOR UPDATE", [normalizedDiscordUserId]);
        if (!userRows[0]) {
          return null;
        }
        if (userRows[0].role_name === "owner") {
          throw createConflictError("The protected owner cannot be deleted.", "PROTECTED_OWNER");
        }
        const hydrated = await hydrateUserRow(connection, userRows[0]);
        await connection.query("DELETE FROM sessions WHERE discord_user_id = ?", [normalizedDiscordUserId]);
        await connection.query("DELETE FROM user_permission_groups WHERE discord_user_id = ?", [normalizedDiscordUserId]);
        await connection.query("DELETE FROM users WHERE discord_user_id = ?", [normalizedDiscordUserId]);
        return hydrated;
      });
    },
    async getAccessOverview() {
      const [users, groups] = await Promise.all([
        this.listUsers(),
        this.listPermissionGroups()
      ]);
      return {
        users,
        groups,
        defaultGroupId: getDefaultGroupId(groups)
      };
    },
    async createApiKey(payload = {}) {
      const entry = normalizeApiKeyRecord({
        ...payload,
        id: payload.id || `ak_${randomUUID()}`,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      validateApiKeyCreate(entry);
      try {
        await pool.query(`
          INSERT INTO api_keys (
            api_key_id, key_name, key_kind, enabled, key_hash, key_prefix, owner_discord_user_id,
            created_by_json, group_ids_json, last_used_at, revoked_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          entry.id,
          entry.name,
          entry.kind,
          entry.enabled ? 1 : 0,
          entry.keyHash,
          entry.keyPrefix,
          entry.ownerDiscordUserId || null,
          JSON.stringify(entry.createdBy || {}),
          JSON.stringify(entry.groupIds || []),
          entry.lastUsedAt ? toMysqlDateTime(entry.lastUsedAt) : null,
          entry.revokedAt ? toMysqlDateTime(entry.revokedAt) : null,
          toMysqlDateTime(entry.createdAt, toMysqlDateTime(nowIso())),
          toMysqlDateTime(entry.updatedAt, toMysqlDateTime(nowIso()))
        ]);
      } catch (error) {
        if (String(error?.message || "").includes("Duplicate entry")) {
          throw createConflictError("API key already exists.", "API_KEY_CONFLICT");
        }
        throw error;
      }
      return this.getApiKey(entry.id);
    },
    async listApiKeys(filters = {}) {
      const where = [];
      const params = [];
      const kind = normalizeString(filters.kind).toLowerCase();
      const ownerDiscordUserId = normalizeString(filters.ownerDiscordUserId);
      if (kind) {
        where.push("key_kind = ?");
        params.push(kind);
      }
      if (ownerDiscordUserId) {
        where.push("owner_discord_user_id = ?");
        params.push(ownerDiscordUserId);
      }
      if (filters.includeRevoked === false) {
        where.push("revoked_at IS NULL");
      }
      const [rows] = await pool.query(
        `SELECT * FROM api_keys ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`,
        params
      );
      return rows.map(toApiKey);
    },
    async getApiKey(apiKeyId) {
      const [rows] = await pool.query("SELECT * FROM api_keys WHERE api_key_id = ? LIMIT 1", [normalizeString(apiKeyId)]);
      return rows[0] ? toApiKey(rows[0]) : null;
    },
    async updateApiKey(apiKeyId, payload = {}) {
      const existing = await this.getApiKey(apiKeyId);
      if (!existing) {
        return null;
      }
      const next = normalizeApiKeyRecord({
        ...existing,
        name: payload.name ?? existing.name,
        enabled: payload.enabled ?? existing.enabled,
        groupIds: Array.isArray(payload.groupIds) ? payload.groupIds : existing.groupIds,
        updatedAt: nowIso()
      }, existing);
      await pool.query(`
        UPDATE api_keys
        SET key_name = ?, enabled = ?, group_ids_json = ?, updated_at = ?
        WHERE api_key_id = ?
      `, [
        next.name,
        next.enabled ? 1 : 0,
        JSON.stringify(next.groupIds || []),
        toMysqlDateTime(next.updatedAt, toMysqlDateTime(nowIso())),
        existing.id
      ]);
      return this.getApiKey(existing.id);
    },
    async revokeApiKey(apiKeyId) {
      const existing = await this.getApiKey(apiKeyId);
      if (!existing) {
        return null;
      }
      const revokedAt = existing.revokedAt || nowIso();
      await pool.query(`
        UPDATE api_keys
        SET enabled = 0, revoked_at = ?, updated_at = ?
        WHERE api_key_id = ?
      `, [
        toMysqlDateTime(revokedAt, toMysqlDateTime(nowIso())),
        toMysqlDateTime(nowIso()),
        existing.id
      ]);
      return this.getApiKey(existing.id);
    },
    async resolveApiKey(keyHash) {
      const normalizedHash = normalizeString(keyHash);
      if (!normalizedHash) {
        return null;
      }
      const [rows] = await pool.query(
        "SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1 AND revoked_at IS NULL LIMIT 1",
        [normalizedHash]
      );
      if (!rows[0]) {
        return null;
      }
      await pool.query("UPDATE api_keys SET last_used_at = NOW(), updated_at = NOW() WHERE api_key_id = ?", [rows[0].api_key_id]);
      const [updatedRows] = await pool.query("SELECT * FROM api_keys WHERE api_key_id = ? LIMIT 1", [rows[0].api_key_id]);
      return updatedRows[0] ? toApiKey(updatedRows[0]) : null;
    },
    async createSession({discordUserId}) {
      const token = randomToken("sess");
      await pool.query("INSERT INTO sessions (token, discord_user_id, created_at) VALUES (?, ?, NOW())", [token, discordUserId]);
      return {token, discordUserId};
    },
    async clearSession(token) {
      const session = await this.getSession(token);
      if (!session) {
        return null;
      }
      await pool.query("DELETE FROM sessions WHERE token = ?", [token]);
      return session;
    },
    async clearSessionsForUser(discordUserId) {
      await pool.query("DELETE FROM sessions WHERE discord_user_id = ?", [discordUserId]);
      return {ok: true};
    },
    async getSession(token) {
      const [rows] = await pool.query("SELECT * FROM sessions WHERE token = ? LIMIT 1", [token]);
      return rows[0]
        ? {token: rows[0].token, discordUserId: rows[0].discord_user_id, createdAt: rows[0].created_at.toISOString()}
        : null;
    },
    async getUserForSession(token) {
      const session = await this.getSession(token);
      if (!session) {
        return null;
      }
      return this.getUserByDiscordId(session.discordUserId);
    },
    async setSetting(key, value) {
      await pool.query(`
        INSERT INTO settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()
      `, [key, JSON.stringify(value)]);
      return this.getSetting(key);
    },
    async getSetting(key) {
      const [rows] = await pool.query("SELECT * FROM settings WHERE setting_key = ? LIMIT 1", [key]);
      return rows[0]
        ? {key: rows[0].setting_key, value: parseJsonColumn(rows[0].setting_value), updatedAt: rows[0].updated_at.toISOString()}
        : null;
    },
    async getDatabaseOverview() {
      return buildMysqlDatabaseOverview(pool, config.mysql.database);
    },
    async getDatabaseTable(tableName, options = {}) {
      return readMysqlDatabaseTable(pool, config.mysql.database, tableName, options);
    },
    async updateDatabaseSetting(key, value) {
      const normalized = normalizeDatabaseSettingUpdate(key, value);
      return this.setSetting(normalized.key, normalized.value);
    },
    async setSecret(key, value) {
      await pool.query(`
        INSERT INTO secrets (secret_key, secret_value, updated_at)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE secret_value = VALUES(secret_value), updated_at = NOW()
      `, [key, JSON.stringify(value)]);
      return this.getSecret(key);
    },
    async getSecret(key) {
      const [rows] = await pool.query("SELECT * FROM secrets WHERE secret_key = ? LIMIT 1", [key]);
      return rows[0]
        ? {key: rows[0].secret_key, value: parseJsonColumn(rows[0].secret_value), updatedAt: rows[0].updated_at.toISOString()}
        : null;
    },
    async appendEvent(payload) {
      const normalized = normalizeVaultEvent(payload, nowIso);
      const [result] = await pool.query(`
        INSERT INTO vault_events (
          event_id, domain_name, event_type, severity_name, actor_type, actor_id, actor_label, target_type, target_id, message_text,
          metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        normalized.eventId,
        normalized.domain,
        normalized.eventType,
        normalized.severity,
        normalized.actorType,
        normalized.actorId || null,
        normalized.actorLabel || null,
        normalized.targetType || null,
        normalized.targetId || null,
        normalized.message,
        JSON.stringify(normalized.metadata || {}),
        toMysqlDateTime(normalized.createdAt, toMysqlDateTime(nowIso()))
      ]);
      const [rows] = await pool.query("SELECT * FROM vault_events WHERE event_seq = ? LIMIT 1", [result.insertId]);
      return rows[0] ? toVaultEvent(rows[0]) : null;
    },
    async listEvents(filters = {}) {
      const normalized = normalizeEventFilters(filters);
      const where = [];
      const params = [];
      if (normalized.domains.length) {
        where.push(`domain_name IN (${normalized.domains.map(() => "?").join(", ")})`);
        params.push(...normalized.domains);
      }
      if (normalized.eventTypes.length) {
        where.push(`event_type IN (${normalized.eventTypes.map(() => "?").join(", ")})`);
        params.push(...normalized.eventTypes);
      }
      if (normalized.severities.length) {
        where.push(`severity_name IN (${normalized.severities.map(() => "?").join(", ")})`);
        params.push(...normalized.severities);
      }
      if (normalized.actorType) {
        where.push("actor_type = ?");
        params.push(normalized.actorType);
      }
      if (normalized.actorId) {
        where.push("actor_id = ?");
        params.push(normalized.actorId);
      }
      if (normalized.targetType) {
        where.push("target_type = ?");
        params.push(normalized.targetType);
      }
      if (normalized.targetId) {
        where.push("target_id = ?");
        params.push(normalized.targetId);
      }
      if (normalized.afterSequence) {
        where.push("event_seq > ?");
        params.push(normalized.afterSequence);
      }
      const since = toMysqlDateTime(normalized.since);
      if (since) {
        where.push("created_at >= ?");
        params.push(since);
      }
      const until = toMysqlDateTime(normalized.until);
      if (until) {
        where.push("created_at <= ?");
        params.push(until);
      }
      if (normalized.query) {
        const query = `%${normalized.query}%`;
        where.push(`(
          message_text LIKE ?
          OR domain_name LIKE ?
          OR event_type LIKE ?
          OR actor_label LIKE ?
          OR actor_id LIKE ?
          OR target_type LIKE ?
          OR target_id LIKE ?
        )`);
        params.push(query, query, query, query, query, query, query);
      }
      const [rows] = await pool.query(`
        SELECT * FROM vault_events
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY event_seq ${normalized.newestFirst ? "DESC" : "ASC"}
        LIMIT ?
      `, [...params, normalized.limit]);
      return rows.map(toVaultEvent);
    },
    async pruneEvents(retentionDays = DEFAULT_EVENT_RETENTION_DAYS) {
      const cutoff = new Date(Date.now() - (Number(retentionDays) * 24 * 60 * 60 * 1000));
      const [result] = await pool.query("DELETE FROM vault_events WHERE created_at < ?", [toMysqlDateTime(cutoff)]);
      return {removed: Number(result.affectedRows || 0)};
    },
    async listRequests() {
      const [rows] = await pool.query("SELECT * FROM requests ORDER BY created_at DESC");
      return rows.map(toRequest);
    },
    async getRequest(id) {
      const [rows] = await pool.query("SELECT * FROM requests WHERE id = ? LIMIT 1", [id]);
      return rows[0] ? toRequest(rows[0]) : null;
    },
    async createRequest(payload) {
      return withTransaction(async (connection) => {
        const request = buildRequestFromPayload(payload);
        const [result] = await connection.query(`
          INSERT INTO requests (
            source, title, request_type, notes, requested_by, status_name, moderator_comment, request_details_json, request_work_key,
            request_work_key_hash, timeline_json, revision_number, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
        `, [
          request.source,
          request.title,
          request.requestType,
          request.notes || "",
          request.requestedBy,
          request.status,
          request.moderatorComment || "",
          JSON.stringify(request.details || {}),
          request.workKey || null,
          request.workKeyHash || null,
          JSON.stringify(request.timeline || [])
        ]);
        await acquireRequestWorkLock(connection, request, result.insertId);
        const [rows] = await connection.query("SELECT * FROM requests WHERE id = ? LIMIT 1", [result.insertId]);
        return rows[0] ? toRequest(rows[0]) : null;
      });
    },
    async updateRequest(id, update) {
      const expectedRevision = update.expectedRevision ?? update.revision;
      return withTransaction(async (connection) => {
        const [rows] = await connection.query("SELECT * FROM requests WHERE id = ? LIMIT 1 FOR UPDATE", [id]);
        if (!rows[0]) {
          return null;
        }

        const current = toRequest(rows[0]);
        if (expectedRevision != null && Number(expectedRevision) !== Number(current.revision || 1)) {
          throw createConflictError("Request revision conflict.", "REQUEST_REVISION_CONFLICT");
        }

        const next = applyRequestUpdate(current, update);
        if (requestStatusUsesWorkLock(current.status) && current.workKeyHash && current.workKeyHash !== next.workKeyHash) {
          await releaseRequestWorkLock(connection, id, current.workKeyHash);
        }
        if (requestStatusUsesWorkLock(current.status) && current.workKeyHash && !requestStatusUsesWorkLock(next.status)) {
          await releaseRequestWorkLock(connection, id, current.workKeyHash);
        }
        await acquireRequestWorkLock(connection, next, id);
        await connection.query(`
          UPDATE requests
          SET title = ?, request_type = ?, notes = ?, status_name = ?, moderator_comment = ?, request_details_json = ?, request_work_key = ?, request_work_key_hash = ?, timeline_json = ?, revision_number = ?, updated_at = NOW()
          WHERE id = ?
        `, [
          next.title,
          next.requestType,
          next.notes || "",
          next.status,
          next.moderatorComment || "",
          JSON.stringify(next.details || {}),
          next.workKey || null,
          next.workKeyHash || null,
          JSON.stringify(next.timeline || []),
          next.revision,
          id
        ]);
        const [updatedRows] = await connection.query("SELECT * FROM requests WHERE id = ? LIMIT 1", [id]);
        return updatedRows[0] ? toRequest(updatedRows[0]) : null;
      });
    },
    async reviewRequest(id, review) {
      return this.updateRequest(id, {
        status: review.status,
        moderatorComment: review.comment || "",
        comment: review.comment,
        actor: review.actor,
        expectedRevision: review.expectedRevision ?? review.revision
      });
    },
    async upsertProgress(entry) {
      await pool.query(`
        INSERT INTO media_progress (media_id, discord_user_id, chapter_label, position_ratio, bookmark_json, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE chapter_label = VALUES(chapter_label), position_ratio = VALUES(position_ratio),
        bookmark_json = VALUES(bookmark_json), updated_at = NOW()
      `, [entry.mediaId, entry.discordUserId, entry.chapterLabel, entry.positionRatio, entry.bookmark ? JSON.stringify(entry.bookmark) : null]);
      return entry;
    },
    async getProgressByUser(discordUserId) {
      const [rows] = await pool.query("SELECT * FROM media_progress WHERE discord_user_id = ? ORDER BY updated_at DESC", [discordUserId]);
      return rows.map((row) => ({
        mediaId: row.media_id,
        discordUserId: row.discord_user_id,
        chapterLabel: row.chapter_label,
        positionRatio: row.position_ratio,
        bookmark: parseJsonColumn(row.bookmark_json),
        updatedAt: row.updated_at.toISOString()
      }));
    },
    async deleteProgress(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      const [existingRows] = await pool.query(
        "SELECT * FROM media_progress WHERE discord_user_id = ? AND media_id = ?",
        [normalizedUserId, normalizedMediaId]
      );
      await pool.query("DELETE FROM media_progress WHERE discord_user_id = ? AND media_id = ?", [normalizedUserId, normalizedMediaId]);
      const row = existingRows[0] || null;
      return {
        removed: Boolean(row),
        progress: row
          ? {
            mediaId: row.media_id,
            discordUserId: row.discord_user_id,
            chapterLabel: row.chapter_label,
            positionRatio: Number(row.position_ratio),
            bookmark: parseJsonColumn(row.bookmark_json, null),
            updatedAt: row.updated_at.toISOString()
          }
          : null
      };
    },
    async getReadStateByUser(discordUserId, mediaId = "") {
      const normalizedMediaId = normalizeString(mediaId);
      const titleWhereSql = normalizedMediaId ? "WHERE discord_user_id = ? AND media_id = ?" : "WHERE discord_user_id = ?";
      const titleParams = normalizedMediaId ? [discordUserId, normalizedMediaId] : [discordUserId];
      const chapterWhereSql = normalizedMediaId ? "WHERE discord_user_id = ? AND media_id = ?" : "WHERE discord_user_id = ?";
      const chapterParams = normalizedMediaId ? [discordUserId, normalizedMediaId] : [discordUserId];
      const [titleRows, chapterRows] = await Promise.all([
        pool.query(`SELECT * FROM media_title_state ${titleWhereSql} ORDER BY updated_at DESC`, titleParams),
        pool.query(`SELECT * FROM media_chapter_reads ${chapterWhereSql} ORDER BY updated_at DESC`, chapterParams)
      ]);
      return {
        titleStates: titleRows[0].map((row) => ({
          mediaId: row.media_id,
          discordUserId: row.discord_user_id,
          startedAt: row.started_at ? row.started_at.toISOString() : null,
          completedAt: row.completed_at ? row.completed_at.toISOString() : null,
          updatedAt: row.updated_at.toISOString()
        })),
        chapterReads: chapterRows[0].map((row) => ({
          mediaId: row.media_id,
          chapterId: row.chapter_id,
          discordUserId: row.discord_user_id,
          readAt: row.read_at.toISOString(),
          updatedAt: row.updated_at.toISOString()
        }))
      };
    },
    async markTitleRead(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      const chapterIds = Array.from(new Set((Array.isArray(payload.chapterIds) ? payload.chapterIds : [])
        .map((chapterId) => normalizeString(chapterId))
        .filter(Boolean)));
      const startedAt = payload.startedAt || nowIso();
      const completedAt = payload.completedAt || nowIso();
      return withTransaction(async (connection) => {
        await connection.query("DELETE FROM media_chapter_reads WHERE discord_user_id = ? AND media_id = ?", [normalizedUserId, normalizedMediaId]);
        for (const chapterId of chapterIds) {
          await connection.query(`
            INSERT INTO media_chapter_reads (media_id, chapter_id, discord_user_id, read_at, updated_at)
            VALUES (?, ?, ?, ?, NOW())
          `, [normalizedMediaId, chapterId, normalizedUserId, toMysqlDateTime(completedAt, toMysqlDateTime(nowIso()))]);
        }
        await connection.query(`
          INSERT INTO media_title_state (media_id, discord_user_id, started_at, completed_at, updated_at)
          VALUES (?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE started_at = VALUES(started_at), completed_at = VALUES(completed_at), updated_at = NOW()
        `, [
          normalizedMediaId,
          normalizedUserId,
          toMysqlDateTime(startedAt, toMysqlDateTime(nowIso())),
          toMysqlDateTime(completedAt, toMysqlDateTime(nowIso()))
        ]);
        return this.getReadStateByUser(normalizedUserId, normalizedMediaId);
      });
    },
    async markTitleUnread(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      return withTransaction(async (connection) => {
        await connection.query("DELETE FROM media_chapter_reads WHERE discord_user_id = ? AND media_id = ?", [normalizedUserId, normalizedMediaId]);
        await connection.query("DELETE FROM media_title_state WHERE discord_user_id = ? AND media_id = ?", [normalizedUserId, normalizedMediaId]);
        await connection.query("DELETE FROM media_progress WHERE discord_user_id = ? AND media_id = ?", [normalizedUserId, normalizedMediaId]);
        return this.getReadStateByUser(normalizedUserId, normalizedMediaId);
      });
    },
    async markChapterRead(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      const normalizedChapterId = normalizeString(payload.chapterId);
      const readAt = payload.readAt || nowIso();
      const startedAt = payload.startedAt || nowIso();
      return withTransaction(async (connection) => {
        await connection.query(`
          INSERT INTO media_chapter_reads (media_id, chapter_id, discord_user_id, read_at, updated_at)
          VALUES (?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE read_at = VALUES(read_at), updated_at = NOW()
        `, [
          normalizedMediaId,
          normalizedChapterId,
          normalizedUserId,
          toMysqlDateTime(readAt, toMysqlDateTime(nowIso()))
        ]);
        await connection.query(`
          INSERT INTO media_title_state (media_id, discord_user_id, started_at, completed_at, updated_at)
          VALUES (?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE started_at = VALUES(started_at), completed_at = VALUES(completed_at), updated_at = NOW()
        `, [
          normalizedMediaId,
          normalizedUserId,
          toMysqlDateTime(startedAt, toMysqlDateTime(nowIso())),
          toMysqlDateTime(payload.completedAt)
        ]);
        return this.getReadStateByUser(normalizedUserId, normalizedMediaId);
      });
    },
    async markChapterUnread(payload = {}) {
      const normalizedUserId = normalizeString(payload.discordUserId);
      const normalizedMediaId = normalizeString(payload.mediaId);
      const normalizedChapterId = normalizeString(payload.chapterId);
      const startedAt = payload.startedAt || nowIso();
      return withTransaction(async (connection) => {
        await connection.query(`
          DELETE FROM media_chapter_reads
          WHERE media_id = ? AND chapter_id = ? AND discord_user_id = ?
        `, [
          normalizedMediaId,
          normalizedChapterId,
          normalizedUserId
        ]);
        await connection.query(`
          INSERT INTO media_title_state (media_id, discord_user_id, started_at, completed_at, updated_at)
          VALUES (?, ?, ?, NULL, NOW())
          ON DUPLICATE KEY UPDATE started_at = VALUES(started_at), completed_at = NULL, updated_at = NOW()
        `, [
          normalizedMediaId,
          normalizedUserId,
          toMysqlDateTime(startedAt, toMysqlDateTime(nowIso()))
        ]);
        return this.getReadStateByUser(normalizedUserId, normalizedMediaId);
      });
    },
    async previewContentReset() {
      const [[requestRows], [requestWorkLockRows], [progressRows], [titleReadStateRows], [chapterReadStateRows], [followingRows], [bookmarkRows], [ravenTitleRows], [ravenChapterRows], [ravenMetadataMatchRows], [ravenDownloadTaskRows], [ravenJobRows], [ravenJobTaskRows]] = await Promise.all([
        pool.query("SELECT COUNT(*) AS count FROM requests"),
        pool.query("SELECT COUNT(*) AS count FROM request_work_locks"),
        pool.query("SELECT COUNT(*) AS count FROM media_progress"),
        pool.query("SELECT COUNT(*) AS count FROM media_title_state"),
        pool.query("SELECT COUNT(*) AS count FROM media_chapter_reads"),
        pool.query("SELECT COUNT(*) AS count FROM settings WHERE setting_key LIKE 'moon.following.%'"),
        pool.query("SELECT COUNT(*) AS count FROM settings WHERE setting_key LIKE 'moon.reader.bookmarks.%'"),
        pool.query("SELECT COUNT(*) AS count FROM raven_titles"),
        pool.query("SELECT COUNT(*) AS count FROM raven_chapters"),
        pool.query("SELECT COUNT(*) AS count FROM raven_metadata_matches"),
        pool.query("SELECT COUNT(*) AS count FROM raven_download_tasks"),
        pool.query("SELECT COUNT(*) AS count FROM vault_jobs WHERE owner_service = 'scriptarr-raven'"),
        pool.query(`
          SELECT COUNT(*) AS count
          FROM vault_job_tasks tasks
          INNER JOIN vault_jobs jobs ON jobs.job_id = tasks.job_id
          WHERE jobs.owner_service = 'scriptarr-raven'
        `)
      ]);
      return {
        driver: "mysql",
        counts: {
          requests: Number(requestRows[0]?.count || 0),
          requestWorkLocks: Number(requestWorkLockRows[0]?.count || 0),
          progress: Number(progressRows[0]?.count || 0),
          titleReadStates: Number(titleReadStateRows[0]?.count || 0),
          chapterReadStates: Number(chapterReadStateRows[0]?.count || 0),
          followingSettings: Number(followingRows[0]?.count || 0),
          bookmarkSettings: Number(bookmarkRows[0]?.count || 0),
          ravenTitles: Number(ravenTitleRows[0]?.count || 0),
          ravenChapters: Number(ravenChapterRows[0]?.count || 0),
          ravenMetadataMatches: Number(ravenMetadataMatchRows[0]?.count || 0),
          ravenDownloadTasks: Number(ravenDownloadTaskRows[0]?.count || 0),
          ravenJobs: Number(ravenJobRows[0]?.count || 0),
          ravenJobTasks: Number(ravenJobTaskRows[0]?.count || 0)
        }
      };
    },
    async executeContentReset() {
      const preview = await this.previewContentReset();
      await withTransaction(async (connection) => {
        await connection.query("DELETE FROM requests");
        await connection.query("DELETE FROM request_work_locks");
        await connection.query("DELETE FROM media_progress");
        await connection.query("DELETE FROM media_title_state");
        await connection.query("DELETE FROM media_chapter_reads");
        for (const prefix of CONTENT_RESET_SETTING_PREFIXES) {
          await connection.query("DELETE FROM settings WHERE setting_key LIKE ?", [`${prefix}%`]);
        }
        await connection.query("DELETE FROM raven_chapters");
        await connection.query("DELETE FROM raven_metadata_matches");
        await connection.query("DELETE FROM raven_download_tasks");
        await connection.query("DELETE FROM raven_titles");
        await connection.query(`
          DELETE tasks
          FROM vault_job_tasks tasks
          INNER JOIN vault_jobs jobs ON jobs.job_id = tasks.job_id
          WHERE jobs.owner_service = 'scriptarr-raven'
        `);
        await connection.query("DELETE FROM vault_jobs WHERE owner_service = 'scriptarr-raven'");
      });
      return {
        driver: "mysql",
        counts: preview.counts
      };
    },
    async listRavenTitles() {
      const [titleRows] = await pool.query("SELECT * FROM raven_titles ORDER BY title ASC");
      if (!titleRows.length) {
        return [];
      }
      const [chapterRows] = await pool.query("SELECT * FROM raven_chapters");
      const chaptersByTitle = new Map();
      for (const row of chapterRows) {
        if (!chaptersByTitle.has(row.title_id)) {
          chaptersByTitle.set(row.title_id, []);
        }
        chaptersByTitle.get(row.title_id).push(toRavenChapter(row));
      }
      return titleRows.map((row) => toRavenTitle(row, chaptersByTitle.get(row.title_id) || []));
    },
    async listRavenTitleCards(query = {}) {
      const sort = normalizeCardSort(query.sort);
      const orderBy = sort === "recent"
        ? "updated_at DESC, title ASC, title_id ASC"
        : "title ASC, title_id ASC";
      const q = normalizeScalarString(query.q || query.query).toLowerCase();
      const type = normalizeTypeSlug(query.type || "", "");
      const letter = normalizeCardLetter(query.letter);
      const exactIds = normalizeCardIds(query.ids);
      const pageSize = parseCardPageSize(query.pageSize);
      const cursor = parseCardCursor(query.cursor);
      const whereClauses = [];
      const whereParams = [];
      const cardColumns = `
        title_id, title, media_type, library_type_label, library_type_slug, status_name, latest_chapter,
        cover_accent, summary, release_label, chapter_count, chapters_downloaded, author_name,
        tags_json, aliases_json, metadata_provider, metadata_matched_at, cover_url,
        quality_status, clean_chapter_count, partial_chapter_count, missing_content_count, quality_summary, updated_at
      `;
      const toTitleCardRow = (row) => toRavenTitleCard({
        id: row.title_id,
        title: row.title,
        mediaType: row.media_type,
        libraryTypeLabel: row.library_type_label,
        libraryTypeSlug: row.library_type_slug,
        status: row.status_name,
        latestChapter: row.latest_chapter,
        coverAccent: row.cover_accent,
        summary: row.summary,
        releaseLabel: row.release_label,
        chapterCount: row.chapter_count,
        chaptersDownloaded: row.chapters_downloaded,
        author: row.author_name,
        tags: parseJsonColumn(row.tags_json, []),
        aliases: parseJsonColumn(row.aliases_json, []),
        metadataProvider: row.metadata_provider,
        metadataMatchedAt: row.metadata_matched_at ? row.metadata_matched_at.toISOString() : null,
        coverUrl: row.cover_url,
        qualityStatus: row.quality_status,
        cleanChapterCount: row.clean_chapter_count,
        partialChapterCount: row.partial_chapter_count,
        missingContentCount: row.missing_content_count,
        qualitySummary: row.quality_summary,
        updatedAt: row.updated_at ? row.updated_at.toISOString() : null
      });

      if (type) {
        whereClauses.push("LOWER(COALESCE(NULLIF(library_type_slug, ''), media_type)) = ?");
        whereParams.push(type);
      }
      if (exactIds.length) {
        whereClauses.push(`title_id IN (${exactIds.map(() => "?").join(", ")})`);
        whereParams.push(...exactIds);
      }
      if (q) {
        const pattern = `%${q}%`;
        whereClauses.push(`(
          LOWER(title) LIKE ?
          OR LOWER(COALESCE(library_type_label, '')) LIKE ?
          OR LOWER(COALESCE(library_type_slug, '')) LIKE ?
          OR LOWER(media_type) LIKE ?
          OR LOWER(status_name) LIKE ?
          OR LOWER(COALESCE(author_name, '')) LIKE ?
          OR LOWER(CAST(tags_json AS CHAR)) LIKE ?
          OR LOWER(CAST(aliases_json AS CHAR)) LIKE ?
        )`);
        whereParams.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
      }

      const baseWhereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
      const [countRows] = await pool.query(`
        SELECT title, COALESCE(NULLIF(library_type_slug, ''), media_type) AS type_slug
        FROM raven_titles
        ${baseWhereSql}
      `, whereParams);
      const byLetter = {"#": 0};
      const byType = {};
      for (let index = 0; index < 26; index += 1) {
        byLetter[String.fromCharCode(65 + index)] = 0;
      }
      for (const row of countRows) {
        const resolvedLetter = resolveCardLetter(row.title);
        byLetter[resolvedLetter] = (byLetter[resolvedLetter] || 0) + 1;
        const resolvedType = normalizeTypeSlug(row.type_slug || "manga");
        byType[resolvedType] = (byType[resolvedType] || 0) + 1;
      }

      const pageWhereClauses = [...whereClauses];
      const pageWhereParams = [...whereParams];
      const pageOrderParams = [];
      const letterTotal = letter
        ? countRows.filter((row) => resolveCardLetter(row.title) === letter).length
        : countRows.length;
      if (letter) {
        if (letter === "#") {
          pageWhereClauses.push("UPPER(LEFT(TRIM(title), 1)) NOT BETWEEN 'A' AND 'Z'");
        } else {
          pageWhereClauses.push("UPPER(LEFT(TRIM(title), 1)) = ?");
          pageWhereParams.push(letter);
        }
      }
      const pageWhereSql = pageWhereClauses.length ? `WHERE ${pageWhereClauses.join(" AND ")}` : "";
      const resolvedOrderBy = exactIds.length
        ? `CASE title_id ${exactIds.map(() => "WHEN ? THEN ?").join(" ")} ELSE ? END`
        : orderBy;
      if (exactIds.length) {
        exactIds.forEach((id, index) => {
          pageOrderParams.push(id, index);
        });
        pageOrderParams.push(exactIds.length);
      }
      const [titleRows] = await pool.query(`
        SELECT ${cardColumns}
        FROM raven_titles
        ${pageWhereSql}
        ORDER BY ${resolvedOrderBy}
        LIMIT ? OFFSET ?
      `, [...pageWhereParams, ...pageOrderParams, pageSize, cursor]);
      const titles = titleRows.map(toTitleCardRow);
      const nextOffset = cursor + titles.length;
      return {
        titles,
        counts: {total: countRows.length, byLetter, byType},
        filters: {q, type, letter, ids: exactIds, pageSize, sort},
        pageInfo: {
          cursor: String(cursor),
          nextCursor: nextOffset < letterTotal ? String(nextOffset) : "",
          hasMore: nextOffset < letterTotal,
          pageSize,
          total: letterTotal
        }
      };
    },
    async getRavenTitle(titleId) {
      const [titleRows] = await pool.query("SELECT * FROM raven_titles WHERE title_id = ? LIMIT 1", [titleId]);
      if (!titleRows[0]) {
        return null;
      }
      const [chapterRows] = await pool.query("SELECT * FROM raven_chapters WHERE title_id = ?", [titleId]);
      return toRavenTitle(titleRows[0], chapterRows.map(toRavenChapter));
    },
    async upsertRavenTitle(title) {
      await pool.query(`
        INSERT INTO raven_titles (
          title_id, title, media_type, library_type_label, library_type_slug, status_name, latest_chapter, cover_accent, summary, release_label,
          chapter_count, chapters_downloaded, author_name, tags_json, aliases_json, relations_json,
          metadata_provider, metadata_matched_at, source_url, cover_url, working_root, download_root,
          quality_status, clean_chapter_count, partial_chapter_count, missing_content_count, quality_summary, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          media_type = VALUES(media_type),
          library_type_label = VALUES(library_type_label),
          library_type_slug = VALUES(library_type_slug),
          status_name = VALUES(status_name),
          latest_chapter = VALUES(latest_chapter),
          cover_accent = VALUES(cover_accent),
          summary = VALUES(summary),
          release_label = VALUES(release_label),
          chapter_count = VALUES(chapter_count),
          chapters_downloaded = VALUES(chapters_downloaded),
          author_name = VALUES(author_name),
          tags_json = VALUES(tags_json),
          aliases_json = VALUES(aliases_json),
          relations_json = VALUES(relations_json),
          metadata_provider = VALUES(metadata_provider),
          metadata_matched_at = VALUES(metadata_matched_at),
          source_url = VALUES(source_url),
          cover_url = VALUES(cover_url),
          working_root = VALUES(working_root),
          download_root = VALUES(download_root),
          quality_status = VALUES(quality_status),
          clean_chapter_count = VALUES(clean_chapter_count),
          partial_chapter_count = VALUES(partial_chapter_count),
          missing_content_count = VALUES(missing_content_count),
          quality_summary = VALUES(quality_summary),
          updated_at = NOW()
      `, [
        title.id,
        title.title,
        title.mediaType || "manga",
        title.libraryTypeLabel || title.mediaType || "manga",
        title.libraryTypeSlug || title.mediaType || "manga",
        title.status || "active",
        title.latestChapter || "",
        title.coverAccent || "#4f8f88",
        title.summary || "",
        title.releaseLabel || "",
        Number.parseInt(String(title.chapterCount || 0), 10) || 0,
        Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0,
        title.author || "",
        JSON.stringify(Array.isArray(title.tags) ? title.tags : []),
        JSON.stringify(Array.isArray(title.aliases) ? title.aliases : []),
        JSON.stringify(Array.isArray(title.relations) ? title.relations : []),
        title.metadataProvider || null,
        toMysqlDateTime(title.metadataMatchedAt),
        title.sourceUrl || null,
        title.coverUrl || null,
        title.workingRoot || null,
        title.downloadRoot || null,
        normalizeRavenQualityStatus(title.qualityStatus),
        Number.parseInt(String(title.cleanChapterCount || 0), 10) || 0,
        Number.parseInt(String(title.partialChapterCount || 0), 10) || 0,
        Number.parseInt(String(title.missingContentCount || 0), 10) || 0,
        title.qualitySummary || null
      ]);
      return this.getRavenTitle(title.id);
    },
    async replaceRavenChapters(titleId, chapters) {
      return withTransaction(async (connection) => {
        await connection.query("DELETE FROM raven_chapters WHERE title_id = ?", [titleId]);
        for (const chapter of sortRavenChapters(Array.isArray(chapters) ? chapters : [])) {
          const normalizedChapter = normalizeRavenChapter(chapter);
          await connection.query(`
            INSERT INTO raven_chapters (
              title_id, chapter_id, label_name, chapter_number, page_count, release_date, is_available, archive_path, source_url,
              quality_status, expected_page_count, missing_page_count, missing_pages_json, quality_notes_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          `, [
            titleId,
            normalizedChapter.id,
            normalizedChapter.label || normalizedChapter.id,
            normalizedChapter.chapterNumber || null,
            Number.parseInt(String(normalizedChapter.pageCount || 0), 10) || 0,
            normalizedChapter.releaseDate || null,
            normalizedChapter.available === false ? 0 : 1,
            normalizedChapter.archivePath || null,
            normalizedChapter.sourceUrl || null,
            normalizeRavenQualityStatus(normalizedChapter.qualityStatus),
            Number.parseInt(String(normalizedChapter.expectedPageCount || 0), 10) || 0,
            Number.parseInt(String(normalizedChapter.missingPageCount || 0), 10) || 0,
            JSON.stringify(normalizedChapter.missingPages),
            JSON.stringify(normalizedChapter.qualityNotes)
          ]);
        }
        const [rows] = await connection.query("SELECT * FROM raven_chapters WHERE title_id = ?", [titleId]);
        return rows.map(toRavenChapter);
      });
    },
    async listRavenDownloadTasks() {
      const [rows] = await pool.query("SELECT * FROM raven_download_tasks ORDER BY queued_at DESC");
      return rows.map((row) => ({
        taskId: row.task_id,
        titleId: row.title_id,
        titleName: row.title_name,
        titleUrl: row.title_url,
        providerId: row.provider_id,
        requestId: row.request_id == null ? "" : String(row.request_id),
        requestType: row.request_type,
        requestedBy: row.requested_by,
        status: row.status_name,
        message: row.message_text,
        percent: row.percent_value,
        details: parseJsonColumn(row.details_json, {}),
        queuedAt: row.queued_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      }));
    },
    async upsertRavenDownloadTask(task) {
      await pool.query(`
        INSERT INTO raven_download_tasks (
          task_id, title_id, title_name, title_url, provider_id, request_id, request_type, requested_by, status_name, message_text, percent_value, details_json, queued_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          title_id = VALUES(title_id),
          title_name = VALUES(title_name),
          title_url = VALUES(title_url),
          provider_id = VALUES(provider_id),
          request_id = VALUES(request_id),
          request_type = VALUES(request_type),
          requested_by = VALUES(requested_by),
          status_name = VALUES(status_name),
          message_text = VALUES(message_text),
          percent_value = VALUES(percent_value),
          details_json = VALUES(details_json),
          queued_at = VALUES(queued_at),
          updated_at = NOW()
      `, [
        task.taskId,
        task.titleId || null,
        task.titleName,
        task.titleUrl,
        task.providerId || null,
        task.requestId || null,
        task.requestType || "manga",
        task.requestedBy || "scriptarr",
        task.status || "queued",
        task.message || "",
        Number.parseInt(String(task.percent || 0), 10) || 0,
        JSON.stringify(task.details || {}),
        toMysqlDateTime(task.queuedAt, toMysqlDateTime(nowIso()))
      ]);
      const [rows] = await pool.query("SELECT * FROM raven_download_tasks WHERE task_id = ? LIMIT 1", [task.taskId]);
      const row = rows[0];
      return {
        taskId: row.task_id,
        titleId: row.title_id,
        titleName: row.title_name,
        titleUrl: row.title_url,
        providerId: row.provider_id,
        requestId: row.request_id == null ? "" : String(row.request_id),
        requestType: row.request_type,
        requestedBy: row.requested_by,
        status: row.status_name,
        message: row.message_text,
        percent: row.percent_value,
        details: parseJsonColumn(row.details_json, {}),
        queuedAt: row.queued_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      };
    },
    async deleteRavenDownloadTask(taskId) {
      const [result] = await pool.query("DELETE FROM raven_download_tasks WHERE task_id = ?", [taskId]);
      return {removed: Number(result.affectedRows || 0)};
    },
    async getRavenMetadataMatch(titleId) {
      const [rows] = await pool.query("SELECT * FROM raven_metadata_matches WHERE title_id = ? LIMIT 1", [titleId]);
      const row = rows[0];
      return row
        ? {
          titleId: row.title_id,
          provider: row.provider_id,
          providerSeriesId: row.provider_series_id,
          details: parseJsonColumn(row.details_json, {}),
          updatedAt: row.updated_at.toISOString()
        }
        : null;
    },
    async setRavenMetadataMatch(titleId, value) {
      await pool.query(`
        INSERT INTO raven_metadata_matches (title_id, provider_id, provider_series_id, details_json, updated_at)
        VALUES (?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          provider_id = VALUES(provider_id),
          provider_series_id = VALUES(provider_series_id),
          details_json = VALUES(details_json),
          updated_at = NOW()
      `, [
        titleId,
        value.provider || "",
        value.providerSeriesId || "",
        JSON.stringify(value.details || {})
      ]);
      return this.getRavenMetadataMatch(titleId);
    },
    async listJobs(filters = {}) {
      const params = [];
      const clauses = [];
      if (filters.ownerService) {
        clauses.push("owner_service = ?");
        params.push(filters.ownerService);
      }
      if (filters.kind) {
        clauses.push("job_kind = ?");
        params.push(filters.kind);
      }
      if (filters.status) {
        clauses.push("status_name = ?");
        params.push(filters.status);
      }
      const whereSql = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await pool.query(
        `SELECT * FROM vault_jobs${whereSql} ORDER BY updated_at DESC, created_at DESC`,
        params
      );
      return rows.map(toVaultJob);
    },
    async getJob(jobId) {
      const [rows] = await pool.query("SELECT * FROM vault_jobs WHERE job_id = ? LIMIT 1", [jobId]);
      return rows[0] ? toVaultJob(rows[0]) : null;
    },
    async upsertJob(job) {
      const normalized = normalizeVaultJob(job);
      await pool.query(`
        INSERT INTO vault_jobs (
          job_id, job_kind, owner_service, status_name, label_text, requested_by, payload_json, result_json,
          created_at, started_at, finished_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          job_kind = VALUES(job_kind),
          owner_service = VALUES(owner_service),
          status_name = VALUES(status_name),
          label_text = VALUES(label_text),
          requested_by = VALUES(requested_by),
          payload_json = VALUES(payload_json),
          result_json = VALUES(result_json),
          created_at = VALUES(created_at),
          started_at = VALUES(started_at),
          finished_at = VALUES(finished_at),
          updated_at = VALUES(updated_at)
      `, [
        normalized.jobId,
        normalized.kind,
        normalized.ownerService,
        normalized.status,
        normalized.label || null,
        normalized.requestedBy || null,
        JSON.stringify(normalized.payload || {}),
        JSON.stringify(normalized.result || {}),
        toMysqlDateTime(normalized.createdAt, toMysqlDateTime(nowIso())),
        toMysqlDateTime(normalized.startedAt),
        toMysqlDateTime(normalized.finishedAt),
        toMysqlDateTime(normalized.updatedAt, toMysqlDateTime(nowIso()))
      ]);
      return this.getJob(normalized.jobId);
    },
    async listJobTasks(filters = {}) {
      const params = [];
      const clauses = [];
      if (filters.jobId) {
        clauses.push("job_id = ?");
        params.push(filters.jobId);
      }
      if (filters.status) {
        clauses.push("status_name = ?");
        params.push(filters.status);
      }
      const whereSql = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await pool.query(
        `SELECT * FROM vault_job_tasks${whereSql} ORDER BY sort_order ASC, updated_at ASC, created_at ASC`,
        params
      );
      return rows.map(toVaultJobTask);
    },
    async upsertJobTask(jobId, task) {
      const normalized = normalizeVaultJobTask(jobId, task);
      await pool.query(`
        INSERT INTO vault_job_tasks (
          task_id, job_id, task_key, label_text, status_name, message_text, percent_value, sort_order,
          payload_json, result_json, created_at, started_at, finished_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          job_id = VALUES(job_id),
          task_key = VALUES(task_key),
          label_text = VALUES(label_text),
          status_name = VALUES(status_name),
          message_text = VALUES(message_text),
          percent_value = VALUES(percent_value),
          sort_order = VALUES(sort_order),
          payload_json = VALUES(payload_json),
          result_json = VALUES(result_json),
          created_at = VALUES(created_at),
          started_at = VALUES(started_at),
          finished_at = VALUES(finished_at),
          updated_at = VALUES(updated_at)
      `, [
        normalized.taskId,
        normalized.jobId,
        normalized.taskKey || null,
        normalized.label || null,
        normalized.status,
        normalized.message || null,
        normalized.percent,
        normalized.sortOrder,
        JSON.stringify(normalized.payload || {}),
        JSON.stringify(normalized.result || {}),
        toMysqlDateTime(normalized.createdAt, toMysqlDateTime(nowIso())),
        toMysqlDateTime(normalized.startedAt),
        toMysqlDateTime(normalized.finishedAt),
        toMysqlDateTime(normalized.updatedAt, toMysqlDateTime(nowIso()))
      ]);
      const [rows] = await pool.query("SELECT * FROM vault_job_tasks WHERE task_id = ? LIMIT 1", [normalized.taskId]);
      return rows[0] ? toVaultJobTask(rows[0]) : null;
    }
  };
};

export const createStore = (config) => createCachedStore(config.driver === "mysql" ? createMysqlStore(config) : createMemoryStore());
