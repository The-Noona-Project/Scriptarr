/**
 * @file Scriptarr Sage module: services/sage/lib/registerMoonV3Routes.mjs.
 */
import {createHash, randomBytes} from "node:crypto";
import {Readable} from "node:stream";
import {ADMIN_ACCESS_DOMAINS} from "@scriptarr/access";
import {hasDomainAccess, hasPermission} from "./auth.mjs";
import {
  ADMIN_TOAST_GLOBAL_KEY,
  MOON_BRANDING_KEY,
  adminToastUserKey,
  defaultAdminToastSettings,
  mergeAdminToastSettings,
  normalizeAdminToastSettings,
  normalizeMoonBrandingSettings,
  publicMoonBranding,
  selectMoonLogoVariant
} from "./adminUiSettings.mjs";
import {appendDurableEvent, appendUserEvent, buildServiceActor, buildUserActor} from "./adminEvents.mjs";
import {buildIntakeSelection, evaluateSelectionAgainstGuardState} from "./requestSelectionGuards.mjs";
import {
  buildRequestRevisionConflictPayload,
  buildRequestWorkConflictPayload,
  isRequestRevisionConflictError,
  isRequestWorkConflictError,
  normalizeExpectedRequestRevision
} from "./requestConflict.mjs";
import {buildAdminQueuePayload} from "./buildAdminQueuePayload.mjs";
import {
  RAVEN_DOWNLOAD_RUNTIME_KEY,
  normalizeRavenDownloadRuntimeSettings,
  validateActiveTitleDownloads
} from "./ravenDownloadRuntimeSettings.mjs";
import {buildAdminCalendarPayload} from "./adminCalendar.mjs";
import {buildMoonHomePayload} from "./buildMoonHomePayload.mjs";
import {buildMoonProfilePayload} from "./buildMoonProfilePayload.mjs";
import {buildSystemStatusPayload} from "./systemStatusRegistry.mjs";
import {
  buildToolPayload,
  getProposal,
  markToolUsed,
  proposeAiAction,
  readAiProposals,
  toolForId,
  updateProposalStatus,
  writeAiToolSettings
} from "./aiTools.mjs";
import {
  buildMoonUserLibraryState,
  getTagPreference,
  normalizeTagPreferenceStore,
  setTagPreference
} from "./moonUserState.mjs";
import {
  mergeReaderPreferences,
  resolveReaderPreferences
} from "./moonReaderPreferences.mjs";
import {
  attachRequestWaitlistEntry,
  buildActiveRequestDuplicatePayload,
  buildLibraryDuplicatePayload,
  canCancelRequest,
  canEditRequestNotes,
  normalizeDownloadOption,
  resolveRequestTab,
  selectAutoApproveDownload
} from "./requestFlow.mjs";
import {
  PORTAL_DISCORD_KEY,
  knownPortalDiscordCommands,
  normalizePortalDiscordSettings,
  renderPortalOnboardingTemplate
} from "./portalDiscordSettings.mjs";
import {buildNoonaMemoryAdminPayload, clearNoonaMemory} from "./noonaChatMemory.mjs";
import {createPortalTriviaService} from "./portalTrivia.mjs";

const RAVEN_VPN_KEY = "raven.vpn";
const RAVEN_VPN_PASSWORD_SECRET = "raven.vpn.piaPassword";
const RAVEN_METADATA_KEY = "raven.metadata.providers";
const RAVEN_DOWNLOAD_PROVIDERS_KEY = "raven.download.providers";
const SAGE_REQUESTS_KEY = "sage.requests";
const MOON_PUBLIC_API_KEY = "moon.publicApi";
const API_KEY_SECRET_PREFIX = "scr";

const generateApiKeySecret = (kind = "key") =>
  `${API_KEY_SECRET_PREFIX}_${normalizeString(kind, "key")}_${randomBytes(24).toString("hex")}`;

const hashApiKeySecret = (value) => createHash("sha256").update(normalizeString(value)).digest("hex");

const keyPrefixForSecret = (value) => normalizeString(value).slice(0, 18);

const sanitizeApiKeyRecord = (entry = {}) => ({
  id: normalizeString(entry.id),
  name: normalizeString(entry.name, "API key"),
  kind: normalizeString(entry.kind, "system"),
  enabled: entry.enabled !== false,
  keyPrefix: normalizeString(entry.keyPrefix),
  ownerDiscordUserId: normalizeString(entry.ownerDiscordUserId),
  createdBy: entry.createdBy && typeof entry.createdBy === "object" ? entry.createdBy : {},
  groupIds: normalizeArray(entry.groupIds).map((groupId) => normalizeString(groupId)).filter(Boolean),
  lastUsedAt: parseIso(entry.lastUsedAt),
  createdAt: parseIso(entry.createdAt),
  updatedAt: parseIso(entry.updatedAt),
  revokedAt: parseIso(entry.revokedAt)
});

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const EVENT_DOMAIN_ACCESS = Object.freeze({
  auth: "users",
  users: "users",
  access: "users",
  overview: "overview",
  library: "library",
  add: "add",
  import: "import",
  calendar: "calendar",
  mediamanagement: "mediamanagement",
  activity: "activity",
  wanted: "wanted",
  requests: "requests",
  discord: "discord",
  ai: "ai",
  settings: "settings",
  database: "database",
  system: "system",
  publicapi: "publicapi",
  follow: "library",
  reader: "library"
});
const ORACLE_ADMIN_TEST_TIMEOUT_MS = 75000;
const LIBRARY_CARD_PAGE_SIZE_DEFAULT = 60;
const LIBRARY_CARD_PAGE_SIZE_MAX = 100;

const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

const parseIso = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const toTitleSummary = (title = {}) => ({
  id: normalizeString(title.id),
  title: normalizeString(title.title, "Untitled"),
  mediaType: normalizeString(title.mediaType, "manga"),
  libraryTypeLabel: normalizeString(title.libraryTypeLabel, normalizeString(title.mediaType, "Manga")),
  libraryTypeSlug: normalizeTypeSlug(title.libraryTypeSlug || title.mediaType),
  status: normalizeString(title.status, "active"),
  latestChapter: normalizeString(title.latestChapter, "Unknown"),
  coverAccent: normalizeString(title.coverAccent, "#4f8f88"),
  coverUrl: normalizeString(title.coverUrl),
  summary: normalizeString(title.summary),
  releaseLabel: normalizeString(title.releaseLabel),
  chapterCount: Number.parseInt(String(title.chapterCount || 0), 10) || 0,
  chaptersDownloaded: Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0,
  author: normalizeString(title.author),
  tags: normalizeArray(title.tags),
  aliases: normalizeArray(title.aliases),
  metadataProvider: normalizeString(title.metadataProvider),
  metadataMatchedAt: parseIso(title.metadataMatchedAt),
  updatedAt: parseIso(title.updatedAt),
  relations: normalizeArray(title.relations),
  sourceUrl: normalizeString(title.sourceUrl),
  workingRoot: normalizeString(title.workingRoot),
  downloadRoot: normalizeString(title.downloadRoot),
  chapters: normalizeArray(title.chapters).map(toChapterSummary)
});

const toChapterSummary = (chapter = {}) => ({
  id: normalizeString(chapter.id),
  label: normalizeString(chapter.label, "Chapter"),
  chapterNumber: normalizeString(chapter.chapterNumber),
  pageCount: Number.parseInt(String(chapter.pageCount || 0), 10) || 0,
  releaseDate: normalizeString(chapter.releaseDate),
  available: chapter.available !== false,
  archivePath: normalizeString(chapter.archivePath),
  sourceUrl: normalizeString(chapter.sourceUrl),
  updatedAt: parseIso(chapter.updatedAt)
});

const compareReaderChaptersByNumber = (left = {}, right = {}) => {
  const leftNumber = Number.parseFloat(String(left.chapterNumber || ""));
  const rightNumber = Number.parseFloat(String(right.chapterNumber || ""));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return normalizeString(left.chapterNumber || left.label || left.id).localeCompare(
    normalizeString(right.chapterNumber || right.label || right.id),
    "en",
    {numeric: true, sensitivity: "base"}
  );
};

const resolveReaderAdjacentChapterIds = (chapters = [], chapterId = "") => {
  const currentId = normalizeString(chapterId);
  const readableChapters = normalizeArray(chapters)
    .filter((entry) => entry?.available !== false && normalizeString(entry?.id))
    .sort(compareReaderChaptersByNumber);
  const chapterIndex = readableChapters.findIndex((entry) => normalizeString(entry.id) === currentId);
  if (chapterIndex < 0) {
    return {matched: false, previousChapterId: null, nextChapterId: null};
  }
  return {
    matched: true,
    previousChapterId: normalizeString(readableChapters[chapterIndex - 1]?.id) || null,
    nextChapterId: normalizeString(readableChapters[chapterIndex + 1]?.id) || null
  };
};

const READER_PAGE_DEFAULT_SIZE = 12;
const READER_PAGE_MAX_SIZE = 100;

const stripReaderTitleChapters = (title = {}) => {
  const {chapters: _chapters, ...summary} = title || {};
  return summary;
};

const parseReaderPageSize = (value) => {
  const parsed = Number.parseInt(String(value || READER_PAGE_DEFAULT_SIZE), 10);
  if (!Number.isFinite(parsed)) {
    return READER_PAGE_DEFAULT_SIZE;
  }
  return Math.max(1, Math.min(READER_PAGE_MAX_SIZE, parsed));
};

const parseReaderPageCursor = (value) => {
  const parsed = Number.parseInt(String(value || 0), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

const buildReaderPageRevision = ({title = {}, chapter = {}, pages = []} = {}) => {
  const hash = createHash("sha256");
  hash.update(normalizeString(title.id));
  hash.update("\n");
  hash.update(normalizeString(chapter.id));
  hash.update("\n");
  hash.update(normalizeString(chapter.updatedAt || title.updatedAt));
  hash.update("\n");
  hash.update(normalizeString(chapter.archivePath || chapter.sourceUrl || title.sourceUrl));
  hash.update("\n");
  hash.update(String(normalizeArray(pages).length || chapter.pageCount || 0));
  return hash.digest("hex").slice(0, 12);
};

const buildReaderPageBase = (titleId, chapterId) =>
  `/api/moon/v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/${encodeURIComponent(chapterId)}/page`;

const withReaderPageRevision = (pageBase, index, revision) =>
  `${pageBase}/${encodeURIComponent(String(index))}?rev=${encodeURIComponent(revision)}`;

const toReaderPageRows = ({pages = [], pageBase = "", pageRevision = "", cursor = 0, pageSize = READER_PAGE_DEFAULT_SIZE} = {}) => {
  const rows = normalizeArray(pages);
  const start = Math.max(0, Math.min(parseReaderPageCursor(cursor), rows.length));
  const limit = parseReaderPageSize(pageSize);
  const selected = rows.slice(start, start + limit).map((page, offset) => {
    const pageIndex = Number.parseInt(String(page?.index ?? start + offset), 10);
    const index = Number.isFinite(pageIndex) ? pageIndex : start + offset;
    return {
      ...page,
      index,
      label: normalizeString(page?.label, `Page ${index + 1}`),
      src: withReaderPageRevision(pageBase, index, pageRevision)
    };
  });
  const nextCursor = start + selected.length;
  return {
    pages: selected,
    pageInfo: {
      cursor: String(start),
      nextCursor: nextCursor < rows.length ? String(nextCursor) : "",
      hasMore: nextCursor < rows.length,
      pageSize: limit,
      totalCount: rows.length
    }
  };
};

const toUserChapterRow = (chapter = {}) => ({
  ...toChapterSummary(chapter),
  read: chapter.read === true,
  readAt: parseIso(chapter.readAt),
  qualityStatus: normalizeString(chapter.qualityStatus, "clean"),
  expectedPageCount: Number.parseInt(String(chapter.expectedPageCount || 0), 10) || 0,
  missingPageCount: Number.parseInt(String(chapter.missingPageCount || 0), 10) || 0
});

const truncateText = (value, maxLength = 280) => {
  const normalized = normalizeString(value);
  const limit = Math.max(0, maxLength);
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
};

const compactStringArray = (value, maxItems = 8) => {
  const seen = new Set();
  const entries = [];
  for (const item of normalizeArray(value)) {
    const normalized = normalizeString(item);
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

const toTitleCardSummary = (title = {}) => {
  const id = normalizeString(title.id);
  const coverUrl = normalizeString(title.coverUrl);
  const updatedAt = parseIso(title.updatedAt);
  const revision = createHash("sha1")
    .update([id, coverUrl, updatedAt || "", normalizeString(title.metadataMatchedAt)].join("|"))
    .digest("hex")
    .slice(0, 12);
  return {
    id,
    title: normalizeString(title.title, "Untitled"),
    mediaType: normalizeString(title.mediaType, "manga"),
    libraryTypeLabel: normalizeString(title.libraryTypeLabel, normalizeString(title.mediaType, "Manga")),
    libraryTypeSlug: normalizeTypeSlug(title.libraryTypeSlug || title.mediaType),
    status: normalizeString(title.status, "active"),
    latestChapter: normalizeString(title.latestChapter, "Unknown"),
    coverAccent: normalizeString(title.coverAccent, "#4f8f88"),
    coverUrl,
    coverThumbUrl: id && coverUrl ? `/api/moon/v3/user/covers/${encodeURIComponent(id)}.webp?rev=${revision}` : normalizeString(title.coverThumbUrl),
    coverRevision: revision,
    summary: truncateText(title.summary, 280),
    releaseLabel: normalizeString(title.releaseLabel),
    chapterCount: Number.parseInt(String(title.chapterCount || 0), 10) || 0,
    chaptersDownloaded: Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0,
    author: normalizeString(title.author),
    tags: compactStringArray(title.tags, 8),
    aliases: compactStringArray(title.aliases, 8),
    metadataProvider: normalizeString(title.metadataProvider),
    metadataMatchedAt: parseIso(title.metadataMatchedAt),
    updatedAt,
    qualityStatus: normalizeString(title.qualityStatus, "clean"),
    cleanChapterCount: Number.parseInt(String(title.cleanChapterCount || 0), 10) || 0,
    partialChapterCount: Number.parseInt(String(title.partialChapterCount || 0), 10) || 0,
    missingContentCount: Number.parseInt(String(title.missingContentCount || 0), 10) || 0,
    qualitySummary: truncateText(title.qualitySummary, 180)
  };
};

const toRequestSummary = (request = {}, userIndex = new Map()) => {
  const requester = userIndex.get(String(request.requestedBy || "").trim()) || null;
  const timeline = normalizeArray(request.timeline);
  const details = normalizeObject(request.details, {}) || {};
  const selectedMetadata = normalizeObject(details.selectedMetadata);
  const selectedDownload = normalizeObject(details.selectedDownload);

  return {
    id: request.id,
    source: normalizeString(request.source, "moon"),
    title: normalizeString(request.title, "Untitled request"),
    requestType: normalizeString(request.requestType, "manga"),
    notes: normalizeString(request.notes),
    status: normalizeString(request.status, "pending"),
    moderatorComment: normalizeString(request.moderatorComment),
    revision: Number.parseInt(String(request.revision || 1), 10) || 1,
    createdAt: parseIso(request.createdAt),
    updatedAt: parseIso(request.updatedAt),
    commentCount: timeline.filter((entry) => normalizeString(entry.type) === "comment").length,
    tab: resolveRequestTab(request.status),
    canEditNotes: canEditRequestNotes(request),
    canCancel: canCancelRequest(request),
    timeline,
    availability: normalizeString(details.availability, selectedDownload ? "available" : "unavailable"),
    coverUrl: normalizeString(
      details.coverUrl,
      normalizeString(selectedDownload?.coverUrl, normalizeString(selectedMetadata?.coverUrl))
    ),
    details: {
      query: normalizeString(details.query),
      selectedMetadata,
      selectedDownload,
      sourceFoundAt: parseIso(details.sourceFoundAt),
      sourceFoundOptions: normalizeArray(details.sourceFoundOptions),
      waitlist: normalizeArray(details.waitlist),
      coverUrl: normalizeString(
        details.coverUrl,
        normalizeString(selectedDownload?.coverUrl, normalizeString(selectedMetadata?.coverUrl))
      ),
      requestWorkKey: normalizeString(request.workKey, normalizeString(details.requestWorkKey)),
      requestWorkKind: normalizeString(request.workKeyKind, normalizeString(details.requestWorkKind)),
      jobId: normalizeString(details.jobId),
      taskId: normalizeString(details.taskId)
    },
    workKey: normalizeString(request.workKey, normalizeString(details.requestWorkKey)),
    workKeyKind: normalizeString(request.workKeyKind, normalizeString(details.requestWorkKind)),
    jobId: normalizeString(details.jobId),
    taskId: normalizeString(details.taskId),
    requestedBy: {
      discordUserId: normalizeString(request.requestedBy),
      username: requester?.username || null,
      role: requester?.role || null
    },
    waitlistCount: normalizeArray(details.waitlist).length
  };
};

const buildEventRows = (requests = [], tasks = []) => {
  const requestEvents = requests.flatMap((request) =>
    normalizeArray(request.timeline).map((entry) => ({
      service: "requests",
      type: normalizeString(entry.type, "comment"),
      message: normalizeString(entry.message, "Request updated."),
      actor: normalizeString(entry.actor),
      at: parseIso(entry.at) || request.updatedAt
    }))
  );

  const taskEvents = tasks.map((task) => ({
    service: "raven",
    type: normalizeString(task.status, "queued"),
    message: normalizeString(task.message, "Task updated."),
    actor: normalizeString(task.requestedBy, "raven"),
    at: parseIso(task.updatedAt || task.queuedAt)
  }));

  return [...requestEvents, ...taskEvents]
    .sort((left, right) => Date.parse(right.at || "") - Date.parse(left.at || ""))
    .slice(0, 80);
};

const enrichProgressEntry = (entry = {}, titleIndex = new Map()) => {
  const title = titleIndex.get(normalizeString(entry.mediaId)) || {};
  return {
    ...entry,
    titleId: normalizeString(entry.mediaId),
    title: normalizeString(title.title, normalizeString(entry.mediaId, "Untitled")),
    mediaType: normalizeString(title.mediaType, "manga"),
    libraryTypeLabel: normalizeString(title.libraryTypeLabel, normalizeString(title.mediaType, "Manga")),
    libraryTypeSlug: normalizeTypeSlug(title.libraryTypeSlug || title.mediaType),
    coverAccent: normalizeString(title.coverAccent, "#4f8f88"),
    coverUrl: normalizeString(title.coverUrl),
    latestChapter: normalizeString(title.latestChapter, entry.chapterLabel || "In progress"),
    summary: normalizeString(title.summary),
    tags: normalizeArray(title.tags),
    chapterCount: Number.parseInt(String(title.chapterCount || 0), 10) || 0,
    chaptersDownloaded: Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0,
    updatedAt: parseIso(entry.updatedAt)
  };
};

const readUserScopedSetting = async (vaultClient, prefix, discordUserId, fallback) => {
  const setting = await vaultClient.getSetting(`${prefix}.${discordUserId}`);
  return setting?.value ?? fallback;
};

const writeUserScopedSetting = async (vaultClient, prefix, discordUserId, value) =>
  vaultClient.setSetting(`${prefix}.${discordUserId}`, value);

const normalizeFollowingEntry = (entry = {}) => ({
  ...entry,
  libraryTypeLabel: normalizeString(entry.libraryTypeLabel, normalizeString(entry.mediaType, "Manga")),
  libraryTypeSlug: normalizeTypeSlug(entry.libraryTypeSlug || entry.mediaType)
});

const decorateTitleWithTagPreferences = (title = {}, tagPreferenceStore = {}) => ({
  ...title,
  tagPreferences: normalizeArray(title.tags).map((tag) => ({
    tag,
    preference: getTagPreference(tagPreferenceStore, tag)
  }))
});

const withUser = (requireUser, handler) => async (req, res) => {
  await requireUser(req, res, async () => {
    await handler(req, res);
  });
};

const requireBrowserSession = (req, res) => {
  if (req.authMethod === "api-key") {
    res.status(403).json({error: "API-key authenticated requests cannot manage API keys."});
    return false;
  }
  return true;
};

const withPermission = (requirePermission, permission, handler) => async (req, res) => {
  await requirePermission(permission)(req, res, async () => {
    await handler(req, res);
  });
};

const mergeDisplayStrings = (...values) => {
  const seen = new Set();
  const merged = [];
  for (const value of values.flatMap((entry) => normalizeArray(entry).length ? normalizeArray(entry) : [entry])) {
    const normalized = normalizeString(value);
    if (!normalized) {
      continue;
    }
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    merged.push(normalized);
  }
  return merged;
};

/**
 * Register the Moon v3 broker routes used by both the admin and user Moon apps.
 *
 * @param {import("express").Express} app
 * @param {{
 *   config: Record<string, string>,
 *   logger?: {warn: Function},
 *   vaultClient: ReturnType<import("./vaultClient.mjs").createVaultClient>,
 *   requireUser: ReturnType<import("./auth.mjs").requireSession>,
 *   requirePermission: (permission: string) => import("express").RequestHandler,
 *   requireAdminGrant: (domain: string, level?: "" | "read" | "write" | "root") => import("express").RequestHandler,
 *   readRavenVpnSettings: () => Promise<Record<string, unknown>>,
 *   readRavenNamingSettings: () => Promise<Record<string, unknown>>,
 *   readMetadataProviderSettings: () => Promise<Record<string, unknown>>,
 *   readDownloadProviderSettings: () => Promise<Record<string, unknown>>,
 *   readRavenDownloadRuntimeSettings: () => Promise<Record<string, unknown>>,
 *   readRequestWorkflowSettings: () => Promise<Record<string, unknown>>,
 *   readOracleSettings: () => Promise<Record<string, unknown>>,
 *   readMoonBrandingSettings: () => Promise<Record<string, unknown>>,
 *   readAdminToastSettings: (user: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   readMoonPublicApiSettings: () => Promise<Record<string, unknown>>,
 *   readPortalDiscordSettings: () => Promise<Record<string, unknown>>,
 *   serviceJson: (baseUrl: string, path: string, options?: {method?: string, body?: unknown, headers?: Record<string, string>}) => Promise<{ok: boolean, status: number, payload: any}>,
 *   safeJson: (promise: Promise<unknown>) => Promise<any>
 * }} options
 */
export const registerMoonV3Routes = (app, {
  config,
  logger,
  vaultClient,
  requireUser,
  requirePermission,
  requireAdminGrant,
  readRavenVpnSettings,
  readRavenNamingSettings,
  readMetadataProviderSettings,
  readDownloadProviderSettings,
  readRavenDownloadRuntimeSettings,
  readRequestWorkflowSettings,
  readOracleSettings,
  readMoonBrandingSettings,
  readAdminToastSettings,
  readMoonPublicApiSettings,
  readPortalDiscordSettings,
  serviceJson,
  safeJson,
  systemTaskRuntime,
  persistOracleSettings
}) => {
  const fetchRavenJson = async (path, options = {}) => {
    const result = await serviceJson(config.ravenBaseUrl, path, options);
    if (!result.ok) {
      throw new Error(result.payload?.error || `Raven request failed with status ${result.status}.`);
    }
    return result.payload;
  };

  const loadUserIndex = async () => {
    const users = normalizeArray(await vaultClient.listUsers());
    return new Map(users.map((user) => [String(user.discordUserId || "").trim(), user]));
  };

  const loadLibrary = async () => {
    const payload = await fetchRavenJson("/v1/library");
    return normalizeArray(payload?.titles).map(toTitleSummary);
  };

  const toQueryString = (query = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value != null && normalizeString(value)) {
        params.set(key, String(value));
      }
    }
    return params.toString();
  };

  const loadLibraryCardPage = async (query = {}) => {
    const params = toQueryString({
      ...query,
      view: "card"
    });
    const payload = await fetchRavenJson(`/v1/library${params ? `?${params}` : "?view=card"}`);
    const normalizedPayload = normalizeObject(payload, {}) || {};
    const titles = normalizeArray(payload?.titles).map(toTitleCardSummary);
    return {
      ...normalizedPayload,
      titles,
      counts: normalizeObject(payload?.counts, {}) || buildLibraryCardCounts(titles),
      pageInfo: normalizeObject(payload?.pageInfo, {}) || {
        cursor: "0",
        nextCursor: "",
        hasMore: false,
        pageSize: titles.length,
        total: titles.length
      }
    };
  };

  const normalizeReaderTarget = (target = {}) => {
    const normalized = normalizeObject(target, {}) || {};
    const chapterId = normalizeString(normalized.chapterId);
    if (!chapterId) {
      return null;
    }
    const kind = ["continue", "next-unread", "first"].includes(normalizeString(normalized.kind))
      ? normalizeString(normalized.kind)
      : "first";
    return {
      mediaId: normalizeString(normalized.mediaId),
      chapterId,
      label: normalizeString(normalized.label, "Chapter"),
      chapterNumber: normalizeString(normalized.chapterNumber),
      kind,
      positionRatio: Number(normalized.positionRatio || 0),
      pageIndex: Math.max(0, Number.parseInt(String(normalized.pageIndex || 0), 10) || 0),
      updatedAt: parseIso(normalized.updatedAt)
    };
  };

  const decorateCardsWithReaderTargets = async (titles = [], discordUserId = "") => {
    const ids = Array.from(new Set(normalizeArray(titles).map((title) => normalizeString(title.id)).filter(Boolean))).slice(0, 100);
    if (!ids.length || !normalizeString(discordUserId)) {
      return titles;
    }
    let targets = {};
    try {
      targets = normalizeObject(await vaultClient.listReaderTargets(discordUserId, ids), {}) || {};
    } catch (error) {
      logger?.warn?.("Moon v3 reader targets unavailable; returning cards without reader targets.", {
        status: Number(error?.status || 0) || undefined,
        errorName: error?.name || "Error"
      });
      return titles;
    }
    return titles.map((title) => ({
      ...title,
      readerTarget: normalizeReaderTarget(targets[normalizeString(title.id)])
    }));
  };

  const loadLibraryCardPageForUser = async (query = {}, discordUserId = "") => {
    const page = await loadLibraryCardPage(query);
    return {
      ...page,
      titles: await decorateCardsWithReaderTargets(page.titles, discordUserId)
    };
  };

  const loadLibraryCardPageByIds = async (titleIds = [], discordUserId = "") => {
    const ids = Array.from(new Set(normalizeArray(titleIds).map((entry) => normalizeString(entry)).filter(Boolean))).slice(0, 100);
    if (!ids.length) {
      return [];
    }
    const page = await loadLibraryCardPage({
      ids: ids.join(","),
      pageSize: ids.length
    });
    const titles = normalizeArray(page.titles);
    return normalizeString(discordUserId)
      ? decorateCardsWithReaderTargets(titles, discordUserId)
      : titles;
  };

  const resolveLibraryCardLetter = (title = {}) => {
    const first = normalizeString(title.title).trim().toUpperCase().charAt(0);
    return /^[A-Z]$/.test(first) ? first : "#";
  };

  const buildLibraryCardCounts = (titles = []) => {
    const byLetter = {"#": 0};
    const byType = {};
    for (let index = 0; index < 26; index += 1) {
      byLetter[String.fromCharCode(65 + index)] = 0;
    }
    for (const title of normalizeArray(titles)) {
      const letter = resolveLibraryCardLetter(title);
      byLetter[letter] = (byLetter[letter] || 0) + 1;
      const type = normalizeTypeSlug(title.libraryTypeSlug || title.mediaType);
      byType[type] = (byType[type] || 0) + 1;
    }
    return {total: normalizeArray(titles).length, byLetter, byType};
  };

  const loadLibraryTitle = async (titleId) => {
    const result = await serviceJson(config.ravenBaseUrl, `/v1/library/${encodeURIComponent(titleId)}`);
    if (!result.ok) {
      return null;
    }
    return toTitleSummary(result.payload);
  };

  const loadRequests = async () => {
    const [userIndex, requests] = await Promise.all([
      loadUserIndex(),
      vaultClient.listRequests()
    ]);

    return normalizeArray(requests).map((request) => toRequestSummary(request, userIndex));
  };

  const buildRequestSummaryCounts = (requests = []) => {
    const counts = {
      total: requests.length,
      needsReview: 0,
      pending: 0,
      unavailable: 0,
      queued: 0,
      downloading: 0,
      failed: 0,
      active: 0,
      completed: 0,
      closed: 0,
      waitlisted: 0
    };
    for (const request of requests) {
      const status = normalizeString(request.status).toLowerCase();
      if (Object.hasOwn(counts, status)) {
        counts[status] += 1;
      }
      const needsReview = status === "unavailable"
        || (status === "pending" && !normalizeObject(request.details?.selectedDownload)?.titleUrl);
      if (needsReview) {
        counts.needsReview += 1;
      }
      if (request.tab === "closed") {
        counts.closed += 1;
      }
      if (request.tab === "active") {
        counts.active += 1;
      }
      if (Number.parseInt(String(request.waitlistCount || 0), 10) > 0) {
        counts.waitlisted += 1;
      }
    }
    return counts;
  };

  /**
   * Send a stable Moon admin request conflict response when Vault rejects a
   * stale revision or active work-key update.
   *
   * @param {import("express").Response} res
   * @param {unknown} error
   * @returns {boolean}
   */
  const sendKnownRequestActionConflict = (res, error) => {
    if (isRequestWorkConflictError(error)) {
      res.status(409).json(buildRequestWorkConflictPayload(error));
      return true;
    }
    if (isRequestRevisionConflictError(error)) {
      res.status(409).json(buildRequestRevisionConflictPayload(error));
      return true;
    }
    return false;
  };

  const buildMissingChapterPayload = (titles = []) => {
    const rows = normalizeArray(titles)
      .map((title) => ({
        ...title,
        missingCount: Math.max(0, title.chapterCount - title.chaptersDownloaded),
        missingPageCount: normalizeArray(title.chapters).reduce((sum, chapter) =>
          sum + (Number.parseInt(String(chapter?.missingPageCount || 0), 10) || 0), 0),
        partialChapterCount: Number.parseInt(String(title.partialChapterCount || 0), 10) || normalizeArray(title.chapters)
          .filter((chapter) => normalizeString(chapter?.qualityStatus) === "possible_missing_page").length,
        badChapterCount: Number.parseInt(String(title.missingContentCount || 0), 10) || normalizeArray(title.chapters)
          .filter((chapter) => ["missing_content", "bad_source"].includes(normalizeString(chapter?.qualityStatus))).length,
        cleanChapterCount: Number.parseInt(String(title.cleanChapterCount || 0), 10) || normalizeArray(title.chapters)
          .filter((chapter) => !normalizeString(chapter?.qualityStatus) || normalizeString(chapter?.qualityStatus) === "clean").length,
        damagedChapters: normalizeArray(title.chapters).filter((chapter) =>
          Number.parseInt(String(chapter?.missingPageCount || 0), 10) > 0
          || ["missing_content", "possible_missing_page", "bad_source"].includes(normalizeString(chapter?.qualityStatus))
        )
      }));
    const entries = rows.filter((title) =>
      title.missingCount > 0
      || title.missingPageCount > 0
      || title.partialChapterCount > 0
      || title.badChapterCount > 0
      || ["missing_content", "possible_missing_page", "bad_source"].includes(normalizeString(title.qualityStatus))
    );
    return {
      entries,
      counts: {
        totalTitles: rows.length,
        totalMissing: entries.reduce((sum, title) => sum + title.missingCount, 0),
        totalMissingPages: entries.reduce((sum, title) => sum + title.missingPageCount, 0),
        partialChapters: entries.reduce((sum, title) => sum + title.partialChapterCount, 0),
        badChapters: entries.reduce((sum, title) => sum + title.badChapterCount, 0),
        completeTitles: Math.max(0, rows.length - entries.length),
        affectedTitles: entries.length
      }
    };
  };

  const metadataGapsForTitle = (title = {}) => [
    !normalizeString(title.metadataProvider) ? "provider" : null,
    !normalizeString(title.metadataMatchedAt) ? "matchedAt" : null,
    !normalizeString(title.summary) ? "summary" : null,
    normalizeArray(title.aliases).length === 0 ? "aliases" : null,
    normalizeArray(title.tags).length === 0 ? "tags" : null,
    !normalizeString(title.coverUrl) ? "cover" : null
  ].filter(Boolean);

  const buildMetadataGapPayload = (titles = []) => {
    const entries = normalizeArray(titles)
      .map((title) => ({
        ...title,
        gaps: metadataGapsForTitle(title)
      }))
      .filter((title) => title.gaps.length > 0);
    return {
      entries,
      counts: {
        total: entries.length,
        totalTitles: normalizeArray(titles).length,
        missingProvider: entries.filter((title) => title.gaps.includes("provider")).length,
        missingMatchedAt: entries.filter((title) => title.gaps.includes("matchedAt")).length,
        missingSummary: entries.filter((title) => title.gaps.includes("summary")).length,
        missingAliases: entries.filter((title) => title.gaps.includes("aliases")).length,
        missingTags: entries.filter((title) => title.gaps.includes("tags")).length,
        missingCover: entries.filter((title) => title.gaps.includes("cover")).length
      }
    };
  };

  const readUserTagPreferences = async (discordUserId) =>
    normalizeTagPreferenceStore(await readUserScopedSetting(vaultClient, "moon.tag-preferences", discordUserId, {}));

  const loadUserStateInputs = async (discordUserId) => {
    const [progress, readState, following, tagPreferences] = await Promise.all([
      vaultClient.getProgress(discordUserId),
      vaultClient.getReadState(discordUserId),
      readUserScopedSetting(vaultClient, "moon.following", discordUserId, []),
      readUserTagPreferences(discordUserId)
    ]);
    return {
      progress: normalizeArray(progress),
      readState,
      following: normalizeArray(following).map(normalizeFollowingEntry),
      tagPreferences
    };
  };

  const buildUserLibraryStateFromInputs = (titles = [], inputs = {}) => {
    const normalizedFollowing = normalizeArray(inputs.following).map(normalizeFollowingEntry);
    const progress = normalizeArray(inputs.progress);
    const derived = buildMoonUserLibraryState({
      titles,
      progress,
      readState: inputs.readState,
      following: normalizedFollowing
    });
    return {
      ...derived,
      progress,
      readState: inputs.readState,
      following: normalizedFollowing,
      tagPreferences: normalizeTagPreferenceStore(inputs.tagPreferences)
    };
  };

  const loadUserLibraryState = async (discordUserId, titles = null) => {
    const resolvedTitles = Array.isArray(titles) ? titles : await loadLibrary();
    return buildUserLibraryStateFromInputs(resolvedTitles, await loadUserStateInputs(discordUserId));
  };

  const collectUserActivityTitleIds = (inputs = {}) => {
    const ids = new Set();
    for (const entry of normalizeArray(inputs.progress)) {
      const id = normalizeString(entry.mediaId || entry.titleId);
      if (id) {
        ids.add(id);
      }
    }
    for (const entry of normalizeArray(inputs.readState?.titleStates)) {
      const id = normalizeString(entry.mediaId || entry.titleId);
      if (id) {
        ids.add(id);
      }
    }
    for (const entry of normalizeArray(inputs.readState?.chapterReads)) {
      const id = normalizeString(entry.mediaId || entry.titleId);
      if (id) {
        ids.add(id);
      }
    }
    for (const entry of normalizeArray(inputs.following)) {
      const id = normalizeString(entry.titleId || entry.id);
      if (id) {
        ids.add(id);
      }
    }
    return Array.from(ids).slice(0, 60);
  };

  const buildUserTitleStateFromInputs = (title = null, inputs = {}) => {
    const resolvedTitle = title?.id ? title : null;
    if (!resolvedTitle?.id) {
      return null;
    }
    const userLibrary = buildUserLibraryStateFromInputs([resolvedTitle], inputs);
    const userTitle = userLibrary.titles[0] || resolvedTitle;
    return {
      title: decorateTitleWithTagPreferences(userTitle, userLibrary.tagPreferences),
      userLibrary
    };
  };

  const loadUserTitleState = async (discordUserId, titleId, title = null, userInputs = null) => {
    const resolvedTitle = title || await loadLibraryTitle(titleId);
    if (!resolvedTitle?.id) {
      return null;
    }
    const inputs = userInputs || await loadUserStateInputs(discordUserId);
    return buildUserTitleStateFromInputs(resolvedTitle, inputs);
  };

  const loadUserTitleSummaryState = async (discordUserId, titleId) => {
    const [summary, following, tagPreferences] = await Promise.all([
      vaultClient.getRavenTitleSummary(titleId, {discordUserId}),
      readUserScopedSetting(vaultClient, "moon.following", discordUserId, []),
      readUserTagPreferences(discordUserId)
    ]);
    const title = summary?.title || null;
    if (!title?.id) {
      return null;
    }
    const normalizedFollowing = normalizeArray(following).map(normalizeFollowingEntry);
    const isFollowing = normalizedFollowing.some((entry) => normalizeString(entry.titleId || entry.id) === normalizeString(title.id));
    return {
      title: decorateTitleWithTagPreferences({
        ...title,
        userState: {
          ...(title.userState || {}),
          following: isFollowing
        }
      }, tagPreferences),
      following: isFollowing,
      tagPreferences: normalizeTagPreferenceStore(tagPreferences),
      primaryChapter: summary.primaryChapter || null,
      latestChapter: summary.latestChapter || null
    };
  };

  const loadUserTitleRequests = async (discordUserId, title = {}) => {
    const titleName = normalizeString(title.title);
    const sourceUrl = normalizeString(title.sourceUrl);
    const requests = (await loadRequests()).filter((entry) =>
      entry.requestedBy.discordUserId === discordUserId && (
        normalizeString(entry.title) === titleName
        || normalizeString(entry.details?.selectedDownload?.titleUrl) === sourceUrl
        || normalizeString(entry.details?.selectedMetadata?.title) === titleName
      )
    );
    return {requests};
  };

  const wantsCompactTitleResponse = (req) => {
    const view = normalizeString(req.query?.view || req.query?.response).toLowerCase();
    return ["compact", "summary"].includes(view);
  };

  const sendTitleMutationResponse = async (req, res, fallbackTitle = null, extras = {}) => {
    if (wantsCompactTitleResponse(req)) {
      const summary = await loadUserTitleSummaryState(req.user.discordUserId, req.params.titleId);
      res.json({
        ...(summary || {title: fallbackTitle}),
        ...extras
      });
      return;
    }
    const refreshed = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    res.json({
      title: refreshed?.title || fallbackTitle,
      ...extras
    });
  };

  const loadRequestById = async (requestId) => {
    const [userIndex, request] = await Promise.all([
      loadUserIndex(),
      vaultClient.getRequest(requestId)
    ]);
    return request ? toRequestSummary(request, userIndex) : null;
  };

  const loadLiveRavenTasks = async () => {
    const ravenPayload = await fetchRavenJson("/v1/downloads/tasks");
    return normalizeArray(ravenPayload).map((task) => {
      const details = normalizeObject(task.details, {}) || {};
      const selectedDownload = normalizeObject(task.selectedDownload, normalizeObject(details.selectedDownload, {}) || {}) || {};
      return {
      taskId: normalizeString(task.taskId),
      jobId: normalizeString(task.jobId, normalizeString(task.taskId)),
      requestId: normalizeString(task.requestId),
      titleId: normalizeString(task.titleId),
      titleName: normalizeString(task.titleName),
      titleUrl: normalizeString(task.titleUrl),
      providerId: normalizeString(task.providerId),
      requestType: normalizeString(task.requestType, "manga"),
      libraryTypeLabel: normalizeString(task.libraryTypeLabel, normalizeString(task.details?.libraryTypeLabel, normalizeString(task.requestType, "Manga"))),
      libraryTypeSlug: normalizeTypeSlug(task.libraryTypeSlug || task.requestType),
      coverUrl: normalizeString(task.coverUrl, normalizeString(task.details?.coverUrl)),
      requestedBy: normalizeString(task.requestedBy),
      status: normalizeString(task.status, "queued"),
      message: normalizeString(task.message),
      percent: Number.parseInt(String(task.percent || 0), 10) || 0,
      priority: normalizeString(task.priority, normalizeString(task.details?.priority, "normal")),
      sortOrder: Number.parseInt(String(task.sortOrder ?? task.details?.sortOrder ?? 0), 10) || 0,
      downloadSpeedBytesPerSecond: Number(task.downloadSpeedBytesPerSecond ?? details.downloadSpeedBytesPerSecond ?? 0) || 0,
      startedAt: normalizeString(task.startedAt, normalizeString(details.startedAt)),
      details: {
        downloadSpeedBytesPerSecond: Number(details.downloadSpeedBytesPerSecond || 0) || 0,
        startedAt: normalizeString(details.startedAt),
        sortOrder: Number.parseInt(String(details.sortOrder ?? 0), 10) || 0
      },
      selectedMetadata: {},
      selectedDownload: {
        providerId: normalizeString(selectedDownload.providerId, normalizeString(task.providerId)),
        providerName: normalizeString(selectedDownload.providerName, normalizeString(task.providerId)),
        titleName: normalizeString(selectedDownload.titleName, normalizeString(task.titleName)),
        titleUrl: normalizeString(selectedDownload.titleUrl, normalizeString(task.titleUrl))
      },
      workingRoot: normalizeString(task.workingRoot, normalizeString(task.details?.workingRoot)),
      downloadRoot: normalizeString(task.downloadRoot, normalizeString(task.details?.downloadRoot)),
      queuedAt: parseIso(task.queuedAt),
      updatedAt: parseIso(task.updatedAt),
      ownerService: "scriptarr-raven",
      source: "raven"
      };
    });
  };

  const buildLiveRavenQueuePayload = async () => {
    const [tasks, runtimeSettings] = await Promise.all([
      loadLiveRavenTasks(),
      readRavenDownloadRuntimeSettings()
    ]);
    return buildAdminQueuePayload(tasks, {
      concurrency: runtimeSettings.activeTitleDownloads
    });
  };

  const loadTasks = async () => {
    const ravenTasks = await loadLiveRavenTasks();
    const jobs = normalizeArray(await vaultClient.listJobs()).filter((job) =>
      ["scriptarr-warden", "scriptarr-raven"].includes(normalizeString(job.ownerService))
    );
    const brokerTasksNested = await Promise.all(jobs.map(async (job) =>
      normalizeArray(await vaultClient.listJobTasks(job.jobId)).map((task) => ({
        taskId: normalizeString(task.taskId),
        jobId: normalizeString(job.jobId),
        jobKind: normalizeString(job.kind),
        taskKey: normalizeString(task.taskKey),
        requestId: normalizeString(task.payload?.requestId, normalizeString(job.payload?.requestId)),
        titleId: normalizeString(task.result?.titleId, normalizeString(job.result?.titleId)),
        titleName: normalizeString(task.label || job.label || job.kind, "Background job"),
        titleUrl: normalizeString(task.payload?.titleUrl, normalizeString(job.payload?.titleUrl)),
        providerId: normalizeString(task.payload?.providerId, normalizeString(job.payload?.providerId)),
        requestType: normalizeString(task.payload?.requestType || job.payload?.requestType || job.kind, "job"),
        libraryTypeLabel: normalizeString(
          task.payload?.libraryTypeLabel || job.payload?.libraryTypeLabel,
          normalizeString(task.payload?.requestType || job.payload?.requestType || job.kind, "Job")
        ),
        libraryTypeSlug: normalizeTypeSlug(task.payload?.libraryTypeSlug || job.payload?.libraryTypeSlug || task.payload?.requestType || job.payload?.requestType || "manga"),
        coverUrl: normalizeString(task.result?.coverUrl, normalizeString(job.result?.coverUrl)),
        requestedBy: normalizeString(job.ownerService || task.requestedBy || "scriptarr"),
        status: normalizeString(task.status || job.status, "queued"),
        message: normalizeString(task.message || job.label || "Background task updated."),
        percent: Number.parseInt(String(task.percent || 0), 10) || 0,
        priority: normalizeString(task.payload?.priority || job.payload?.priority, "normal"),
        sortOrder: Number.parseInt(String(task.sortOrder || 0), 10) || 0,
        details: {},
        selectedMetadata: {},
        selectedDownload: {},
        workingRoot: normalizeString(task.result?.workingRoot, normalizeString(job.result?.workingRoot)),
        downloadRoot: normalizeString(task.result?.downloadRoot, normalizeString(job.result?.downloadRoot)),
        queuedAt: parseIso(task.createdAt || job.createdAt),
        updatedAt: parseIso(task.updatedAt || job.updatedAt),
        ownerService: normalizeString(job.ownerService),
        source: "broker"
      }))
    ));
    const brokerTasks = brokerTasksNested.flat();
    const logicalTaskId = (task) => {
      const requestId = normalizeString(task.requestId);
      if (requestId) {
        return `request:${requestId}`;
      }
      const providerId = normalizeString(task.providerId);
      const titleUrl = normalizeString(task.titleUrl);
      if (providerId || titleUrl) {
        return `download:${providerId}::${titleUrl}`;
      }
      return `title:${normalizeString(task.titleName).toLowerCase()}`;
    };
    const taskTimestamp = (task) => Date.parse(task.updatedAt || task.queuedAt || "") || 0;
    const deduped = new Map();
    for (const task of [...ravenTasks, ...brokerTasks]) {
      const logicalId = logicalTaskId(task);
      const existing = deduped.get(logicalId);
      if (!existing) {
        deduped.set(logicalId, {...task, logicalId});
        continue;
      }
      if (existing.source !== "raven" && task.source === "raven") {
        deduped.set(logicalId, {...task, logicalId});
        continue;
      }
      if (existing.source === task.source && taskTimestamp(task) >= taskTimestamp(existing)) {
        deduped.set(logicalId, {...task, logicalId});
      }
    }

    return Array.from(deduped.values()).sort((left, right) =>
      taskTimestamp(right) - taskTimestamp(left)
    );
  };

  const requestMatchesTitle = (request, title) => (
    normalizeString(request.title) === normalizeString(title.title)
    || normalizeString(request.details?.selectedDownload?.titleUrl) === normalizeString(title.sourceUrl)
    || normalizeString(request.details?.selectedMetadata?.title) === normalizeString(title.title)
  );

  const taskMatchesTitle = (task, title, requestIds = new Set()) => (
    requestIds.has(normalizeString(task.requestId))
    || normalizeString(task.titleId) === normalizeString(title.id)
    || normalizeString(task.titleUrl) === normalizeString(title.sourceUrl)
    || normalizeString(task.titleName) === normalizeString(title.title)
  );

  const loadRequestGuardState = async () => {
    const [libraryTitles, requests, tasks] = await Promise.all([
      loadLibrary(),
      loadRequests(),
      loadTasks()
    ]);
    return {libraryTitles, requests, tasks};
  };

  const fetchIntakeResults = async (query) => {
    const normalizedQuery = normalizeString(query);
    if (!normalizedQuery) {
      return {query: "", results: []};
    }

    const payload = await fetchRavenJson(`/v1/intake/search?query=${encodeURIComponent(normalizedQuery)}`);
    return {
      query: normalizedQuery,
      results: normalizeArray(payload?.results)
    };
  };

  const fetchMetadataSearchResults = async (query, {libraryId = ""} = {}) => {
    const normalizedQuery = normalizeString(query);
    if (!normalizedQuery) {
      return {query: "", results: []};
    }

    const normalizedLibraryId = normalizeString(libraryId);
    const payload = await fetchRavenJson(
      `/v1/metadata/search?name=${encodeURIComponent(normalizedQuery)}${normalizedLibraryId ? `&libraryId=${encodeURIComponent(normalizedLibraryId)}` : ""}`
    );
    const rawResults = normalizeArray(payload);
    const hydratedResults = await Promise.all(rawResults.map(async (entry) => {
      const provider = normalizeString(entry.provider);
      const providerSeriesId = normalizeString(entry.providerSeriesId);
      let details = {};
      if (provider && providerSeriesId) {
        const result = await safeJson(serviceJson(
          config.ravenBaseUrl,
          `/v1/metadata/series-details?provider=${encodeURIComponent(provider)}&providerSeriesId=${encodeURIComponent(providerSeriesId)}`
        ));
        if (result?.ok !== false) {
          details = normalizeObject(result?.payload, {}) || {};
        }
      }

      const type = normalizeString(details.type, normalizeString(entry.type, "manga"));
      return {
        provider,
        providerName: normalizeString(entry.providerName, provider),
        providerSeriesId,
        title: normalizeString(details.title, normalizeString(entry.title, "Untitled")),
        url: normalizeString(details.url, normalizeString(entry.url)),
        summary: normalizeString(details.summary, normalizeString(entry.summary)),
        coverUrl: normalizeString(details.coverUrl, normalizeString(entry.coverUrl)),
        type,
        typeSlug: normalizeTypeSlug(details.typeSlug || type),
        aliases: mergeDisplayStrings(entry.aliases, details.aliases),
        tags: mergeDisplayStrings(entry.tags, details.tags),
        releaseLabel: normalizeString(details.releaseLabel, normalizeString(entry.releaseLabel)),
        status: normalizeString(details.status, normalizeString(entry.status))
      };
    }));
    return {
      query: normalizedQuery,
      results: hydratedResults
    };
  };

  const fetchDownloadOptions = async ({query, selectedMetadata}) => {
    const payload = await fetchRavenJson("/v1/intake/download-options", {
      method: "POST",
      body: {
        query: normalizeString(query),
        selectedMetadata: normalizeObject(selectedMetadata, {}) || {}
      }
    });
    return {
      query: normalizeString(payload?.query, normalizeString(query)),
      availability: normalizeString(payload?.availability, "unavailable"),
      selectedMetadata: normalizeObject(payload?.selectedMetadata, normalizeObject(selectedMetadata, {}) || {}),
      results: normalizeArray(payload?.results).map((entry) => normalizeDownloadOption(entry))
    };
  };

  const requestReflectsQueuedDownload = (requestSummary, queueResult) => {
    const status = normalizeString(requestSummary?.status).toLowerCase();
    if (!["queued", "downloading", "failed", "completed"].includes(status)) {
      return false;
    }

    const queuedTaskId = normalizeString(queueResult?.payload?.taskId);
    const queuedJobId = normalizeString(queueResult?.payload?.jobId, queuedTaskId);
    const details = normalizeObject(requestSummary?.details, {}) || {};
    const requestTaskId = normalizeString(details.taskId);
    const requestJobId = normalizeString(details.jobId, requestTaskId);
    if (queuedTaskId && requestTaskId === queuedTaskId) {
      return true;
    }
    if (queuedJobId && requestJobId === queuedJobId) {
      return true;
    }
    return false;
  };

  const markRequestQueuedAfterRaven = async ({
    requestId,
    requestSummary,
    queueResult,
    expectedRevision,
    eventMessage,
    moderatorComment,
    actor
  }) => {
    const update = {
      status: "queued",
      eventType: "approved",
      eventMessage,
      actor: normalizeString(actor),
      expectedRevision: normalizeExpectedRequestRevision(expectedRevision),
      appendStatusEvent: false,
      ...(moderatorComment == null ? {} : {moderatorComment: normalizeString(moderatorComment)}),
      detailsMerge: {
        availability: "available",
        selectedMetadata: requestSummary.details?.selectedMetadata || null,
        selectedDownload: requestSummary.details?.selectedDownload || null,
        sourceFoundAt: "",
        sourceFoundOptions: [],
        jobId: normalizeString(queueResult.payload?.jobId),
        taskId: normalizeString(queueResult.payload?.taskId)
      }
    };

    try {
      await vaultClient.updateRequest(requestId, update);
      return loadRequestById(requestId);
    } catch (error) {
      if (!isRequestRevisionConflictError(error)) {
        throw error;
      }
      const refreshed = await loadRequestById(requestId);
      if (requestReflectsQueuedDownload(refreshed, queueResult)) {
        return refreshed;
      }
      throw error;
    }
  };

  const approveAndQueueRequest = async ({
    requestId,
    requestSummary,
    requestedBy,
    actor,
    actorUser,
    comment,
    eventMessage,
    expectedRevision
  }) => {
    const queueResult = await queueSelectedDownload({
      requestId,
      requestSummary,
      requestedBy
    });
    if (!queueResult.ok) {
      return queueResult;
    }

    const queuedRequest = await markRequestQueuedAfterRaven({
      requestId,
      requestSummary,
      queueResult,
      expectedRevision,
      eventMessage: normalizeString(eventMessage, normalizeString(comment, "Approved from Moon admin.")),
      moderatorComment: normalizeString(comment),
      actor: normalizeString(actor)
    });

    await appendEvent({
      ...(actorUser ? buildUserActor(actorUser, "admin") : buildServiceActor("scriptarr-sage", normalizeString(actor, "Scriptarr Sage"))),
      domain: "requests",
      eventType: "request-approved",
      severity: "info",
      targetType: "request",
      targetId: normalizeString(requestId),
      message: normalizeString(eventMessage, normalizeString(comment, "Request approved and queued.")),
      metadata: {
        requestId: normalizeString(requestId),
        requestedBy: normalizeString(requestedBy),
        title: normalizeString(requestSummary?.title),
        queue: queueResult.payload || {}
      }
    });

    return {
      ok: true,
      status: 202,
      payload: {
        request: queuedRequest,
        queue: queueResult.payload
      }
    };
  };

  const resolveDuplicateRequestSummary = async (guard) => {
    if (guard?.matchingRequest?.id) {
      return loadRequestById(guard.matchingRequest.id);
    }
    const requestId = normalizeString(guard?.matchingTask?.requestId);
    if (requestId) {
      return loadRequestById(requestId);
    }
    return null;
  };

  const previewContentReset = async () => {
    const [vaultPreview, ravenPreview] = await Promise.all([
      vaultClient.previewContentReset(),
      serviceJson(config.ravenBaseUrl, "/v1/system/content-reset/preview")
    ]);
    return {
      vault: vaultPreview,
      raven: ravenPreview.ok ? ravenPreview.payload : {
        error: ravenPreview.payload?.error || "Moon could not preview Raven managed content reset scope."
      },
      confirmationText: "RESET SCRIPTARR CONTENT"
    };
  };

  const attachDuplicateWaitlist = async ({requestSummary, user, source}) => {
    const requestId = normalizeString(requestSummary?.id);
    if (!requestId) {
      return null;
    }
    const request = await vaultClient.getRequest(requestId);
    if (!request) {
      return null;
    }
    const nextWaitlist = attachRequestWaitlistEntry(request, {
      discordUserId: normalizeString(user.discordUserId),
      username: normalizeString(user.username, "Reader"),
      avatarUrl: normalizeString(user.avatarUrl),
      source: normalizeString(source, "moon")
    });
    if (!nextWaitlist.added) {
      return requestSummary;
    }
    await vaultClient.updateRequest(request.id, {
      detailsMerge: {
        waitlist: nextWaitlist.waitlist
      },
      actor: "scriptarr-sage",
      appendStatusEvent: false
    });
    return loadRequestById(request.id);
  };

  const queueSelectedDownload = async ({requestId, requestSummary, requestedBy}) => {
    const selectedDownload = normalizeObject(requestSummary?.details?.selectedDownload);
    if (!selectedDownload?.titleUrl) {
      return {
        ok: false,
        status: 409,
        payload: {error: "This request does not have a concrete download target yet."}
      };
    }

    return serviceJson(config.ravenBaseUrl, "/v1/downloads/queue", {
      method: "POST",
      body: {
        titleName: normalizeString(selectedDownload.titleName, requestSummary.title),
        titleUrl: normalizeString(selectedDownload.titleUrl),
        requestType: normalizeString(selectedDownload.requestType, requestSummary.requestType || "manga"),
        providerId: normalizeString(selectedDownload.providerId),
        requestId: String(requestId),
        requestedBy,
        selectedMetadata: requestSummary.details?.selectedMetadata || null,
        selectedDownload
      }
    });
  };

  const loadServiceStatus = async () => {
    const [warden, portal, oracle, raven] = await Promise.all([
      safeJson(fetch(`${config.wardenBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.portalBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.oracleBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.ravenBaseUrl}/health`).then((response) => response.json()))
    ]);

    return {warden, portal, oracle, raven};
  };

  const triviaService = createPortalTriviaService({
    config,
    vaultClient,
    serviceJson,
    readPortalDiscordSettings
  });

  const withAdminAccess = (domain, level, handler) => async (req, res, next) => {
    await requireAdminGrant(domain, level)(req, res, async () => {
      try {
        await handler(req, res, next);
      } catch (error) {
        next(error);
      }
    });
  };
  const requireOverviewRead = (handler) => withAdminAccess("overview", "read", handler);
  const requireLibraryRead = (handler) => withAdminAccess("library", "read", handler);
  const requireLibraryRoot = (handler) => withAdminAccess("library", "root", handler);
  const requireAddRead = (handler) => withAdminAccess("add", "read", handler);
  const requireAddWrite = (handler) => withAdminAccess("add", "write", handler);
    const requireImportRead = (handler) => withAdminAccess("import", "read", handler);
    const requireCalendarRead = (handler) => withAdminAccess("calendar", "read", handler);
    const requireActivityRead = (handler) => withAdminAccess("activity", "read", handler);
    const requireActivityWrite = (handler) => withAdminAccess("activity", "write", handler);
    const requireActivityRoot = (handler) => withAdminAccess("activity", "root", handler);
    const requireWantedRead = (handler) => withAdminAccess("wanted", "read", handler);
    const requireWantedWrite = (handler) => withAdminAccess("wanted", "write", handler);
  const requireRequestRead = (handler) => withAdminAccess("requests", "read", handler);
  const requireRequestWrite = (handler) => withAdminAccess("requests", "write", handler);
  const requireRequestRoot = (handler) => withAdminAccess("requests", "root", handler);
  const requireUsersRead = (handler) => withAdminAccess("users", "read", handler);
  const requireUsersRoot = (handler) => withAdminAccess("users", "root", handler);
  const requireDiscordRead = (handler) => withAdminAccess("discord", "read", handler);
  const requireDiscordWrite = (handler) => withAdminAccess("discord", "write", handler);
  const requireAiRead = (handler) => withAdminAccess("ai", "read", handler);
  const requireAiWrite = (handler) => withAdminAccess("ai", "write", handler);
  const requireAiRoot = (handler) => withAdminAccess("ai", "root", handler);
  const requireMediaManagementRead = (handler) => withAdminAccess("mediamanagement", "read", handler);
  const requireSettingsRead = (handler) => withAdminAccess("settings", "read", handler);
  const requireSettingsWrite = (handler) => withAdminAccess("settings", "write", handler);
  const requireSettingsRoot = (handler) => withAdminAccess("settings", "root", handler);
  const requireDatabaseRead = (handler) => withAdminAccess("database", "read", handler);
  const requireDatabaseWrite = (handler) => withAdminAccess("database", "write", handler);
  const requireSystemRead = (handler) => withAdminAccess("system", "read", handler);
  const requireSystemRoot = (handler) => withAdminAccess("system", "root", handler);
  const requirePublicApiRead = (handler) => withAdminAccess("publicapi", "read", handler);
  const requirePublicApiRoot = (handler) => withAdminAccess("publicapi", "root", handler);
  const appendEvent = (payload) => appendDurableEvent(vaultClient, payload, logger);
  const appendEventForUser = (payload) => appendUserEvent(vaultClient, payload, logger);
  const normalizeRequestedEventDomains = (value) => Array.isArray(value)
    ? value.map((entry) => normalizeString(entry)).filter(Boolean)
    : value
      ? [normalizeString(value)].filter(Boolean)
      : [];
  const ensureEventReadAccess = (user, domains = []) => {
    const normalizedDomains = normalizeRequestedEventDomains(domains);
    if (!normalizedDomains.length) {
      return hasDomainAccess(user, "system", "read");
    }
    return normalizedDomains.every((domain) => hasDomainAccess(
      user,
      EVENT_DOMAIN_ACCESS[domain] || "system",
      "read"
    ));
  };
  const normalizeRequestedEventFilter = (value) => normalizeRequestedEventDomains(value);
  const buildEventFiltersFromQuery = (query = {}) => ({
    domains: normalizeRequestedEventDomains(query.domain),
    eventTypes: normalizeRequestedEventFilter(query.eventType),
    severities: normalizeRequestedEventFilter(query.severity),
    actorType: normalizeString(query.actorType),
    actorId: normalizeString(query.actorId),
    targetType: normalizeString(query.targetType),
    targetId: normalizeString(query.targetId),
    query: normalizeString(query.q || query.query),
    since: normalizeString(query.since),
    until: normalizeString(query.until),
    afterSequence: query.afterSequence || query.after || 0,
    limit: query.limit || 100,
    newestFirst: query.newestFirst !== "false"
  });
  const appendOptionalSearchParam = (params, key, value) => {
    const normalized = normalizeString(value);
    if (normalized) {
      params.set(key, normalized);
    }
  };

  app.get("/api/moon-v3/public/branding", async (_req, res) => {
    res.json(publicMoonBranding(await readMoonBrandingSettings()));
  });

  app.get("/api/moon-v3/public/branding/logo/:variant", async (req, res) => {
    const logo = selectMoonLogoVariant(await readMoonBrandingSettings(), normalizeString(req.params.variant, "chrome"));
    if (!logo) {
      res.status(404).json({error: "Brand logo not configured."});
      return;
    }
    if (logo.revision) {
      res.setHeader("ETag", `"${logo.revision}"`);
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type(logo.mimeType).send(logo.buffer);
  });

  app.get("/api/moon-v3/admin/overview", requireOverviewRead(async (_req, res) => {
    const [titles, tasks, requests, services] = await Promise.all([
      loadLibrary(),
      loadTasks(),
      loadRequests(),
      loadServiceStatus()
    ]);

    const pendingRequests = requests.filter((entry) => entry.status === "pending");
    const activeTasks = tasks.filter((entry) => entry.status === "queued" || entry.status === "running");
    const missingCount = titles.reduce((sum, title) => sum + Math.max(0, title.chapterCount - title.chaptersDownloaded), 0);
    const metadataGapCount = titles.filter((title) => !title.metadataProvider || !title.summary).length;

    res.json({
      counts: {
        titles: titles.length,
        activeTasks: activeTasks.length,
        pendingRequests: pendingRequests.length,
        missingChapters: missingCount,
        metadataGaps: metadataGapCount
      },
      services,
      queue: activeTasks.slice(0, 8),
      requests: pendingRequests.slice(0, 8),
      titles: titles.slice(0, 6)
    });
  }));

  app.get("/api/moon-v3/admin/library", requireLibraryRead(async (_req, res) => {
    res.json({titles: await loadLibrary()});
  }));

  app.get("/api/moon-v3/admin/library/:titleId", requireLibraryRead(async (req, res) => {
    const [title, requests, tasks] = await Promise.all([
      loadLibraryTitle(req.params.titleId),
      loadRequests(),
      loadTasks()
    ]);
    if (!title?.id) {
      res.status(404).json({error: "Title not found."});
      return;
    }

    const relatedRequests = requests.filter((request) => requestMatchesTitle(request, title));
    const relatedRequestIds = new Set(relatedRequests.map((request) => normalizeString(request.id)).filter(Boolean));
    const relatedTasks = tasks.filter((task) => taskMatchesTitle(task, title, relatedRequestIds));

    res.json({
      title,
      requests: relatedRequests.sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "")),
      activeTasks: relatedTasks
        .filter((task) => task.status === "queued" || task.status === "running")
        .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "")),
      recentTasks: relatedTasks
        .filter((task) => task.status === "completed" || task.status === "failed")
        .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""))
        .slice(0, 8)
    });
  }));

  app.get("/api/moon-v3/admin/library/:titleId/repair-options", requireLibraryRead(async (req, res) => {
    const result = await serviceJson(config.ravenBaseUrl, `/v1/library/${encodeURIComponent(req.params.titleId)}/repair-options`);
    if (!result.ok) {
      res.status(result.status || 502).json(result.payload || {error: "Moon could not load Raven repair options."});
      return;
    }
    res.json(result.payload);
  }));

  app.post("/api/moon-v3/admin/library/:titleId/replace-source", requireLibraryRoot(async (req, res) => {
    const requestBody = normalizeObject(req.body, {}) || {};
    const result = await serviceJson(config.ravenBaseUrl, `/v1/library/${encodeURIComponent(req.params.titleId)}/replace-source`, {
      method: "POST",
      body: {
        ...requestBody,
        requestedBy: req.user?.discordUserId || "scriptarr-admin"
      }
    });
    if (!result.ok) {
      res.status(result.status || 502).json(result.payload || {error: "Moon could not queue the Raven replacement download."});
      return;
    }
    await appendEvent({
      ...buildUserActor(req.user, "admin"),
      domain: "library",
      eventType: "source-replacement-queued",
      severity: "info",
      targetType: "title",
      targetId: normalizeString(req.params.titleId),
      message: `${req.user.username} queued a replacement source download.`,
      metadata: {
        titleId: normalizeString(req.params.titleId),
        providerId: normalizeString(requestBody?.providerId),
        titleUrl: normalizeString(requestBody?.titleUrl)
      }
    });
    res.status(202).json(result.payload);
  }));

  app.get("/api/moon-v3/admin/add/search", requireAddRead(async (req, res) => {
    res.json(await fetchIntakeResults(req.query.query));
  }));

  app.get("/api/moon-v3/admin/add/metadata-search", requireAddRead(async (req, res) => {
    res.json(await fetchMetadataSearchResults(req.query.query));
  }));

  app.post("/api/moon-v3/admin/add/download-options", requireAddRead(async (req, res) => {
    const selectedMetadata = normalizeObject(req.body?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "selectedMetadata with provider and providerSeriesId is required."});
      return;
    }
    res.json(await fetchDownloadOptions({
      query: normalizeString(req.body?.query),
      selectedMetadata
    }));
  }));

  app.post("/api/moon-v3/admin/add/queue", requireAddWrite(async (req, res) => {
    const selectedMetadata = normalizeObject(req.body?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "A concrete metadata result is required."});
      return;
    }

    const selectedDownload = normalizeObject(req.body?.selectedDownload);
    const guard = evaluateSelectionAgainstGuardState(buildIntakeSelection({
      query: normalizeString(req.body?.query),
      title: normalizeString(req.body?.title),
      requestType: normalizeString(req.body?.requestType),
      selectedMetadata,
      selectedDownload
    }), await loadRequestGuardState());
    if (guard.alreadyInLibrary) {
      res.status(409).json(buildLibraryDuplicatePayload({
        matchingTitle: guard.matchingTitle,
        publicBaseUrl: config.publicBaseUrl
      }));
      return;
    }
    if (guard.alreadyQueuedOrRequested) {
      res.status(409).json(buildActiveRequestDuplicatePayload({
        matchingRequest: await resolveDuplicateRequestSummary(guard),
        publicBaseUrl: config.publicBaseUrl
      }));
      return;
    }

    let request;
    try {
      request = await vaultClient.createRequest({
        source: "moon-admin",
        title: normalizeString(selectedMetadata.title, req.body?.title || "Untitled request"),
        requestType: normalizeString(req.body?.requestType || selectedDownload?.requestType || selectedMetadata.type || "manga", "manga"),
        notes: normalizeString(req.body?.notes),
        requestedBy: req.user.discordUserId,
        status: selectedDownload ? "pending" : "unavailable",
        details: {
          query: normalizeString(req.body?.query),
          selectedMetadata,
          selectedDownload,
          availability: selectedDownload ? "available" : "unavailable"
        }
      });
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }

    await appendEvent({
      ...buildUserActor(req.user, "admin"),
      domain: "add",
      eventType: selectedDownload?.titleUrl ? "admin-add-request-created" : "admin-add-unavailable",
      severity: "info",
      targetType: "request",
      targetId: normalizeString(request.id),
      message: selectedDownload?.titleUrl
        ? `${req.user.username} created an admin add request with a concrete source.`
        : `${req.user.username} saved an unavailable admin add request.`,
      metadata: {
        requestId: normalizeString(request.id),
        title: normalizeString(request.title),
        requestType: normalizeString(request.requestType)
      }
    });

    if (!selectedDownload?.titleUrl) {
      res.status(201).json({
        request,
        queued: false,
        message: "The request was saved as unavailable because no enabled download provider matched it yet."
      });
      return;
    }

    const queueResult = await queueSelectedDownload({
      requestId: request.id,
      requestSummary: toRequestSummary(request, new Map([[req.user.discordUserId, req.user]])),
      requestedBy: req.user.discordUserId
    });

    if (!queueResult.ok) {
      res.status(queueResult.status).json(queueResult.payload);
      return;
    }

    await vaultClient.updateRequest(request.id, {
      status: "queued",
      eventType: "approved",
      eventMessage: "Queued immediately from Moon admin.",
      actor: req.user.username,
      appendStatusEvent: false,
      detailsMerge: {
        query: normalizeString(req.body?.query),
        selectedMetadata,
        selectedDownload,
        availability: "available",
        jobId: normalizeString(queueResult.payload?.jobId),
        taskId: normalizeString(queueResult.payload?.taskId)
      }
    });
    await appendEvent({
      ...buildUserActor(req.user, "admin"),
      domain: "add",
      eventType: "admin-add-queued",
      severity: "info",
      targetType: "request",
      targetId: normalizeString(request.id),
      message: `${req.user.username} queued an admin add download immediately.`,
      metadata: {
        requestId: normalizeString(request.id),
        queue: queueResult.payload || {}
      }
    });

    res.status(202).json({
      request: await vaultClient.getRequest(request.id),
      queue: queueResult.payload,
      queued: true
    });
  }));

  app.get("/api/moon-v3/admin/import", requireImportRead(async (_req, res) => {
    res.json({
      imports: [],
      summary: {
        detected: 0,
        note: "Import scanning is not wired into the Scriptarr scaffold yet."
      }
    });
  }));

  app.get("/api/moon-v3/admin/calendar", requireCalendarRead(async (_req, res) => {
    const titles = await loadLibrary();
    res.json(buildAdminCalendarPayload(titles));
  }));

    app.get("/api/moon-v3/admin/activity/queue", requireActivityRead(async (_req, res) => {
      res.json(await buildLiveRavenQueuePayload());
    }));

    app.post("/api/moon-v3/admin/activity/queue/:taskId/cancel", requireActivityWrite(async (req, res) => {
      const tasks = await loadLiveRavenTasks();
      const task = tasks.find((entry) => normalizeString(entry.taskId) === normalizeString(req.params.taskId));
      if (!task) {
        res.status(404).json({error: "Live Raven task not found."});
        return;
      }
      if (normalizeString(task.status) === "running" && !hasDomainAccess(req.user, "activity", "root")) {
        res.status(403).json({error: "Canceling a running task requires activity.root."});
        return;
      }
      res.json(await fetchRavenJson(`/v1/downloads/tasks/${encodeURIComponent(req.params.taskId)}/cancel`, {
        method: "POST"
      }));
    }));

    app.post("/api/moon-v3/admin/activity/queue/:taskId/retry", requireActivityWrite(async (req, res) => {
      res.json(await fetchRavenJson(`/v1/downloads/tasks/${encodeURIComponent(req.params.taskId)}/retry`, {
        method: "POST"
      }));
    }));

    app.post("/api/moon-v3/admin/activity/queue/:taskId/remove", requireActivityWrite(async (req, res) => {
      const tasks = await loadLiveRavenTasks();
      const queuePayload = buildAdminQueuePayload(tasks);
      const task = normalizeArray(queuePayload.needsAttention)
        .find((entry) => normalizeString(entry.taskId) === normalizeString(req.params.taskId));
      if (!task) {
        res.status(404).json({error: "Live Raven task not found in Needs attention."});
        return;
      }
      if (task.removable !== true) {
        res.status(409).json({error: "Only failed or stale queued Raven title tasks can be removed."});
        return;
      }
      res.json(await fetchRavenJson(`/v1/downloads/tasks/${encodeURIComponent(req.params.taskId)}/remove`, {
        method: "POST"
      }));
    }));

    app.post("/api/moon-v3/admin/activity/queue/retry-all", requireActivityWrite(async (_req, res) => {
      const tasks = await loadLiveRavenTasks();
      const queuePayload = buildAdminQueuePayload(tasks);
      const retriableTasks = normalizeArray(queuePayload.needsAttention)
        .filter((task) => task.retriable === true && normalizeString(task.taskId));

      const results = [];
      for (const task of retriableTasks) {
        const response = await fetchRavenJson(`/v1/downloads/tasks/${encodeURIComponent(task.taskId)}/retry`, {
          method: "POST"
        });
        results.push({
          taskId: task.taskId,
          titleName: normalizeString(task.titleName, "Untitled"),
          ok: response.ok,
          status: response.status,
          error: response.ok ? "" : normalizeString(response.payload?.error, response.statusText)
        });
      }

      const retried = results.filter((entry) => entry.ok);
      const failed = results.filter((entry) => !entry.ok);
      res.json({
        retriedCount: retried.length,
        failedCount: failed.length,
        message: retried.length
          ? `Queued ${retried.length} Raven retry${retried.length === 1 ? "" : "ies"}.`
          : "No retriable Raven tasks were waiting in Needs attention.",
        results
      });
    }));

    app.post("/api/moon-v3/admin/activity/queue/remove-all", requireActivityWrite(async (_req, res) => {
      const tasks = await loadLiveRavenTasks();
      const queuePayload = buildAdminQueuePayload(tasks);
      const removableTasks = normalizeArray(queuePayload.needsAttention)
        .filter((task) => task.removable === true && normalizeString(task.taskId));
      const results = [];
      for (const task of removableTasks) {
        const response = await fetchRavenJson(`/v1/downloads/tasks/${encodeURIComponent(task.taskId)}/remove`, {
          method: "POST"
        });
        results.push({
          taskId: task.taskId,
          titleName: normalizeString(task.titleName, "Untitled"),
          ok: response.ok,
          status: response.status,
          error: response.ok ? "" : normalizeString(response.payload?.error, response.statusText)
        });
      }
      const removed = results.filter((entry) => entry.ok);
      res.json({
        removedCount: removed.length,
        failedCount: results.length - removed.length,
        message: removed.length
          ? `Removed ${removed.length} Raven recovery task${removed.length === 1 ? "" : "s"}.`
          : "No removable Raven recovery tasks were waiting in Needs attention.",
        results
      });
    }));

    app.post("/api/moon-v3/admin/activity/queue/cancel-queued", requireActivityWrite(async (_req, res) => {
      const tasks = await loadLiveRavenTasks();
      const queuePayload = buildAdminQueuePayload(tasks);
      const queuedTasks = normalizeArray(queuePayload.queued).filter((task) => normalizeString(task.taskId));
      const results = [];
      for (const task of queuedTasks) {
        const response = await fetchRavenJson(`/v1/downloads/tasks/${encodeURIComponent(task.taskId)}/cancel`, {
          method: "POST"
        });
        results.push({
          taskId: task.taskId,
          titleName: normalizeString(task.titleName, "Untitled"),
          ok: response.ok,
          status: response.status,
          error: response.ok ? "" : normalizeString(response.payload?.error, response.statusText)
        });
      }
      const cancelled = results.filter((entry) => entry.ok);
      res.json({
        cancelledCount: cancelled.length,
        failedCount: results.length - cancelled.length,
        message: cancelled.length
          ? `Cancelled ${cancelled.length} queued Raven task${cancelled.length === 1 ? "" : "s"}.`
          : "No queued Raven tasks were waiting.",
        results
      });
    }));

    app.post("/api/moon-v3/admin/activity/queue/cancel-running", requireActivityWrite(async (req, res) => {
      if (!hasDomainAccess(req.user, "activity", "root")) {
        res.status(403).json({error: "Canceling running tasks requires activity.root."});
        return;
      }
      const tasks = await loadLiveRavenTasks();
      const queuePayload = buildAdminQueuePayload(tasks);
      const runningTasks = normalizeArray(queuePayload.running).filter((task) => normalizeString(task.taskId));
      const results = [];
      for (const task of runningTasks) {
        const response = await fetchRavenJson(`/v1/downloads/tasks/${encodeURIComponent(task.taskId)}/cancel`, {
          method: "POST"
        });
        results.push({
          taskId: task.taskId,
          titleName: normalizeString(task.titleName, "Untitled"),
          ok: response.ok,
          status: response.status,
          error: response.ok ? "" : normalizeString(response.payload?.error, response.statusText)
        });
      }
      const cancelled = results.filter((entry) => entry.ok);
      res.json({
        cancelledCount: cancelled.length,
        failedCount: results.length - cancelled.length,
        message: cancelled.length
          ? `Cancelled ${cancelled.length} running Raven task${cancelled.length === 1 ? "" : "s"}.`
          : "No running Raven tasks were active.",
        results
      });
    }));

    app.post("/api/moon-v3/admin/activity/queue/:taskId/priority", requireActivityWrite(async (req, res) => {
      const priority = normalizeString(req.body?.priority).toLowerCase();
      if (!["high", "normal", "low"].includes(priority)) {
        res.status(400).json({error: "priority must be high, normal, or low."});
        return;
      }
      res.json(await fetchRavenJson(`/v1/downloads/tasks/${encodeURIComponent(req.params.taskId)}/priority`, {
        method: "POST",
        body: {priority}
      }));
    }));

    app.post("/api/moon-v3/admin/activity/queue/:taskId/move", requireActivityWrite(async (req, res) => {
      const direction = normalizeString(req.body?.direction).toLowerCase();
      if (!["up", "down"].includes(direction)) {
        res.status(400).json({error: "direction must be up or down."});
        return;
      }
      res.json(await fetchRavenJson(`/v1/downloads/tasks/${encodeURIComponent(req.params.taskId)}/move`, {
        method: "POST",
        body: {direction}
      }));
    }));

  app.get("/api/moon-v3/admin/activity/history", requireActivityRead(async (_req, res) => {
    const tasks = await loadTasks();
    res.json({tasks: tasks.filter((entry) => entry.status === "completed" || entry.status === "failed")});
  }));

  app.get("/api/moon-v3/admin/activity/blocklist", requireActivityRead(async (_req, res) => {
    const requests = await loadRequests();
    res.json({
      entries: requests.filter((entry) => entry.status === "denied" || entry.status === "blocked")
    });
  }));

  app.get("/api/moon-v3/admin/wanted/missing-chapters", requireWantedRead(async (_req, res) => {
    const titles = await loadLibrary();
    res.json(buildMissingChapterPayload(titles));
  }));

  app.get("/api/moon-v3/admin/wanted/missing-content", requireWantedRead(async (_req, res) => {
    const titles = await loadLibrary();
    res.json(buildMissingChapterPayload(titles));
  }));

  app.get("/api/moon-v3/admin/wanted/metadata", requireWantedRead(async (_req, res) => {
    const titles = await loadLibrary();
    res.json(buildMetadataGapPayload(titles));
  }));

  app.get("/api/moon-v3/admin/wanted/metadata-gaps", requireWantedRead(async (_req, res) => {
    const titles = await loadLibrary();
    res.json(buildMetadataGapPayload(titles));
  }));

  app.get("/api/moon-v3/admin/wanted/metadata/:titleId/search", requireWantedRead(async (req, res) => {
    const title = await loadLibraryTitle(req.params.titleId);
    if (!title?.id) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    res.json(await fetchMetadataSearchResults(normalizeString(req.query.query, title.title), {
      libraryId: title.id
    }));
  }));

  app.post("/api/moon-v3/admin/wanted/metadata/:titleId/identify", requireWantedWrite(async (req, res) => {
    const title = await loadLibraryTitle(req.params.titleId);
    if (!title?.id) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    const selectedMetadata = normalizeObject(req.body?.selectedMetadata, {}) || {};
    const provider = normalizeString(selectedMetadata.provider);
    const providerSeriesId = normalizeString(selectedMetadata.providerSeriesId);
    if (!provider || !providerSeriesId) {
      res.status(400).json({error: "selectedMetadata with provider and providerSeriesId is required."});
      return;
    }

    const result = await serviceJson(config.ravenBaseUrl, "/v1/metadata/identify", {
      method: "POST",
      body: {
        provider,
        providerSeriesId,
        libraryId: title.id
      }
    });
    if (!result.ok) {
      res.status(result.status || 502).json(result.payload || {error: "Moon could not apply that metadata match."});
      return;
    }
    if (result.payload?.ok === false) {
      res.status(400).json(result.payload);
      return;
    }

    const refreshedTitle = await loadLibraryTitle(title.id);
    await appendEvent({
      ...buildUserActor(req.user, "admin"),
      domain: "wanted",
      eventType: "metadata-match-applied",
      severity: "info",
      targetType: "title",
      targetId: title.id,
      message: `${req.user.username} applied a metadata match to ${title.title}.`,
      metadata: {
        titleId: title.id,
        provider,
        providerSeriesId
      }
    });
    res.json({
      result: result.payload,
      title: refreshedTitle || title
    });
  }));

  app.get("/api/moon-v3/admin/requests", requireRequestRead(async (_req, res) => {
    const requests = await loadRequests();
    res.json({
      requests,
      counts: buildRequestSummaryCounts(requests)
    });
  }));

  app.get("/api/moon-v3/admin/requests/metadata-search", requireRequestWrite(async (req, res) => {
    res.json(await fetchMetadataSearchResults(req.query.query));
  }));

  app.post("/api/moon-v3/admin/requests/download-options", requireRequestWrite(async (req, res) => {
    const selectedMetadata = normalizeObject(req.body?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "selectedMetadata with provider and providerSeriesId is required."});
      return;
    }
    res.json(await fetchDownloadOptions({
      query: normalizeString(req.body?.query),
      selectedMetadata
    }));
  }));

  app.post("/api/moon-v3/admin/requests/:id/approve", requireRequestWrite(async (req, res) => {
    const existing = await loadRequestById(req.params.id);
    if (!existing) {
      res.status(404).json({error: "Request not found."});
      return;
    }

    const selectedMetadata = normalizeObject(req.body?.selectedMetadata, existing.details?.selectedMetadata) || existing.details?.selectedMetadata;
    const selectedDownload = normalizeObject(req.body?.selectedDownload, existing.details?.selectedDownload) || existing.details?.selectedDownload;
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "A concrete metadata match is required."});
      return;
    }
    if (!selectedDownload?.titleUrl) {
      res.status(409).json({error: "A concrete download match is required before the request can be approved."});
      return;
    }

    const guard = evaluateSelectionAgainstGuardState(buildIntakeSelection({
      query: normalizeString(req.body?.query, existing.details?.query),
      title: normalizeString(selectedMetadata.title, existing.title),
      requestType: normalizeString(selectedDownload.requestType, existing.requestType),
      selectedMetadata,
      selectedDownload
    }), await loadRequestGuardState(), {ignoreRequestId: req.params.id});
    if (guard.alreadyInLibrary) {
      res.status(409).json({error: "That title is already in the Scriptarr library."});
      return;
    }
    if (guard.alreadyQueuedOrRequested) {
      const duplicateRequest = await resolveDuplicateRequestSummary(guard);
      res.status(409).json(buildRequestWorkConflictPayload({
        payload: {
          code: "REQUEST_WORK_KEY_CONFLICT",
          requestId: normalizeString(duplicateRequest?.id),
          workKey: normalizeString(duplicateRequest?.workKey),
          workKeyKind: normalizeString(duplicateRequest?.workKeyKind)
        }
      }));
      return;
    }

    try {
      await vaultClient.updateRequest(req.params.id, {
        title: normalizeString(selectedMetadata.title, existing.title),
        requestType: normalizeString(selectedDownload.requestType, existing.requestType),
        notes: normalizeString(req.body?.notes, existing.notes),
        status: "pending",
        actor: req.user.username,
        expectedRevision: normalizeExpectedRequestRevision(req.body?.expectedRevision),
        appendStatusEvent: false,
        detailsMerge: {
          query: normalizeString(req.body?.query, existing.details?.query),
          selectedMetadata,
          selectedDownload,
          availability: "available",
          sourceFoundAt: "",
          sourceFoundOptions: []
        }
      });
    } catch (error) {
      if (sendKnownRequestActionConflict(res, error)) {
        return;
      }
      throw error;
    }

    const approvedRequest = await loadRequestById(req.params.id);
    let approved = null;
    try {
      approved = await approveAndQueueRequest({
        requestId: req.params.id,
        requestSummary: approvedRequest,
        expectedRevision: approvedRequest?.revision,
        requestedBy: existing.requestedBy.discordUserId || req.user.discordUserId,
        actor: req.user.username,
        actorUser: req.user,
        comment: normalizeString(req.body?.comment, "Approved from Moon admin."),
        eventMessage: normalizeString(req.body?.comment, "Approved from Moon admin.")
      });
    } catch (error) {
      if (sendKnownRequestActionConflict(res, error)) {
        return;
      }
      throw error;
    }
    res.status(approved.status).json(approved.payload);
  }));

  app.post("/api/moon-v3/admin/requests/:id/deny", requireRequestWrite(async (req, res) => {
    const existing = await loadRequestById(req.params.id);
    if (!existing) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    const comment = normalizeString(req.body?.comment);
    if (!comment) {
      res.status(400).json({error: "A denial comment is required."});
      return;
    }

    let denied = null;
    try {
      denied = await vaultClient.reviewRequest(req.params.id, {
        status: "denied",
        comment,
        actor: req.user.username,
        expectedRevision: normalizeExpectedRequestRevision(req.body?.expectedRevision)
      });
    } catch (error) {
      if (sendKnownRequestActionConflict(res, error)) {
        return;
      }
      throw error;
    }
    await appendEventForUser({
      domain: "requests",
      eventType: "request-denied",
      severity: "warning",
      user: req.user,
      targetType: "request",
      targetId: normalizeString(req.params.id),
      message: `${req.user.username} denied a request.`,
      metadata: {
        requestId: normalizeString(req.params.id),
        title: normalizeString(existing.title),
        comment
      }
    });
    res.json(toRequestSummary(denied, await loadUserIndex()));
  }));

  app.post("/api/moon-v3/admin/requests/:id/override", requireRequestRoot(async (req, res) => {
    const existing = await loadRequestById(req.params.id);
    if (!existing) {
      res.status(404).json({error: "Request not found."});
      return;
    }

    const selectedMetadata = normalizeObject(req.body?.selectedMetadata) || existing.details?.selectedMetadata;
    const selectedDownload = normalizeObject(req.body?.selectedDownload);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "A concrete metadata match is required."});
      return;
    }

    const nextStatus = selectedDownload?.titleUrl ? "pending" : "unavailable";
    const guard = evaluateSelectionAgainstGuardState(buildIntakeSelection({
      query: normalizeString(req.body?.query, existing.details?.query),
      title: normalizeString(selectedMetadata.title, existing.title),
      requestType: normalizeString(selectedDownload?.requestType, existing.requestType),
      selectedMetadata,
      selectedDownload
    }), await loadRequestGuardState(), {ignoreRequestId: req.params.id});
    if (guard.alreadyInLibrary) {
      res.status(409).json({error: "That title is already in the Scriptarr library."});
      return;
    }
    if (guard.alreadyQueuedOrRequested) {
      const duplicateRequest = await resolveDuplicateRequestSummary(guard);
      res.status(409).json(buildRequestWorkConflictPayload({
        payload: {
          code: "REQUEST_WORK_KEY_CONFLICT",
          requestId: normalizeString(duplicateRequest?.id),
          workKey: normalizeString(duplicateRequest?.workKey),
          workKeyKind: normalizeString(duplicateRequest?.workKeyKind)
        }
      }));
      return;
    }

    try {
      await vaultClient.updateRequest(req.params.id, {
        title: normalizeString(selectedMetadata.title, existing.title),
        requestType: normalizeString(selectedDownload?.requestType, existing.requestType),
        notes: normalizeString(req.body?.notes, existing.notes),
        status: nextStatus,
        actor: req.user.username,
        expectedRevision: normalizeExpectedRequestRevision(req.body?.expectedRevision),
        appendStatusEvent: false,
        detailsMerge: {
          query: normalizeString(req.body?.query, existing.details?.query),
          selectedMetadata,
          selectedDownload,
          availability: selectedDownload?.titleUrl ? "available" : "unavailable",
          sourceFoundAt: selectedDownload?.titleUrl ? "" : existing.details?.sourceFoundAt,
          sourceFoundOptions: selectedDownload?.titleUrl ? [] : existing.details?.sourceFoundOptions
        }
      });
    } catch (error) {
      if (sendKnownRequestActionConflict(res, error)) {
        return;
      }
      throw error;
    }
    await appendEvent({
      ...buildUserActor(req.user, "admin"),
      domain: "requests",
      eventType: "request-overridden",
      severity: "warn",
      targetType: "request",
      targetId: normalizeString(req.params.id),
      message: `${req.user.username} overrode the saved metadata or source for a request.`,
      metadata: {
        requestId: normalizeString(req.params.id),
        title: normalizeString(selectedMetadata.title, existing.title),
        availability: selectedDownload?.titleUrl ? "available" : "unavailable"
      }
    });
    res.json(await loadRequestById(req.params.id));
  }));

  app.post("/api/moon-v3/admin/requests/:id/resolve", requireRequestWrite(async (req, res) => {
    const existing = await loadRequestById(req.params.id);
    if (!existing) {
      res.status(404).json({error: "Request not found."});
      return;
    }

    const selectedMetadata = normalizeObject(req.body?.selectedMetadata) || existing.details?.selectedMetadata;
    const selectedDownload = normalizeObject(req.body?.selectedDownload);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId || !selectedDownload?.titleUrl) {
      res.status(400).json({error: "A concrete metadata and download match are required to resolve this request."});
      return;
    }

    const guard = evaluateSelectionAgainstGuardState(buildIntakeSelection({
      query: normalizeString(req.body?.query, existing.details?.query),
      title: normalizeString(existing.title),
      requestType: normalizeString(selectedDownload.requestType, existing.requestType),
      selectedMetadata,
      selectedDownload
    }), await loadRequestGuardState(), {ignoreRequestId: req.params.id});
    if (guard.alreadyInLibrary) {
      res.status(409).json({error: "That title is already in the Scriptarr library."});
      return;
    }
    if (guard.alreadyQueuedOrRequested) {
      const duplicateRequest = await resolveDuplicateRequestSummary(guard);
      res.status(409).json(buildRequestWorkConflictPayload({
        payload: {
          code: "REQUEST_WORK_KEY_CONFLICT",
          requestId: normalizeString(duplicateRequest?.id),
          workKey: normalizeString(duplicateRequest?.workKey),
          workKeyKind: normalizeString(duplicateRequest?.workKeyKind)
        }
      }));
      return;
    }

    try {
      await vaultClient.updateRequest(req.params.id, {
        title: normalizeString(selectedMetadata.title, existing.title),
        requestType: normalizeString(selectedDownload.requestType, existing.requestType),
        notes: normalizeString(req.body?.notes, existing.notes),
        expectedRevision: normalizeExpectedRequestRevision(req.body?.expectedRevision),
        detailsMerge: {
          query: normalizeString(req.body?.query, existing.details?.query),
          selectedMetadata,
          selectedDownload,
          availability: "available"
        },
        actor: req.user.username
      });
    } catch (error) {
      if (sendKnownRequestActionConflict(res, error)) {
        return;
      }
      throw error;
    }
    const refreshed = await loadRequestById(req.params.id);
    const queueResult = await queueSelectedDownload({
      requestId: req.params.id,
      requestSummary: refreshed,
      requestedBy: existing.requestedBy.discordUserId || req.user.discordUserId
    });
    if (!queueResult.ok) {
      res.status(queueResult.status).json(queueResult.payload);
      return;
    }

    let queuedRequest = null;
    try {
      queuedRequest = await markRequestQueuedAfterRaven({
        requestId: req.params.id,
        requestSummary: refreshed,
        queueResult,
        expectedRevision: refreshed?.revision,
        eventMessage: "Unavailable request resolved and queued from Moon admin.",
        moderatorComment: "",
        actor: req.user.username
      });
    } catch (error) {
      if (sendKnownRequestActionConflict(res, error)) {
        return;
      }
      throw error;
    }
    await appendEvent({
      ...buildUserActor(req.user, "admin"),
      domain: "requests",
      eventType: "request-resolved",
      severity: "info",
      targetType: "request",
      targetId: normalizeString(req.params.id),
      message: `${req.user.username} resolved an unavailable request and queued it.`,
      metadata: {
        requestId: normalizeString(req.params.id),
        queue: queueResult.payload || {}
      }
    });

    res.status(202).json({
      request: queuedRequest,
      queue: queueResult.payload
    });
  }));

  app.post("/api/moon-v3/admin/requests/:id/refresh-sources", requireRequestWrite(async (req, res) => {
    const existing = await loadRequestById(req.params.id);
    if (!existing) {
      res.status(404).json({error: "Request not found."});
      return;
    }

    const selectedMetadata = normalizeObject(existing.details?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "This request does not have a saved metadata selection."});
      return;
    }

    const downloads = await fetchDownloadOptions({
      query: normalizeString(existing.details?.query, existing.title),
      selectedMetadata
    });
    const nextOptions = normalizeArray(downloads.results);
    try {
      await vaultClient.updateRequest(req.params.id, {
        status: nextOptions.length ? "pending" : "unavailable",
        actor: req.user.username,
        expectedRevision: normalizeExpectedRequestRevision(req.body?.expectedRevision),
        appendStatusEvent: false,
        detailsMerge: {
          selectedMetadata: normalizeObject(downloads.selectedMetadata, selectedMetadata) || selectedMetadata,
          selectedDownload: null,
          availability: nextOptions.length ? "available" : "unavailable",
          sourceFoundAt: nextOptions.length ? new Date().toISOString() : "",
          sourceFoundOptions: nextOptions
        }
      });
    } catch (error) {
      if (sendKnownRequestActionConflict(res, error)) {
        return;
      }
      throw error;
    }
    await appendEvent({
      ...buildUserActor(req.user, "admin"),
      domain: "requests",
      eventType: "request-sources-refreshed",
      severity: "info",
      targetType: "request",
      targetId: normalizeString(req.params.id),
      message: `${req.user.username} refreshed download candidates for a request.`,
      metadata: {
        requestId: normalizeString(req.params.id),
        availability: nextOptions.length ? "available" : "unavailable",
        optionCount: nextOptions.length
      }
    });

    res.json({
      request: await loadRequestById(req.params.id),
      results: nextOptions,
      availability: nextOptions.length ? "available" : "unavailable"
    });
  }));

  app.get("/api/moon-v3/admin/users", requireUsersRead(async (_req, res) => {
    const [accessOverview, recentEvents] = await Promise.all([
      vaultClient.getAccessOverview(),
      vaultClient.listEvents({
        domains: ["auth", "users", "access"],
        limit: 40
      })
    ]);
    res.json({
      users: normalizeArray(accessOverview?.users),
      groups: normalizeArray(accessOverview?.groups),
      defaultGroupId: normalizeString(accessOverview?.defaultGroupId),
      domains: ADMIN_ACCESS_DOMAINS,
      events: normalizeArray(recentEvents)
    });
  }));

  app.post("/api/moon-v3/admin/users/groups", requireUsersRoot(async (req, res) => {
    const group = await vaultClient.createPermissionGroup(req.body || {});
    await appendEventForUser({
      domain: "users",
      eventType: "group-created",
      user: req.user,
      targetType: "permission-group",
      targetId: normalizeString(group?.id),
      message: `${req.user.username} created the ${normalizeString(group?.name, "new")} permission group.`,
      metadata: {
        groupId: normalizeString(group?.id),
        name: normalizeString(group?.name)
      }
    });
    res.status(201).json(group);
  }));

  app.patch("/api/moon-v3/admin/users/groups/:groupId", requireUsersRoot(async (req, res) => {
    const group = await vaultClient.updatePermissionGroup(req.params.groupId, req.body || {});
    if (!group) {
      res.status(404).json({error: "Permission group not found."});
      return;
    }
    await appendEventForUser({
      domain: "users",
      eventType: "group-updated",
      user: req.user,
      targetType: "permission-group",
      targetId: normalizeString(group.id),
      message: `${req.user.username} updated the ${normalizeString(group.name, "permission")} group.`,
      metadata: {
        groupId: normalizeString(group.id),
        name: normalizeString(group.name),
        isDefault: Boolean(group.isDefault)
      }
    });
    res.json(group);
  }));

  app.delete("/api/moon-v3/admin/users/groups/:groupId", requireUsersRoot(async (req, res) => {
    const group = await vaultClient.deletePermissionGroup(req.params.groupId);
    if (!group) {
      res.status(404).json({error: "Permission group not found."});
      return;
    }
    await appendEventForUser({
      domain: "users",
      eventType: "group-deleted",
      user: req.user,
      targetType: "permission-group",
      targetId: normalizeString(group.id),
      message: `${req.user.username} deleted the ${normalizeString(group.name, "permission")} group.`,
      metadata: {
        groupId: normalizeString(group.id),
        name: normalizeString(group.name)
      }
    });
    res.json(group);
  }));

  app.put("/api/moon-v3/admin/users/:discordUserId/groups", requireUsersRoot(async (req, res) => {
    const user = await vaultClient.assignUserGroups(
      req.params.discordUserId,
      normalizeArray(req.body?.groupIds).map((entry) => normalizeString(entry)).filter(Boolean)
    );
    if (!user) {
      res.status(404).json({error: "User not found."});
      return;
    }
    await appendEventForUser({
      domain: "access",
      eventType: "user-groups-updated",
      user: req.user,
      targetType: "user",
      targetId: normalizeString(user.discordUserId),
      message: `${req.user.username} updated access groups for ${normalizeString(user.username, "that user")}.`,
      metadata: {
        discordUserId: normalizeString(user.discordUserId),
        username: normalizeString(user.username),
        groupIds: normalizeArray(user.groups).map((group) => normalizeString(group.id))
      }
    });
    res.json(user);
  }));

  app.delete("/api/moon-v3/admin/users/:discordUserId", requireUsersRoot(async (req, res) => {
    const user = await vaultClient.deleteUser(req.params.discordUserId);
    if (!user) {
      res.status(404).json({error: "User not found."});
      return;
    }
    await appendEventForUser({
      domain: "users",
      eventType: "user-deleted",
      user: req.user,
      targetType: "user",
      targetId: normalizeString(user.discordUserId),
      message: `${req.user.username} removed ${normalizeString(user.username, "a user")} from local Moon access.`,
      metadata: {
        discordUserId: normalizeString(user.discordUserId),
        username: normalizeString(user.username)
      }
    });
    res.json(user);
  }));

  app.get("/api/moon-v3/admin/mediamanagement", requireMediaManagementRead(async (_req, res) => {
    const naming = await readRavenNamingSettings();
    res.json({naming});
  }));

  const buildToastSettingsPayload = async (user) => {
    if (readAdminToastSettings) {
      return readAdminToastSettings(user);
    }
    const global = defaultAdminToastSettings();
    return {
      global,
      personal: null,
      effective: mergeAdminToastSettings(global, null),
      canEditGlobal: hasDomainAccess(user, "settings", "root")
    };
  };

  const ravenVpnRuntimeFromHealth = (ravenHealth) => ravenHealth?.ok ? normalizeObject(ravenHealth.payload?.vpn, {}) : {
    enabled: false,
    connected: false,
    protected: false,
    settingsFresh: false,
    runtimeCapable: false,
    lastCheckedAt: "",
    settingsLastLoadedAt: "",
    lastError: normalizeString(ravenHealth?.payload?.error, "Raven health is unavailable.")
  };

  const buildSettingsPayload = async (user) => {
    const [ravenVpn, metadataProviders, downloadProviders, ravenDownloadRuntime, requestWorkflow, branding, discord, toastSettings] = await Promise.all([
      readRavenVpnSettings(),
      readMetadataProviderSettings(),
      readDownloadProviderSettings(),
      readRavenDownloadRuntimeSettings(),
      readRequestWorkflowSettings(),
      readMoonBrandingSettings(),
      readPortalDiscordSettings(),
      buildToastSettingsPayload(user)
    ]);

    return {
      ravenVpn,
      ravenVpnRuntime: {
        state: ravenVpn.enabled ? "armed" : "disabled",
        enabled: Boolean(ravenVpn.enabled),
        connected: false,
        protected: false,
        settingsFresh: true,
        runtimeCapable: true,
        lastCheckedAt: "",
        settingsLastLoadedAt: "",
        lastError: ""
      },
      metadataProviders,
      downloadProviders,
      ravenDownloadRuntime,
      requestWorkflow,
      branding,
      publicBranding: publicMoonBranding(branding),
      discord: {
        ...discord,
        runtime: {}
      },
      toastSettings,
      databaseOverview: null,
      links: {
        databaseExplorer: "/admin/settings/database",
        noonaProject: "https://github.com/The-Noona-Project/Scriptarr",
        supportDiscord: "https://discord.gg/HMYHT8KD5v"
      }
    };
  };

  const portalInternalHeaders = () => {
    const sageToken = config.serviceTokens?.["scriptarr-sage"];
    return sageToken ? {"Authorization": `Bearer ${sageToken}`} : {};
  };

  const loadPortalDiscordRuntime = async (settings) => {
    const [health, commands] = await Promise.all([
      safeJson(serviceJson(config.portalBaseUrl, "/health", {timeoutMs: 2500})),
      safeJson(serviceJson(config.portalBaseUrl, "/api/commands", {timeoutMs: 2500}))
    ]);
    const healthPayload = health?.payload || health;
    return {
      authConfigured: Boolean(config.discordClientId && config.discordClientSecret),
      botTokenConfigured: Boolean(config.discordToken),
      appaAuthConfigured: Boolean(config.appaDiscordClientId),
      appaBotTokenConfigured: Boolean(config.appaDiscordToken),
      configuredGuildId: normalizeString(settings?.guildId),
      connected: Boolean(healthPayload?.runtime?.connected ?? healthPayload?.connected),
      connectionState: normalizeString(healthPayload?.runtime?.connectionState, normalizeString(healthPayload?.discord, "degraded")),
      registeredGuildId: normalizeString(healthPayload?.runtime?.registeredGuildId, normalizeString(settings?.guildId)),
      error: normalizeString(healthPayload?.runtime?.error),
      syncError: normalizeString(healthPayload?.runtime?.syncError),
      warning: normalizeString(healthPayload?.runtime?.warning),
      appa: healthPayload?.runtime?.appa || {},
      capabilities: healthPayload?.runtime?.capabilities || {},
      commandInventory: normalizeArray(commands?.payload?.commands || commands?.commands).length > 0
        ? normalizeArray(commands?.payload?.commands || commands?.commands)
        : knownPortalDiscordCommands,
      portal: healthPayload
    };
  };

  const buildSettingsRuntimePayload = async (user) => {
    const discord = await readPortalDiscordSettings();
    const [databaseOverview, ravenHealth, discordRuntime] = await Promise.all([
      hasDomainAccess(user, "database", "read") ? vaultClient.getDatabaseOverview().catch((error) => ({
        error: error instanceof Error ? error.message : String(error)
      })) : null,
      serviceJson(config.ravenBaseUrl, "/health").catch((error) => ({
        ok: false,
        status: 0,
        payload: {error: error instanceof Error ? error.message : String(error)}
      })),
      loadPortalDiscordRuntime(discord)
    ]);

    return {
      ravenVpnRuntime: ravenVpnRuntimeFromHealth(ravenHealth),
      databaseOverview,
      discordRuntime
    };
  };

  const buildDiscordPayload = async (adminUser = null) => {
    const settings = normalizePortalDiscordSettings(await readPortalDiscordSettings());
    const canRevealTriviaAnswer = hasDomainAccess(adminUser, "discord", "root");
    const [runtime, triviaRuntime, noonaMemory, appaAudit] = await Promise.all([
      loadPortalDiscordRuntime(settings),
      triviaService.getAdminState({includeActiveAnswer: canRevealTriviaAnswer}),
      buildNoonaMemoryAdminPayload(vaultClient),
      vaultClient.listEvents({
        domain: "discord",
        eventType: "noona-public-review",
        limit: 10
      }).catch(() => [])
    ]);
    return {
      settings,
      runtime,
      triviaRuntime,
      noonaMemory,
      appaAudit: {
        events: normalizeArray(appaAudit).slice(0, 10)
      },
      commandCatalog: knownPortalDiscordCommands
    };
  };

  const persistDiscordSettings = async (req, body, message) => {
    const nextSettings = normalizePortalDiscordSettings(body || {});
    await vaultClient.setSetting(PORTAL_DISCORD_KEY, nextSettings);
    const reload = await safeJson(serviceJson(config.portalBaseUrl, "/api/runtime/discord/reload", {
      method: "POST",
      headers: portalInternalHeaders(),
      body: {}
    }));
    await appendEventForUser({
      domain: "discord",
      eventType: "discord-settings-updated",
      user: req.user,
      targetType: "setting",
      targetId: PORTAL_DISCORD_KEY,
      message,
      metadata: {
        guildId: nextSettings.guildId,
        onboardingChannelId: nextSettings.onboarding.channelId,
        releaseChannelId: nextSettings.notifications.releaseChannelId,
        updateChannelId: nextSettings.notifications.updateChannelId,
        noonaChatEnabled: nextSettings.noonaChat.enabled,
        noonaChatChannelCount: normalizeArray(nextSettings.noonaChat.allowedChannelIds).length,
        noonaChatMemoryEnabled: nextSettings.noonaChat.memoryEnabled,
        noonaChatProposalMode: nextSettings.noonaChat.proposalMode,
        appaEnabled: nextSettings.appa.enabled,
        appaReviewEnabled: nextSettings.appa.reviewEnabled,
        appaAdminMentionChannelCount: normalizeArray(nextSettings.appa.adminMentionChannelIds).length,
        triviaEnabled: nextSettings.trivia.enabled,
        triviaChannelId: nextSettings.trivia.channelId
      }
    });
    const payload = await buildDiscordPayload(req.user);
    return {
      ...payload,
      runtime: {
        ...payload.runtime,
        reload: reload.payload || reload
      }
    };
  };

  app.get("/api/moon-v3/admin/settings", requireSettingsRead(async (req, res) => {
    res.json(await buildSettingsPayload(req.user));
  }));

  app.get("/api/moon-v3/admin/settings/runtime", requireSettingsRead(async (req, res) => {
    res.json(await buildSettingsRuntimePayload(req.user));
  }));

  app.get("/api/moon-v3/admin/settings/toasts", requireSettingsRead(async (req, res) => {
    res.json(await buildToastSettingsPayload(req.user));
  }));

  app.get("/api/moon-v3/admin/discord", requireDiscordRead(async (req, res) => {
    res.json(await buildDiscordPayload(req.user));
  }));

  app.put("/api/moon-v3/admin/discord", requireDiscordWrite(async (req, res) => {
    res.json(await persistDiscordSettings(req, req.body, `${req.user.username} updated Discord integration settings.`));
  }));

  app.post("/api/moon-v3/admin/discord/runtime/reload", requireDiscordWrite(async (req, res) => {
    const settings = normalizePortalDiscordSettings(await readPortalDiscordSettings());
    const reload = await safeJson(serviceJson(config.portalBaseUrl, "/api/runtime/discord/reload", {
      method: "POST",
      headers: portalInternalHeaders(),
      body: {}
    }));
    const runtime = await loadPortalDiscordRuntime(settings);
    await appendEventForUser({
      domain: "discord",
      eventType: "discord-runtime-reloaded",
      user: req.user,
      targetType: "runtime",
      targetId: "portal-discord",
      message: `${req.user.username} reloaded the Portal Discord runtime.`,
      metadata: {
        connected: runtime.connected,
        reload: reload.payload || reload
      }
    });
    res.json({
      settings,
      runtime: {
        ...runtime,
        reload: reload.payload || reload
      },
      triviaRuntime: await triviaService.getAdminState({includeActiveAnswer: hasDomainAccess(req.user, "discord", "root")}),
      noonaMemory: await buildNoonaMemoryAdminPayload(vaultClient),
      commandCatalog: knownPortalDiscordCommands
    });
  }));

  app.post("/api/moon-v3/admin/discord/onboarding/test", requireDiscordWrite(async (req, res) => {
    const [discordSettings, branding] = await Promise.all([
      readPortalDiscordSettings(),
      readMoonBrandingSettings()
    ]);
    const body = normalizeObject(req.body, {}) || {};
    const previewSettings = normalizePortalDiscordSettings({
      ...discordSettings,
      ...body,
      onboarding: {
        ...discordSettings.onboarding,
        ...normalizeObject(body.onboarding, {})
      },
      notifications: {
        ...discordSettings.notifications,
        ...normalizeObject(body.notifications, {})
      }
    });
    const username = normalizeString(body.username, "Discord Reader");
    const rendered = renderPortalOnboardingTemplate({
      template: previewSettings.onboarding.template,
      username,
      userMention: body.userMention,
      siteName: branding.siteName,
      guildName: normalizeString(body.guildName, "Scriptarr Admin Preview"),
      guildId: previewSettings.guildId,
      moonUrl: config.publicBaseUrl
    });
    const portal = await safeJson(serviceJson(config.portalBaseUrl, "/api/onboarding/test", {
      method: "POST",
      headers: portalInternalHeaders(),
      body: {
        username,
        settings: previewSettings,
        branding,
        rendered
      }
    }));

    if (!portal.ok) {
      res.status(portal.status || 503).json({
        error: portal.payload?.error || "Portal could not send the onboarding test.",
        rendered,
        preview: {
          username,
          siteName: branding.siteName,
          guildId: previewSettings.guildId,
          channelId: previewSettings.onboarding.channelId
        }
      });
      return;
    }

    res.json({
      rendered,
      preview: {
        username,
        siteName: branding.siteName,
        guildId: previewSettings.guildId,
        channelId: previewSettings.onboarding.channelId
      },
      portal: portal.payload || portal
    });
  }));

  app.post("/api/moon-v3/admin/discord/release-notifications/test", requireDiscordWrite(async (req, res) => {
    const [discordSettings, branding] = await Promise.all([
      readPortalDiscordSettings(),
      readMoonBrandingSettings()
    ]);
    const body = normalizeObject(req.body, {}) || {};
    const previewSettings = normalizePortalDiscordSettings({
      ...discordSettings,
      ...body,
      notifications: {
        ...discordSettings.notifications,
        ...normalizeObject(body.notifications, {})
      }
    });
    const releaseChannelId = normalizeString(previewSettings.notifications.releaseChannelId);
    if (!releaseChannelId) {
      res.status(400).json({error: "A release notification channel id is required."});
      return;
    }
    const portal = await safeJson(serviceJson(config.portalBaseUrl, "/api/notifications/release/test", {
      method: "POST",
      headers: portalInternalHeaders(),
      body: {
        settings: previewSettings,
        branding,
        notification: {
          id: `release-test:${Date.now()}`,
          channelId: releaseChannelId,
          titleName: normalizeString(body.titleName, `${branding.siteName || "Scriptarr"} test title`),
          chapterLabel: normalizeString(body.chapterLabel, "Chapter 1"),
          titleUrl: `${normalizeString(config.publicBaseUrl).replace(/\/+$/g, "")}/admin/discord`
        }
      }
    }));
    if (!portal.ok) {
      res.status(portal.status || 503).json({
        error: portal.payload?.error || "Portal could not send the release notification test."
      });
      return;
    }
    res.json(portal.payload || portal);
  }));

  app.post("/api/moon-v3/admin/discord/update-notifications/test", requireDiscordWrite(async (req, res) => {
    const [discordSettings, branding] = await Promise.all([
      readPortalDiscordSettings(),
      readMoonBrandingSettings()
    ]);
    const body = normalizeObject(req.body, {}) || {};
    const previewSettings = normalizePortalDiscordSettings({
      ...discordSettings,
      ...body,
      notifications: {
        ...discordSettings.notifications,
        ...normalizeObject(body.notifications, {})
      }
    });
    const updateChannelId = normalizeString(previewSettings.notifications.updateChannelId);
    if (!updateChannelId) {
      res.status(400).json({error: "An update notification channel id is required."});
      return;
    }
    const portal = await safeJson(serviceJson(config.portalBaseUrl, "/api/notifications/update/test", {
      method: "POST",
      headers: portalInternalHeaders(),
      body: {
        settings: previewSettings,
        branding,
        notification: {
          id: `update-test:${Date.now()}`,
          channelId: updateChannelId,
          repository: "The-Noona-Project/Scriptarr",
          branch: "main",
          summary: normalizeString(
            body.summary,
            `Noona test update for ${branding.siteName || "Scriptarr"} is ready. Ask Noona what changed to try the new flow.`
          ),
          compareUrl: "https://github.com/The-Noona-Project/Scriptarr",
          commitCount: 1,
          latestSha: "test-update"
        }
      }
    }));
    if (!portal.ok) {
      res.status(portal.status || 503).json({
        error: portal.payload?.error || "Portal could not send the update notification test."
      });
      return;
    }
    res.json(portal.payload || portal);
  }));

  app.delete("/api/moon-v3/admin/discord/noona-memory", requireDiscordWrite(async (req, res) => {
    const cleared = await clearNoonaMemory(vaultClient, {
      scope: req.body?.scope || req.query?.scope || "all",
      discordUserId: req.body?.discordUserId || req.query?.discordUserId || ""
    });
    await appendEventForUser({
      domain: "discord",
      eventType: "discord-noona-memory-cleared",
      user: req.user,
      targetType: "setting",
      targetId: "portal.noonaChat.memory",
      message: `${req.user.username} cleared Noona mention-chat memory.`,
      metadata: {
        scope: normalizeString(req.body?.scope || req.query?.scope, "all"),
        discordUserId: normalizeString(req.body?.discordUserId || req.query?.discordUserId)
      }
    });
    res.json({
      ok: true,
      memory: await buildNoonaMemoryAdminPayload(vaultClient),
      raw: cleared
    });
  }));

  const runPortalTriviaAction = async (req, res, action, path, body = {}) => {
    const portal = await safeJson(serviceJson(config.portalBaseUrl, path, {
      method: "POST",
      headers: portalInternalHeaders(),
      body: {
        requestedBy: {
          discordUserId: normalizeString(req.user?.discordUserId),
          username: normalizeString(req.user?.username, "Admin")
        },
        ...body
      },
      timeoutMs: action === "leaderboard-test" ? 5000 : 20000
    }));
    if (!portal.ok) {
      res.status(portal.status || 503).json({
        error: portal.payload?.error || `${action} failed.`
      });
      return;
    }
    await appendEventForUser({
      domain: "discord",
      eventType: `discord-trivia-${action}`,
      user: req.user,
      targetType: "discord-trivia",
      targetId: "portal-trivia",
      message: `${req.user.username} requested Discord trivia ${action}.`,
      metadata: portal.payload || portal
    });
    res.json(portal.payload || portal);
  };

  app.post("/api/moon-v3/admin/discord/trivia/start", requireDiscordWrite(async (req, res) => {
    await runPortalTriviaAction(req, res, "start", "/api/trivia/start", {
      force: req.body?.force !== false,
      settings: req.body?.settings || null
    });
  }));

  app.post("/api/moon-v3/admin/discord/trivia/stop", requireDiscordWrite(async (req, res) => {
    await runPortalTriviaAction(req, res, "stop", "/api/trivia/stop", {});
  }));

  app.post("/api/moon-v3/admin/discord/trivia/leaderboard/test", requireDiscordWrite(async (req, res) => {
    await runPortalTriviaAction(req, res, "leaderboard-test", "/api/trivia/leaderboard/test", {
      window: normalizeString(req.body?.window, "all"),
      defer: req.body?.defer !== false,
      settings: req.body?.settings || null
    });
  }));

  app.put("/api/moon-v3/admin/settings/branding", requireSettingsWrite(async (req, res) => {
    const existing = await readMoonBrandingSettings();
    const nextBranding = normalizeMoonBrandingSettings({
      ...existing,
      ...req.body,
      logo: existing.logo
    });
    await vaultClient.setSetting(MOON_BRANDING_KEY, nextBranding);
    await appendEventForUser({
      domain: "settings",
      eventType: "branding-updated",
      user: req.user,
      targetType: "setting",
      targetId: MOON_BRANDING_KEY,
      message: `${req.user.username} updated Moon branding.`,
      metadata: {
        siteName: nextBranding.siteName
      }
    });
    res.json({
      branding: nextBranding,
      publicBranding: publicMoonBranding(nextBranding)
    });
  }));

  app.put("/api/moon-v3/admin/settings/branding/logo", requireSettingsWrite(async (req, res) => {
    const existing = await readMoonBrandingSettings();
    const now = new Date().toISOString();
    const nextBranding = normalizeMoonBrandingSettings({
      ...existing,
      logo: {
        enabled: true,
        revision: normalizeString(req.body?.revision, `logo-${Date.now()}`),
        updatedAt: now,
        updatedBy: buildUserActor(req.user, req.authMethod === "api-key" ? "api-key" : "admin"),
        originalMimeType: normalizeString(req.body?.originalMimeType),
        originalBytes: Number.parseInt(String(req.body?.originalBytes || 0), 10) || 0,
        variants: req.body?.variants || {}
      }
    });
    await vaultClient.setSetting(MOON_BRANDING_KEY, nextBranding);
    await appendEventForUser({
      domain: "settings",
      eventType: "brand-logo-updated",
      user: req.user,
      targetType: "setting",
      targetId: MOON_BRANDING_KEY,
      message: `${req.user.username} updated the brand logo.`,
      metadata: {
        revision: nextBranding.logo?.revision,
        originalBytes: nextBranding.logo?.originalBytes
      }
    });
    res.json({
      branding: nextBranding,
      publicBranding: publicMoonBranding(nextBranding)
    });
  }));

  app.delete("/api/moon-v3/admin/settings/branding/logo", requireSettingsWrite(async (req, res) => {
    const existing = await readMoonBrandingSettings();
    const nextBranding = normalizeMoonBrandingSettings({
      ...existing,
      logo: {
        enabled: false,
        revision: "",
        variants: {}
      }
    });
    await vaultClient.setSetting(MOON_BRANDING_KEY, nextBranding);
    await appendEventForUser({
      domain: "settings",
      eventType: "brand-logo-removed",
      user: req.user,
      targetType: "setting",
      targetId: MOON_BRANDING_KEY,
      message: `${req.user.username} removed the brand logo.`,
      metadata: {}
    });
    res.json({
      branding: nextBranding,
      publicBranding: publicMoonBranding(nextBranding)
    });
  }));

  app.put("/api/moon-v3/admin/settings/toasts/personal", requireSettingsRead(async (req, res) => {
    const global = normalizeAdminToastSettings((await vaultClient.getSetting(ADMIN_TOAST_GLOBAL_KEY))?.value);
    const personal = normalizeAdminToastSettings(req.body || {}, global);
    await vaultClient.setSetting(adminToastUserKey(req.user.discordUserId), personal);
    res.json(await buildToastSettingsPayload(req.user));
  }));

  app.put("/api/moon-v3/admin/settings/toasts/global", requireSettingsRoot(async (req, res) => {
    const global = normalizeAdminToastSettings(req.body || {});
    await vaultClient.setSetting(ADMIN_TOAST_GLOBAL_KEY, global);
    await appendEventForUser({
      domain: "settings",
      eventType: "toast-settings-updated",
      user: req.user,
      targetType: "setting",
      targetId: ADMIN_TOAST_GLOBAL_KEY,
      message: `${req.user.username} updated admin toast defaults.`,
      metadata: {}
    });
    res.json(await buildToastSettingsPayload(req.user));
  }));

  app.put("/api/moon-v3/admin/settings/raven/vpn", requireSettingsWrite(async (req, res) => {
    const existing = await readRavenVpnSettings();
    const password = normalizeString(req.body?.piaPassword);
    const nextSettings = {
      key: RAVEN_VPN_KEY,
      enabled: req.body?.enabled === true,
      region: normalizeString(req.body?.region, existing.region || "us_california"),
      piaUsername: normalizeString(req.body?.piaUsername, existing.piaUsername)
    };
    await vaultClient.setSetting(RAVEN_VPN_KEY, nextSettings);
    if (password) {
      await vaultClient.setSecret(RAVEN_VPN_PASSWORD_SECRET, password);
    }
    const saved = await readRavenVpnSettings();
    await appendEventForUser({
      domain: "settings",
      eventType: "raven-vpn-updated",
      user: req.user,
      targetType: "setting",
      targetId: RAVEN_VPN_KEY,
      message: `${req.user.username} updated Raven VPN settings.`,
      metadata: {
        enabled: saved.enabled,
        region: saved.region
      }
    });
    res.json(saved);
  }));

  app.post("/api/moon-v3/admin/settings/raven/vpn/test", requireSettingsWrite(async (req, res) => {
    let result;
    try {
      result = await serviceJson(config.ravenBaseUrl, "/v1/vpn/test", {
        method: "POST",
        body: {},
        timeoutMs: 120000
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        vpn: {},
        error: error instanceof Error ? error.message : "Raven VPN test failed."
      });
      return;
    }
    const payload = normalizeObject(result.payload, {}) || {};
    const vpn = normalizeObject(payload.vpn, payload) || {};
    const ok = result.ok && payload.ok !== false;
    await appendEventForUser({
      domain: "settings",
      eventType: "raven-vpn-tested",
      user: req.user,
      targetType: "setting",
      targetId: RAVEN_VPN_KEY,
      message: `${req.user.username} tested the Raven VPN connection.`,
      metadata: {
        ok,
        state: normalizeString(vpn.state),
        protected: vpn.protected === true,
        region: normalizeString(vpn.region)
      }
    });
    res.status(ok ? 200 : result.status || 503).json({
      ok,
      vpn,
      error: ok ? "" : normalizeString(payload.error, normalizeString(vpn.lastError, "Raven VPN test failed."))
    });
  }));

  app.put("/api/moon-v3/admin/settings/raven/metadata", requireSettingsWrite(async (req, res) => {
    const existing = await readMetadataProviderSettings();
    const nextSettings = {
      ...existing,
      key: RAVEN_METADATA_KEY,
      providers: normalizeArray(req.body?.providers).length ? normalizeArray(req.body.providers) : normalizeArray(existing.providers)
    };
    await vaultClient.setSetting(RAVEN_METADATA_KEY, nextSettings);
    const saved = await readMetadataProviderSettings();
    await appendEventForUser({
      domain: "settings",
      eventType: "metadata-providers-updated",
      user: req.user,
      targetType: "setting",
      targetId: RAVEN_METADATA_KEY,
      message: `${req.user.username} updated the metadata provider stack.`,
      metadata: {
        providers: normalizeArray(saved.providers).map((provider) => ({
          id: normalizeString(provider.id),
          enabled: provider.enabled !== false,
          priority: provider.priority
        }))
      }
    });
    res.json(saved);
  }));

  app.put("/api/moon-v3/admin/settings/raven/download-providers", requireSettingsWrite(async (req, res) => {
    const existing = await readDownloadProviderSettings();
    const nextSettings = {
      ...existing,
      key: RAVEN_DOWNLOAD_PROVIDERS_KEY,
      providers: normalizeArray(req.body?.providers).length ? normalizeArray(req.body.providers) : normalizeArray(existing.providers)
    };
    await vaultClient.setSetting(RAVEN_DOWNLOAD_PROVIDERS_KEY, nextSettings);
    const saved = await readDownloadProviderSettings();
    await appendEventForUser({
      domain: "settings",
      eventType: "download-providers-updated",
      user: req.user,
      targetType: "setting",
      targetId: RAVEN_DOWNLOAD_PROVIDERS_KEY,
      message: `${req.user.username} updated the download provider stack.`,
      metadata: {
        providers: normalizeArray(saved.providers).map((provider) => ({
          id: normalizeString(provider.id),
          enabled: provider.enabled !== false,
          priority: provider.priority
        }))
      }
    });
    res.json(saved);
  }));

  app.put("/api/moon-v3/admin/settings/raven/download-runtime", requireSettingsWrite(async (req, res) => {
    const validation = validateActiveTitleDownloads(req.body?.activeTitleDownloads);
    if (!validation.ok) {
      res.status(400).json({error: validation.error});
      return;
    }
    const nextSettings = normalizeRavenDownloadRuntimeSettings({
      activeTitleDownloads: validation.value
    });
    await vaultClient.setSetting(RAVEN_DOWNLOAD_RUNTIME_KEY, nextSettings);
    const reload = await safeJson(serviceJson(config.ravenBaseUrl, "/v1/downloads/runtime/reload", {
      method: "POST",
      body: {},
      timeoutMs: 10000
    }));
    const saved = await readRavenDownloadRuntimeSettings();
    const applied = reload?.ok === true;
    const warning = applied ? "" : normalizeString(
      reload?.payload?.error || reload?.error,
      "Raven saved the setting but could not apply it live. It will apply after Raven restarts."
    );
    await appendEventForUser({
      domain: "settings",
      eventType: "download-runtime-updated",
      user: req.user,
      targetType: "setting",
      targetId: RAVEN_DOWNLOAD_RUNTIME_KEY,
      message: `${req.user.username} updated Raven active download slots.`,
      metadata: {
        activeTitleDownloads: saved.activeTitleDownloads,
        applied
      }
    });
    res.json({
      ...saved,
      ravenDownloadRuntime: saved,
      applied,
      runtime: reload?.payload || reload || {},
      warning
    });
  }));

  app.put("/api/moon-v3/admin/settings/portal/discord", requireSettingsWrite(async (req, res) => {
    const existing = normalizePortalDiscordSettings(await readPortalDiscordSettings());
    const body = normalizeObject(req.body, {}) || {};
    const onboarding = normalizeObject(body.onboarding, {}) || {};
    const hasField = (source, key) => Object.hasOwn(source, key);
    const nextSettings = normalizePortalDiscordSettings({
      ...existing,
      guildId: hasField(body, "guildId") ? normalizeString(body.guildId) : existing.guildId,
      superuserId: hasField(body, "superuserId") ? normalizeString(body.superuserId) : existing.superuserId,
      onboarding: {
        ...existing.onboarding,
        channelId: hasField(onboarding, "channelId") ? normalizeString(onboarding.channelId) : existing.onboarding?.channelId,
        template: hasField(onboarding, "template") ? normalizeString(onboarding.template) : existing.onboarding?.template
      },
      commands: existing.commands
    });
    await vaultClient.setSetting(PORTAL_DISCORD_KEY, nextSettings);
    await appendEventForUser({
      domain: "discord",
      eventType: "discord-settings-updated",
      user: req.user,
      targetType: "setting",
      targetId: PORTAL_DISCORD_KEY,
      message: `${req.user.username} updated Discord basics from Settings.`,
      metadata: {
        guildId: nextSettings.guildId,
        onboardingChannelId: nextSettings.onboarding.channelId
      }
    });
    res.json(await readPortalDiscordSettings());
  }));

  app.put("/api/moon-v3/admin/settings/request-workflow", requireSettingsWrite(async (req, res) => {
    const existing = await readRequestWorkflowSettings();
    const nextSettings = {
      ...existing,
      autoApproveAndDownload: req.body?.autoApproveAndDownload === true
    };
    await vaultClient.setSetting(SAGE_REQUESTS_KEY, nextSettings);
    await appendEventForUser({
      domain: "settings",
      eventType: "request-workflow-updated",
      user: req.user,
      targetType: "setting",
      targetId: SAGE_REQUESTS_KEY,
      message: `${req.user.username} updated request workflow automation.`,
      metadata: {
        autoApproveAndDownload: nextSettings.autoApproveAndDownload
      }
    });
    res.json(await readRequestWorkflowSettings());
  }));

  app.get("/api/moon-v3/admin/settings/database", requireDatabaseRead(async (_req, res) => {
    res.json(await vaultClient.getDatabaseOverview());
  }));

  app.get("/api/moon-v3/admin/settings/database/tables/:tableName", requireDatabaseRead(async (req, res) => {
    const table = await vaultClient.getDatabaseTable(req.params.tableName, {
      limit: req.query.limit,
      offset: req.query.offset,
      query: req.query.q || req.query.query || ""
    });
    if (!table) {
      res.status(404).json({error: "Database table not found."});
      return;
    }
    res.json(table);
  }));

  app.put("/api/moon-v3/admin/settings/database/tables/settings/rows/:settingKey", requireDatabaseWrite(async (req, res) => {
    const setting = await vaultClient.updateDatabaseSetting(req.params.settingKey, req.body?.value);
    await appendEventForUser({
      domain: "database",
      eventType: "database-setting-updated",
      severity: "warning",
      user: req.user,
      targetType: "setting",
      targetId: normalizeString(setting?.key, req.params.settingKey),
      message: `${req.user.username} updated a database setting through the explorer.`,
      metadata: {
        settingKey: normalizeString(setting?.key, req.params.settingKey)
      }
    });
    res.json(setting);
  }));

  const buildSystemApiPayload = async (user) => {
    const [settings, groups, allKeys] = await Promise.all([
      readMoonPublicApiSettings(),
      vaultClient.listPermissionGroups(),
      vaultClient.listApiKeys({})
    ]);
    const rootAccess = hasDomainAccess(user, "publicapi", "root");
    return {
      settings,
      groups: normalizeArray(groups),
      systemKeys: normalizeArray(allKeys).filter((entry) => normalizeString(entry.kind) === "system").map(sanitizeApiKeyRecord),
      userKeys: rootAccess
        ? normalizeArray(allKeys).filter((entry) => normalizeString(entry.kind) === "user").map(sanitizeApiKeyRecord)
        : [],
      canAuditUserKeys: rootAccess,
      docsUrl: "/api/public/docs",
      openApiUrl: "/api/public/openapi.json"
    };
  };

  app.get("/api/moon-v3/admin/system/api", requirePublicApiRead(async (req, res) => {
    res.json(await buildSystemApiPayload(req.user));
  }));

  app.put("/api/moon-v3/admin/system/api/settings", requirePublicApiRoot(async (req, res) => {
    const current = await readMoonPublicApiSettings();
    const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : current.enabled;
    await vaultClient.setSetting(MOON_PUBLIC_API_KEY, {
      key: MOON_PUBLIC_API_KEY,
      enabled,
      lastRotatedAt: current.lastRotatedAt || null
    });
    await appendEvent({
      ...buildUserActor(req.user, req.authMethod === "api-key" ? "api-key" : "admin"),
      domain: "publicapi",
      eventType: "public-api-settings-updated",
      targetType: "setting",
      targetId: MOON_PUBLIC_API_KEY,
      message: `${req.user.username} updated public API settings.`,
      metadata: {enabled}
    });
    res.json(await buildSystemApiPayload(req.user));
  }));

  app.post("/api/moon-v3/admin/system/api/keys", requirePublicApiRoot(async (req, res) => {
    const secret = generateApiKeySecret("system");
    const apiKey = await vaultClient.createApiKey({
      name: normalizeString(req.body?.name, "System API key"),
      kind: "system",
      enabled: req.body?.enabled !== false,
      keyHash: hashApiKeySecret(secret),
      keyPrefix: keyPrefixForSecret(secret),
      groupIds: normalizeArray(req.body?.groupIds).map((groupId) => normalizeString(groupId)).filter(Boolean),
      createdBy: buildUserActor(req.user, req.authMethod === "api-key" ? "api-key" : "admin")
    });
    await appendEvent({
      ...buildUserActor(req.user, req.authMethod === "api-key" ? "api-key" : "admin"),
      domain: "publicapi",
      eventType: "system-api-key-created",
      targetType: "api-key",
      targetId: apiKey.id,
      message: `${req.user.username} created a system API key.`,
      metadata: {
        apiKeyId: apiKey.id,
        groupIds: sanitizeApiKeyRecord(apiKey).groupIds
      }
    });
    res.status(201).json({
      apiKey: sanitizeApiKeyRecord(apiKey),
      secret
    });
  }));

  app.patch("/api/moon-v3/admin/system/api/keys/:apiKeyId", requirePublicApiRoot(async (req, res) => {
    const existing = await vaultClient.getApiKey(req.params.apiKeyId);
    if (!existing || normalizeString(existing.kind) !== "system") {
      res.status(404).json({error: "System API key not found."});
      return;
    }
    const apiKey = await vaultClient.updateApiKey(req.params.apiKeyId, {
      name: req.body?.name,
      enabled: req.body?.enabled,
      groupIds: req.body?.groupIds
    });
    await appendEvent({
      ...buildUserActor(req.user, req.authMethod === "api-key" ? "api-key" : "admin"),
      domain: "publicapi",
      eventType: "system-api-key-updated",
      targetType: "api-key",
      targetId: apiKey.id,
      message: `${req.user.username} updated a system API key.`,
      metadata: {
        apiKeyId: apiKey.id,
        enabled: apiKey.enabled,
        groupIds: sanitizeApiKeyRecord(apiKey).groupIds
      }
    });
    res.json({apiKey: sanitizeApiKeyRecord(apiKey)});
  }));

  app.delete("/api/moon-v3/admin/system/api/keys/:apiKeyId", requirePublicApiRoot(async (req, res) => {
    const apiKey = await vaultClient.revokeApiKey(req.params.apiKeyId);
    if (!apiKey) {
      res.status(404).json({error: "API key not found."});
      return;
    }
    await appendEvent({
      ...buildUserActor(req.user, req.authMethod === "api-key" ? "api-key" : "admin"),
      domain: "publicapi",
      eventType: `${normalizeString(apiKey.kind, "api")}-api-key-revoked`,
      targetType: "api-key",
      targetId: apiKey.id,
      message: `${req.user.username} revoked an API key.`,
      metadata: {
        apiKeyId: apiKey.id,
        kind: normalizeString(apiKey.kind)
      }
    });
    res.json({apiKey: sanitizeApiKeyRecord(apiKey)});
  }));

  app.get("/api/moon-v3/admin/events", withUser(requireUser, async (req, res) => {
    const filters = buildEventFiltersFromQuery(req.query);
    if (!ensureEventReadAccess(req.user, filters.domains)) {
      res.status(403).json({error: "Missing admin grant for the requested event domains."});
      return;
    }
    res.json({
      events: normalizeArray(await vaultClient.listEvents(filters)),
      filters
    });
  }));

  app.get("/api/moon-v3/admin/events/stream", withUser(requireUser, async (req, res) => {
    const domains = normalizeRequestedEventDomains(req.query.domain);
    if (!ensureEventReadAccess(req.user, domains)) {
      res.status(403).json({error: "Missing admin grant for the requested event domains."});
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let cursor = Number.parseInt(String(req.query.afterSequence || req.query.after || req.get("Last-Event-ID") || 0), 10) || 0;

    const writeEvents = async () => {
      const events = normalizeArray(await vaultClient.listEvents({
        domains,
        afterSequence: cursor,
        limit: 100,
        newestFirst: false
      }));
      for (const event of events) {
        cursor = Math.max(cursor, Number.parseInt(String(event.sequence || 0), 10) || cursor);
        res.write(`id: ${cursor}\n`);
        res.write("event: admin-event\n");
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    const heartbeat = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 15000);
    const poller = setInterval(() => {
      void writeEvents();
    }, 3000);

    await writeEvents();

    req.on("close", () => {
      clearInterval(heartbeat);
      clearInterval(poller);
      res.end();
    });
  }));

  const buildAdminSystemStatus = async ({includeChecks = false} = {}) => {
    const [matrix, services] = await Promise.all([
      buildSystemStatusPayload({config, serviceJson, includeChecks}),
      loadServiceStatus()
    ]);

    return {
      ...matrix,
      services,
      bootstrap: null,
      runtime: null
    };
  };

  const buildAdminSystemStatusRuntime = async () => {
    const [bootstrap, runtime] = await Promise.all([
      safeJson(serviceJson(config.wardenBaseUrl, "/api/bootstrap", {timeoutMs: 2200})),
      safeJson(serviceJson(config.wardenBaseUrl, "/api/runtime", {timeoutMs: 2200}))
    ]);
    return {
      bootstrap: bootstrap.payload || bootstrap,
      runtime: runtime.payload || runtime
    };
  };

  app.get("/api/moon-v3/admin/system/status", requireSystemRead(async (_req, res) => {
    res.json(await buildAdminSystemStatus({includeChecks: false}));
  }));

  app.get("/api/moon-v3/admin/system/status/runtime", requireSystemRead(async (_req, res) => {
    res.json(await buildAdminSystemStatusRuntime());
  }));

  app.post("/api/moon-v3/admin/system/status/check", requireSystemRead(async (_req, res) => {
    res.json(await buildAdminSystemStatus({includeChecks: true}));
  }));

  app.get("/api/moon-v3/admin/system/content-reset/preview", requireSystemRoot(async (_req, res) => {
    res.json(await previewContentReset());
  }));

  app.post("/api/moon-v3/admin/system/content-reset", requireSystemRoot(async (req, res) => {
    const confirmation = normalizeString(req.body?.confirmation);
    if (confirmation !== "RESET SCRIPTARR CONTENT") {
      res.status(400).json({error: "Confirmation text did not match. Use RESET SCRIPTARR CONTENT."});
      return;
    }

    await appendEvent({
      ...buildUserActor(req.user, "admin"),
      domain: "system",
      eventType: "content-reset-started",
      severity: "warning",
      targetType: "system",
      targetId: "content-reset",
      message: `${req.user.username} started a content reset.`,
      metadata: {
        confirmation
      }
    });

    const vaultResult = await vaultClient.executeContentReset();
    const ravenReset = await serviceJson(config.ravenBaseUrl, "/v1/system/content-reset", {
      method: "POST",
      body: {}
    });
    if (!ravenReset.ok) {
      res.status(ravenReset.status || 502).json({
        error: ravenReset.payload?.error || "Moon reset Vault content state but Raven managed storage cleanup failed.",
        vault: vaultResult
      });
      return;
    }

    await appendEvent({
      ...buildUserActor(req.user, "admin"),
      domain: "system",
      eventType: "content-reset-completed",
      severity: "warning",
      targetType: "system",
      targetId: "content-reset",
      message: `${req.user.username} completed a content reset.`,
      metadata: {
        vault: vaultResult,
        raven: ravenReset.payload
      }
    });

    res.json({
      confirmationText: "RESET SCRIPTARR CONTENT",
      vault: vaultResult,
      raven: ravenReset.payload
    });
  }));

  app.get("/api/moon-v3/admin/system/tasks", requireSystemRead(async (_req, res) => {
    const [scheduler, requests] = await Promise.all([
      systemTaskRuntime.getTaskPayload(),
      loadRequests()
    ]);
    res.json({
      ...scheduler,
      pendingRequests: requests.filter((entry) => entry.status === "pending")
    });
  }));

  app.patch("/api/moon-v3/admin/system/tasks/:taskId", requireSystemRoot(async (req, res) => {
    res.json(await systemTaskRuntime.persistTaskSchedule(req.params.taskId, req.body || {}));
  }));

  app.post("/api/moon-v3/admin/system/tasks/:taskId/preview", requireSystemRoot(async (req, res) => {
    res.json(await systemTaskRuntime.previewTaskSchedule(req.params.taskId, req.body || {}));
  }));

  app.post("/api/moon-v3/admin/system/tasks/:taskId/run", requireSystemRoot(async (req, res) => {
    const job = await systemTaskRuntime.runTask(req.params.taskId, {
      manual: true,
      actor: buildUserActor(req.user, "admin")
    });
    res.json(job);
  }));

  const runLocalAiLifecycle = async (user, action, body = {}) => {
    const oracleSettings = action === "remove"
      ? await readOracleSettings()
      : await readLocalAiActionSettings(body);
    const result = await safeJson(serviceJson(config.oracleBaseUrl, `/api/localai/actions/${encodeURIComponent(action)}`, {
      method: "POST",
      body: {
        model: normalizeString(body?.model || body?.modelUrl || oracleSettings.model),
        requestedBy: {
          discordUserId: normalizeString(user?.discordUserId),
          username: normalizeString(user?.username, "Admin")
        }
      },
      timeoutMs: 10000
    }));
    await appendEvent({
      ...buildUserActor(user, "admin"),
      domain: "ai",
      eventType: `localai-${action}-requested`,
      severity: "info",
      targetType: "service",
      targetId: "scriptarr-oracle",
      message: `${normalizeString(user?.username, "An admin")} requested embedded LocalAI ${action} from Moon admin AI.`,
      metadata: {
        result: result.payload || result
      }
    });
    return result;
  };

  /**
   * Build the fast saved-state payload for the Moon AI admin page.
   *
   * @returns {Promise<Record<string, unknown>>}
   */
  const buildAdminAiPayload = async () => {
    const [oracle, tools, proposals] = await Promise.all([
      readOracleSettings(),
      buildToolPayload(vaultClient),
      readAiProposals(vaultClient)
    ]);
    return {
      oracle,
      tools,
      proposals: normalizeArray(proposals?.proposals).slice(-10).reverse()
    };
  };

  /**
   * Build optional Oracle and LocalAI runtime details for secondary hydration.
   *
   * @returns {Promise<Record<string, unknown>>}
   */
  const buildAdminAiRuntimePayload = async () => {
    const [oracleHealth, oracleStatus, localAiStatus, localAiProfile] = await Promise.all([
      safeJson(serviceJson(config.oracleBaseUrl, "/health", {timeoutMs: 2200})),
      safeJson(serviceJson(config.oracleBaseUrl, "/api/status", {timeoutMs: 2200})),
      safeJson(serviceJson(config.oracleBaseUrl, "/api/localai/status", {timeoutMs: 3000})),
      safeJson(serviceJson(config.oracleBaseUrl, "/api/localai/profile", {timeoutMs: 2200}))
    ]);
    return {
      oracleHealth: oracleHealth.payload || oracleHealth,
      oracleStatus: oracleStatus.payload || oracleStatus,
      localAi: localAiStatus.payload || localAiStatus,
      localAiProfile: localAiProfile.payload || localAiProfile
    };
  };

  const executeAiProposal = async (proposal, user) => {
    const tool = toolForId(proposal?.toolId);
    if (!tool) {
      return {ok: false, status: 404, payload: {error: "The proposal tool is no longer registered."}};
    }
    if (tool.grant && !hasDomainAccess(user, tool.grant.domain, tool.grant.level)) {
      return {ok: false, status: 403, payload: {error: "You do not have access to confirm this AI proposal."}};
    }
    const args = proposal?.args && typeof proposal.args === "object" ? proposal.args : {};
    if (tool.id === "status_check") {
      const payload = await buildAdminSystemStatus();
      await markToolUsed(vaultClient, tool.id);
      return {ok: true, status: 200, payload};
    }
    if (tool.id === "trivia_start") {
      const result = await safeJson(serviceJson(config.portalBaseUrl, "/api/trivia/start", {
        method: "POST",
        headers: portalInternalHeaders(),
        body: {
          requestedBy: {
            discordUserId: normalizeString(user?.discordUserId),
            username: normalizeString(user?.username, "Admin")
          },
          force: args.force !== false
        },
        timeoutMs: 12000
      }));
      await markToolUsed(vaultClient, tool.id);
      return result;
    }
    if (tool.id === "trivia_stop") {
      const result = await safeJson(serviceJson(config.portalBaseUrl, "/api/trivia/stop", {
        method: "POST",
        headers: portalInternalHeaders(),
        body: {
          requestedBy: {
            discordUserId: normalizeString(user?.discordUserId),
            username: normalizeString(user?.username, "Admin")
          }
        },
        timeoutMs: 12000
      }));
      await markToolUsed(vaultClient, tool.id);
      return result;
    }
    if (["localai_install", "localai_start", "localai_remove"].includes(tool.id)) {
      const action = tool.id.replace("localai_", "");
      const result = await runLocalAiLifecycle(user, action, args);
      await markToolUsed(vaultClient, tool.id);
      return result;
    }
    if (tool.id === "system_task_run") {
      const taskId = normalizeString(args.taskId || args.task);
      if (!taskId) {
        return {ok: false, status: 400, payload: {error: "A taskId argument is required."}};
      }
      const job = await systemTaskRuntime.runTask(taskId, {
        manual: true,
        actor: buildUserActor(user, "admin")
      });
      await markToolUsed(vaultClient, tool.id);
      return {ok: true, status: 200, payload: job};
    }
    return {
      ok: false,
      status: 409,
      payload: {error: `${tool.label} is registered but does not have a confirmed executor yet.`}
    };
  };

  const executeAiReadTool = async (tool, body = {}) => {
    const args = normalizeObject(body.args, {}) || {};
    if (tool.id === "stack_status" || tool.id === "service_health") {
      await markToolUsed(vaultClient, tool.id);
      return {message: "Stack status loaded.", data: await loadServiceStatus()};
    }
    if (tool.id === "events") {
      await markToolUsed(vaultClient, tool.id);
      return {
        message: "Recent events loaded.",
        data: {
          events: await vaultClient.listEvents({
            newestFirst: true,
            limit: Math.min(25, Math.max(1, Number.parseInt(String(args.limit || 10), 10) || 10))
          })
        }
      };
    }
    if (tool.id === "queue") {
      await markToolUsed(vaultClient, tool.id);
      const [tasks, runtimeSettings] = await Promise.all([
        loadTasks(),
        readRavenDownloadRuntimeSettings()
      ]);
      return {message: "Queue loaded.", data: buildAdminQueuePayload(tasks, {concurrency: runtimeSettings.activeTitleDownloads})};
    }
    if (tool.id === "requests") {
      await markToolUsed(vaultClient, tool.id);
      const requests = await loadRequests();
      return {message: "Requests loaded.", data: {summary: buildRequestSummaryCounts(requests), requests: requests.slice(0, 25)}};
    }
    if (tool.id === "library_search") {
      await markToolUsed(vaultClient, tool.id);
      const query = normalizeString(args.query || body.query);
      const library = await loadLibrary();
      return {
        message: "Library search loaded.",
        data: {
          query,
          results: library.filter((title) => !query || normalizeString(title.title).toLowerCase().includes(query.toLowerCase())).slice(0, 25)
        }
      };
    }
    if (tool.id === "missing_content") {
      await markToolUsed(vaultClient, tool.id);
      return {message: "Missing content loaded.", data: buildMissingChapterPayload(await loadLibrary())};
    }
    if (tool.id === "discord_runtime") {
      await markToolUsed(vaultClient, tool.id);
      return {message: "Discord runtime loaded.", data: await buildDiscordPayload()};
    }
    if (tool.id === "trivia_status") {
      await markToolUsed(vaultClient, tool.id);
      return {message: "Trivia status loaded.", data: await triviaService.getState()};
    }
    if (tool.id === "localai_status") {
      await markToolUsed(vaultClient, tool.id);
      const result = await serviceJson(config.oracleBaseUrl, "/api/localai/status", {timeoutMs: 3000});
      return {message: "LocalAI status loaded.", data: result.payload || result};
    }
    return {message: `${tool.label} is available, but no direct read executor is wired yet.`, data: null};
  };

  app.get("/api/moon-v3/admin/system/ai/tools", requireAiRead(async (_req, res) => {
    res.json(await buildToolPayload(vaultClient));
  }));

  app.put("/api/moon-v3/admin/system/ai/tools", requireAiRoot(async (req, res) => {
    const settings = await writeAiToolSettings(vaultClient, req.body || {});
    await appendEventForUser({
      domain: "ai",
      eventType: "ai-tool-settings-updated",
      user: req.user,
      targetType: "setting",
      targetId: "oracle.tools",
      message: `${req.user.username} updated AI tool toggles.`
    });
    res.json(await buildToolPayload(vaultClient, settings));
  }));

  app.post("/api/moon-v3/admin/system/ai/assist", requireAiRead(async (req, res) => {
    const planned = await proposeAiAction({
      vaultClient,
      prompt: req.body?.prompt || req.body?.message,
      requestedToolId: req.body?.toolId,
      args: req.body?.args,
      user: req.user
    });
    if (planned.ok === false) {
      res.status(planned.status || 400).json(planned);
      return;
    }
    if (planned.proposal) {
      await appendEventForUser({
        domain: "ai",
        eventType: "ai-proposal-created",
        user: req.user,
        targetType: "ai-proposal",
        targetId: planned.proposal.id,
        message: `${req.user.username} asked AI to propose ${planned.tool.label}.`,
        metadata: {
          toolId: planned.tool.id,
          risk: planned.tool.risk
        }
      });
      res.json(planned);
      return;
    }
    const readResult = await executeAiReadTool(planned.tool, req.body || {});
    res.json({
      ...planned,
      ...readResult,
      tools: await buildToolPayload(vaultClient)
    });
  }));

  app.post("/api/moon-v3/admin/system/ai/proposals/:id/cancel", requireAiWrite(async (req, res) => {
    const proposal = await updateProposalStatus(vaultClient, req.params.id, "cancelled", {
      actedBy: buildUserActor(req.user, "admin"),
      result: {cancelled: true}
    });
    res.status(proposal ? 200 : 404).json(proposal || {error: "AI proposal was not found."});
  }));

  app.post("/api/moon-v3/admin/system/ai/proposals/:id/confirm", requireAiWrite(async (req, res) => {
    const proposal = await getProposal(vaultClient, req.params.id);
    if (!proposal) {
      res.status(404).json({error: "AI proposal was not found."});
      return;
    }
    if (proposal.status !== "pending") {
      res.status(409).json({error: `This AI proposal is already ${proposal.status}.`, proposal});
      return;
    }
    if (proposal.expiresAt && Date.parse(proposal.expiresAt) < Date.now()) {
      const expired = await updateProposalStatus(vaultClient, proposal.id, "expired", {
        actedBy: buildUserActor(req.user, "admin")
      });
      res.status(409).json({error: "This AI proposal expired.", proposal: expired});
      return;
    }
    const executed = await executeAiProposal(proposal, req.user);
    const nextStatus = executed.ok === false ? "failed" : "confirmed";
    const updated = await updateProposalStatus(vaultClient, proposal.id, nextStatus, {
      actedBy: buildUserActor(req.user, "admin"),
      result: executed.payload || executed
    });
    await appendEventForUser({
      domain: "ai",
      eventType: nextStatus === "confirmed" ? "ai-proposal-confirmed" : "ai-proposal-failed",
      severity: nextStatus === "confirmed" ? "info" : "warning",
      user: req.user,
      targetType: "ai-proposal",
      targetId: proposal.id,
      message: `${req.user.username} confirmed AI proposal ${proposal.id}.`,
      metadata: {
        toolId: proposal.toolId,
        result: executed.payload || executed
      }
    });
    res.status(executed.status || (executed.ok === false ? 502 : 200)).json({
      proposal: updated,
      result: executed.payload || executed
    });
  }));

  app.get("/api/moon-v3/admin/system/ai", requireAiRead(async (_req, res) => {
    res.json(await buildAdminAiPayload());
  }));

  app.get("/api/moon-v3/admin/system/ai/runtime", requireAiRead(async (_req, res) => {
    res.json(await buildAdminAiRuntimePayload());
  }));

  app.put("/api/moon-v3/admin/system/ai/oracle", requireAiWrite(async (req, res) => {
    res.json(await persistOracleSettings(req.user, req.body || {}));
  }));

  app.get("/api/moon-v3/admin/system/ai/models", requireAiRead(async (req, res) => {
    const requestedProvider = normalizeString(req.query.provider, "openai").toLowerCase();
    const provider = ["openai", "localai"].includes(requestedProvider) ? requestedProvider : "openai";
    const result = await safeJson(serviceJson(config.oracleBaseUrl, `/api/models?provider=${encodeURIComponent(provider)}`, {
      timeoutMs: 6500
    }));
    res.status(result.status || (result.ok === false ? 502 : 200)).json(result.payload || result);
  }));

  const readLocalAiActionSettings = async (body = {}) => {
    const persisted = await readOracleSettings();
    if (!body || !Object.keys(body).length) {
      return persisted;
    }
    const imageMode = normalizeString(body.localAiImageMode, persisted.localAiImageMode);
    return {
      ...persisted,
      localAiProfileKey: normalizeString(body.localAiProfileKey, persisted.localAiProfileKey),
      localAiImageMode: ["preset", "custom"].includes(imageMode) ? imageMode : persisted.localAiImageMode,
      localAiCustomImage: normalizeString(body.localAiCustomImage)
    };
  };

  app.post("/api/moon-v3/admin/system/ai/localai/install", requireAiRoot(async (req, res) => {
    const result = await runLocalAiLifecycle(req.user, "install", req.body || {});
    res.status(result.status || (result.ok === false ? 502 : 200)).json(result.payload || result);
  }));

  app.post("/api/moon-v3/admin/system/ai/localai/start", requireAiRoot(async (req, res) => {
    const result = await runLocalAiLifecycle(req.user, "start", req.body || {});
    res.status(result.status || (result.ok === false ? 502 : 200)).json(result.payload || result);
  }));

  app.post("/api/moon-v3/admin/system/ai/localai/remove", requireAiRoot(async (req, res) => {
    const result = await runLocalAiLifecycle(req.user, "remove", req.body || {});
    res.status(result.status || (result.ok === false ? 502 : 200)).json(result.payload || result);
  }));

  app.post("/api/moon-v3/admin/system/ai/test", requireAiRead(async (req, res) => {
    const message = normalizeString(req.body?.message, "Say hello from Scriptarr.");
    const result = await safeJson(serviceJson(config.oracleBaseUrl, "/api/chat", {
      method: "POST",
      body: {message},
      timeoutMs: ORACLE_ADMIN_TEST_TIMEOUT_MS
    }));
    res.status(result.status || (result.ok === false ? 502 : 200)).json(result.payload || result);
  }));

  app.get("/api/moon-v3/admin/system/updates", requireSystemRead(async (_req, res) => {
    const updates = await serviceJson(config.wardenBaseUrl, "/api/updates");
    res.status(updates.status).json(updates.payload);
  }));

  app.post("/api/moon-v3/admin/system/updates/check", requireSystemRoot(async (req, res) => {
    const updates = await serviceJson(config.wardenBaseUrl, "/api/updates/check", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    });
    res.status(updates.status).json(updates.payload);
  }));

  app.post("/api/moon-v3/admin/system/updates/install", requireSystemRoot(async (req, res) => {
    const updates = await serviceJson(config.wardenBaseUrl, "/api/updates/install", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    });
    res.status(updates.status).json(updates.payload);
  }));

  app.get("/api/moon-v3/admin/system/events", requireSystemRead(async (req, res) => {
    const filters = buildEventFiltersFromQuery(req.query);
    res.json({
      events: normalizeArray(await vaultClient.listEvents({
        ...filters,
        limit: filters.limit || 120
      })),
      filters
    });
  }));

  app.get("/api/moon-v3/admin/system/logs", requireSystemRead(async (req, res) => {
    const params = new URLSearchParams();
    appendOptionalSearchParam(params, "service", req.query.service);
    appendOptionalSearchParam(params, "lines", req.query.lines);
    appendOptionalSearchParam(params, "level", req.query.level);
    appendOptionalSearchParam(params, "q", req.query.q || req.query.query);
    const logs = await serviceJson(config.wardenBaseUrl, `/api/logs${params.size ? `?${params.toString()}` : ""}`);
    res.status(logs.status).json(logs.payload);
  }));

  app.get("/api/moon-v3/user/home", withUser(requireUser, async (req, res) => {
      const [cardPage, requests, userInputs] = await Promise.all([
        loadLibraryCardPageForUser({pageSize: 100, sort: "recent"}, req.user.discordUserId),
        loadRequests(),
        loadUserStateInputs(req.user.discordUserId)
      ]);
      const activityIds = collectUserActivityTitleIds(userInputs);
      const activityTitles = await loadLibraryCardPageByIds(activityIds, req.user.discordUserId);
      const recentLibrary = buildUserLibraryStateFromInputs(cardPage.titles, userInputs);
      const activityLibrary = buildUserLibraryStateFromInputs(activityTitles, userInputs);

    res.json(buildMoonHomePayload({
      titles: recentLibrary.titles.length ? recentLibrary.titles : cardPage.titles,
      requests,
      bookshelf: activityLibrary.bookshelf,
      following: activityLibrary.following,
      discordUserId: req.user.discordUserId,
      tagPreferences: recentLibrary.tagPreferences
      }));
    }));

    app.get("/api/moon-v3/user/profile", withUser(requireUser, async (req, res) => {
      const [requests, userInputs] = await Promise.all([
        loadRequests(),
        loadUserStateInputs(req.user.discordUserId)
      ]);
      const profileTitleIds = collectUserActivityTitleIds(userInputs);
      const profileTitles = await loadLibraryCardPageByIds(profileTitleIds);
      const userLibrary = buildUserLibraryStateFromInputs(profileTitles, userInputs);
      const userRequests = requests.filter((entry) => entry.requestedBy.discordUserId === req.user.discordUserId);

      res.json({
        user: {
          discordUserId: normalizeString(req.user.discordUserId),
          username: normalizeString(req.user.username, "Reader"),
          avatarUrl: normalizeString(req.user.avatarUrl),
          role: normalizeString(req.user.role, "member")
        },
        ...buildMoonProfilePayload({
          userLibrary,
          requests: userRequests
        }),
        adminCapable: hasDomainAccess(req.user, "overview", "read"),
        tagPreferences: userLibrary.tagPreferences
      });
    }));

  app.get("/api/moon-v3/user/api-keys", withUser(requireUser, async (req, res) => {
    if (!requireBrowserSession(req, res)) {
      return;
    }
    const keys = await vaultClient.listApiKeys({
      kind: "user",
      ownerDiscordUserId: req.user.discordUserId
    });
    res.json({
      apiKeys: normalizeArray(keys).map(sanitizeApiKeyRecord),
      canManageApiKeys: hasPermission(req.user, "manage_personal_api_keys")
    });
  }));

  app.post("/api/moon-v3/user/api-keys", withUser(requireUser, async (req, res) => {
    if (!requireBrowserSession(req, res)) {
      return;
    }
    if (!hasPermission(req.user, "manage_personal_api_keys")) {
      res.status(403).json({error: "Missing permission: manage_personal_api_keys"});
      return;
    }
    const secret = generateApiKeySecret("user");
    const apiKey = await vaultClient.createApiKey({
      name: normalizeString(req.body?.name, "Reader API key"),
      kind: "user",
      enabled: req.body?.enabled !== false,
      keyHash: hashApiKeySecret(secret),
      keyPrefix: keyPrefixForSecret(secret),
      ownerDiscordUserId: req.user.discordUserId,
      createdBy: buildUserActor(req.user, "user")
    });
    await appendEventForUser({
      domain: "publicapi",
      eventType: "user-api-key-created",
      user: req.user,
      targetType: "api-key",
      targetId: apiKey.id,
      message: `${req.user.username} created a user API key.`,
      metadata: {
        apiKeyId: apiKey.id
      }
    });
    res.status(201).json({
      apiKey: sanitizeApiKeyRecord(apiKey),
      secret
    });
  }));

  app.patch("/api/moon-v3/user/api-keys/:apiKeyId", withUser(requireUser, async (req, res) => {
    if (!requireBrowserSession(req, res)) {
      return;
    }
    const existing = await vaultClient.getApiKey(req.params.apiKeyId);
    if (!existing || normalizeString(existing.kind) !== "user" || normalizeString(existing.ownerDiscordUserId) !== req.user.discordUserId) {
      res.status(404).json({error: "User API key not found."});
      return;
    }
    const apiKey = await vaultClient.updateApiKey(existing.id, {
      name: req.body?.name,
      enabled: req.body?.enabled
    });
    await appendEventForUser({
      domain: "publicapi",
      eventType: "user-api-key-updated",
      user: req.user,
      targetType: "api-key",
      targetId: existing.id,
      message: `${req.user.username} updated a user API key.`,
      metadata: {
        apiKeyId: existing.id,
        enabled: apiKey?.enabled
      }
    });
    res.json({apiKey: sanitizeApiKeyRecord(apiKey)});
  }));

  app.delete("/api/moon-v3/user/api-keys/:apiKeyId", withUser(requireUser, async (req, res) => {
    if (!requireBrowserSession(req, res)) {
      return;
    }
    const existing = await vaultClient.getApiKey(req.params.apiKeyId);
    if (!existing || normalizeString(existing.kind) !== "user" || normalizeString(existing.ownerDiscordUserId) !== req.user.discordUserId) {
      res.status(404).json({error: "User API key not found."});
      return;
    }
    const apiKey = await vaultClient.revokeApiKey(existing.id);
    await appendEventForUser({
      domain: "publicapi",
      eventType: "user-api-key-revoked",
      user: req.user,
      targetType: "api-key",
      targetId: existing.id,
      message: `${req.user.username} revoked a user API key.`,
      metadata: {
        apiKeyId: existing.id
      }
    });
    res.json({apiKey: sanitizeApiKeyRecord(apiKey)});
  }));

  app.get("/api/moon-v3/user/library", withUser(requireUser, async (req, res) => {
    if (normalizeString(req.query.view) === "card") {
      res.json(await loadLibraryCardPageForUser(req.query, req.user.discordUserId));
      return;
    }
    res.json({titles: await loadLibrary()});
  }));

  app.get("/api/moon-v3/user/library/cover/:titleId/source", withUser(requireUser, async (req, res) => {
    const title = await loadLibraryTitle(req.params.titleId);
    const card = title ? toTitleCardSummary(title) : null;
    if (!card?.id || !card.coverUrl) {
      res.status(404).json({error: "Cover source not found."});
      return;
    }
    res.json({
      titleId: card.id,
      coverUrl: card.coverUrl,
      coverRevision: card.coverRevision,
      updatedAt: card.updatedAt
    });
  }));

  app.get("/api/moon-v3/user/title/:titleId/summary", withUser(requireUser, async (req, res) => {
    const summary = await loadUserTitleSummaryState(req.user.discordUserId, req.params.titleId);
    if (!summary?.title) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    res.json(summary);
  }));

  app.get("/api/moon-v3/user/title/:titleId/chapters", withUser(requireUser, async (req, res) => {
    const page = await vaultClient.listRavenTitleChapters(req.params.titleId, {
      ...req.query,
      discordUserId: req.user.discordUserId
    });
    if (!page) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    res.json({
      ...page,
      chapters: normalizeArray(page.chapters).map(toUserChapterRow)
    });
  }));

  app.get("/api/moon-v3/user/title/:titleId/requests", withUser(requireUser, async (req, res) => {
    const summary = await loadUserTitleSummaryState(req.user.discordUserId, req.params.titleId);
    if (!summary?.title) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    res.json(await loadUserTitleRequests(req.user.discordUserId, summary.title));
  }));

  app.get("/api/moon-v3/user/title/:titleId", withUser(requireUser, async (req, res) => {
    const [rawTitle, userInputs, requests] = await Promise.all([
      loadLibraryTitle(req.params.titleId),
      loadUserStateInputs(req.user.discordUserId),
      loadRequests()
    ]);
    const titleState = buildUserTitleStateFromInputs(rawTitle, userInputs);
    const title = titleState?.title || null;
    if (!title) {
      res.status(404).json({error: "Title not found."});
      return;
    }

    res.json({
      title,
      following: Boolean(title.userState?.following),
      tagPreferences: titleState?.userLibrary?.tagPreferences || normalizeTagPreferenceStore({}),
      requests: requests.filter((entry) =>
        entry.requestedBy.discordUserId === req.user.discordUserId && (
          entry.title === title.title
          || normalizeString(entry.details?.selectedDownload?.titleUrl) === normalizeString(title.sourceUrl)
          || normalizeString(entry.details?.selectedMetadata?.title) === title.title
        )
      )
    });
  }));

  app.get("/api/moon-v3/user/tag-preferences", withUser(requireUser, async (req, res) => {
    res.json(await readUserTagPreferences(req.user.discordUserId));
  }));

  app.put("/api/moon-v3/user/tag-preferences", withUser(requireUser, async (req, res) => {
    const current = await readUserTagPreferences(req.user.discordUserId);
    const tag = normalizeString(req.body?.tag);
    const preference = normalizeString(req.body?.preference).toLowerCase();
    if (!tag) {
      res.status(400).json({error: "tag is required."});
      return;
    }
    if (!["like", "dislike", "clear", ""].includes(preference)) {
      res.status(400).json({error: "preference must be like, dislike, or clear."});
      return;
    }
    const next = setTagPreference(current, tag, preference || "clear");
    await writeUserScopedSetting(vaultClient, "moon.tag-preferences", req.user.discordUserId, next);
    await appendEventForUser({
      domain: "library",
      eventType: "tag-preference-updated",
      user: req.user,
      targetType: "tag",
      targetId: normalizeString(tag).toLowerCase(),
      message: `${req.user.username} updated a title-tag preference.`,
      metadata: {
        tag: normalizeString(tag),
        preference: preference || "clear"
      }
    });
    res.json(next);
  }));

  app.get("/api/moon-v3/user/title/:titleId/read-state", withUser(requireUser, async (req, res) => {
    const titleState = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    if (!titleState?.title) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    res.json({
      titleId: titleState.title.id,
      userState: titleState.title.userState,
      chapters: normalizeArray(titleState.title.chapters).map((chapter) => ({
        id: chapter.id,
        label: chapter.label,
        read: chapter.read === true,
        readAt: chapter.readAt || null
      }))
    });
  }));

  app.post("/api/moon-v3/user/title/:titleId/read", withUser(requireUser, async (req, res) => {
    const titleState = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    if (!titleState?.title) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    const availableChapterIds = normalizeArray(titleState.title.chapters)
      .filter((chapter) => chapter.available !== false)
      .map((chapter) => normalizeString(chapter.id))
      .filter(Boolean);
    await vaultClient.markTitleRead({
      discordUserId: req.user.discordUserId,
      mediaId: titleState.title.id,
      chapterIds: availableChapterIds,
      startedAt: titleState.title.userState?.startedAt || new Date().toISOString(),
      completedAt: new Date().toISOString()
    });
    await appendEventForUser({
      domain: "reader",
      eventType: "title-marked-read",
      user: req.user,
      targetType: "title",
      targetId: normalizeString(titleState.title.id),
      message: `${req.user.username} marked ${titleState.title.title} as read.`,
      metadata: {
        titleId: normalizeString(titleState.title.id),
        chapterCount: availableChapterIds.length
      }
    });
    await sendTitleMutationResponse(req, res, titleState.title);
  }));

  app.post("/api/moon-v3/user/title/:titleId/unread", withUser(requireUser, async (req, res) => {
    const titleState = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    if (!titleState?.title) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    await vaultClient.markTitleUnread({
      discordUserId: req.user.discordUserId,
      mediaId: titleState.title.id
    });
    const bookmarks = normalizeArray(await readUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, []));
    const nextBookmarks = bookmarks.filter((entry) => normalizeString(entry.titleId) !== normalizeString(titleState.title.id));
    if (nextBookmarks.length !== bookmarks.length) {
      await writeUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, nextBookmarks);
    }
    await appendEventForUser({
      domain: "reader",
      eventType: "title-reset-off-shelf",
      user: req.user,
      targetType: "title",
      targetId: normalizeString(titleState.title.id),
      message: `${req.user.username} reset ${titleState.title.title} off their bookshelf.`,
      metadata: {
        titleId: normalizeString(titleState.title.id),
        clearedBookmarkCount: bookmarks.length - nextBookmarks.length
      }
    });
    await sendTitleMutationResponse(req, res, titleState.title);
  }));

  app.post("/api/moon-v3/user/title/:titleId/chapters/:chapterId/read", withUser(requireUser, async (req, res) => {
    const titleState = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    const title = titleState?.title || null;
    const chapter = normalizeArray(title?.chapters).find((entry) => entry.id === req.params.chapterId) || null;
    if (!title || !chapter) {
      res.status(404).json({error: "Chapter not found."});
      return;
    }
    const readIds = new Set(normalizeArray(title.userState?.readChapterIds).map((entry) => normalizeString(entry)));
    readIds.add(normalizeString(chapter.id));
    const availableCount = normalizeArray(title.chapters).filter((entry) => entry.available !== false).length;
    const completedAt = readIds.size >= availableCount && availableCount > 0 ? new Date().toISOString() : null;
    await vaultClient.markChapterRead({
      discordUserId: req.user.discordUserId,
      mediaId: title.id,
      chapterId: chapter.id,
      startedAt: title.userState?.startedAt || new Date().toISOString(),
      completedAt
    });
    await appendEventForUser({
      domain: "reader",
      eventType: "chapter-marked-read",
      user: req.user,
      targetType: "chapter",
      targetId: normalizeString(chapter.id),
      message: `${req.user.username} marked ${chapter.label} as read.`,
      metadata: {
        titleId: normalizeString(title.id),
        chapterId: normalizeString(chapter.id)
      }
    });
    await sendTitleMutationResponse(req, res, title, {
      chapterId: normalizeString(chapter.id)
    });
  }));

  app.post("/api/moon-v3/user/title/:titleId/chapters/:chapterId/unread", withUser(requireUser, async (req, res) => {
    const titleState = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    const title = titleState?.title || null;
    const chapter = normalizeArray(title?.chapters).find((entry) => entry.id === req.params.chapterId) || null;
    if (!title || !chapter) {
      res.status(404).json({error: "Chapter not found."});
      return;
    }
    await vaultClient.markChapterUnread({
      discordUserId: req.user.discordUserId,
      mediaId: title.id,
      chapterId: chapter.id,
      startedAt: title.userState?.startedAt || new Date().toISOString()
    });
    await appendEventForUser({
      domain: "reader",
      eventType: "chapter-marked-unread",
      user: req.user,
      targetType: "chapter",
      targetId: normalizeString(chapter.id),
      message: `${req.user.username} marked ${chapter.label} as unread.`,
      metadata: {
        titleId: normalizeString(title.id),
        chapterId: normalizeString(chapter.id)
      }
    });
    await sendTitleMutationResponse(req, res, title, {
      chapterId: normalizeString(chapter.id)
    });
  }));

  app.post("/api/moon-v3/user/title/:titleId/chapters/bulk-read-state", withUser(requireUser, async (req, res) => {
    const titleState = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    const title = titleState?.title || null;
    if (!title) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    const action = normalizeString(req.body?.action).toLowerCase();
    if (!["read", "unread", "reset"].includes(action)) {
      res.status(400).json({error: "action must be read, unread, or reset."});
      return;
    }
    const requestedIds = Array.from(new Set(normalizeArray(req.body?.chapterIds)
      .map((chapterId) => normalizeString(chapterId))
      .filter(Boolean)));
    const chapters = normalizeArray(title.chapters);
    const chapterById = new Map(chapters.map((chapter) => [normalizeString(chapter.id), chapter]));
    const selectedIds = requestedIds.filter((chapterId) => chapterById.has(chapterId));
    if (!selectedIds.length) {
      res.status(400).json({error: "chapterIds must include at least one chapter on this title."});
      return;
    }

    const availableCount = chapters.filter((entry) => entry.available !== false).length;
    const selectedReadIds = new Set(normalizeArray(title.userState?.readChapterIds).map((entry) => normalizeString(entry)));
    const now = new Date().toISOString();
    let clearedBookmarkCount = 0;
    let clearedProgress = false;

    if (action === "read") {
      for (const chapterId of selectedIds) {
        selectedReadIds.add(chapterId);
      }
      const completedAt = selectedReadIds.size >= availableCount && availableCount > 0 ? now : null;
      for (const chapterId of selectedIds) {
        await vaultClient.markChapterRead({
          discordUserId: req.user.discordUserId,
          mediaId: title.id,
          chapterId,
          startedAt: title.userState?.startedAt || now,
          completedAt
        });
      }
    } else {
      for (const chapterId of selectedIds) {
        await vaultClient.markChapterUnread({
          discordUserId: req.user.discordUserId,
          mediaId: title.id,
          chapterId,
          startedAt: title.userState?.startedAt || now
        });
      }
    }

    if (action === "reset") {
      const selectedSet = new Set(selectedIds);
      const bookmarks = normalizeArray(await readUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, []));
      const nextBookmarks = bookmarks.filter((entry) =>
        normalizeString(entry.titleId) !== normalizeString(title.id) || !selectedSet.has(normalizeString(entry.chapterId))
      );
      clearedBookmarkCount = bookmarks.length - nextBookmarks.length;
      if (clearedBookmarkCount > 0) {
        await writeUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, nextBookmarks);
      }
      const progressEntry = normalizeArray(await vaultClient.getProgress(req.user.discordUserId))
        .find((entry) => normalizeString(entry.mediaId) === normalizeString(title.id)) || null;
      if (progressEntry?.bookmark && selectedSet.has(normalizeString(progressEntry.bookmark.chapterId))) {
        await vaultClient.deleteProgress({
          discordUserId: req.user.discordUserId,
          mediaId: title.id
        });
        clearedProgress = true;
      }
    }

    await appendEventForUser({
      domain: "reader",
      eventType: `chapter-bulk-${action}`,
      user: req.user,
      targetType: "title",
      targetId: normalizeString(title.id),
      message: `${req.user.username} updated ${selectedIds.length} chapter${selectedIds.length === 1 ? "" : "s"} on ${title.title}.`,
      metadata: {
        titleId: normalizeString(title.id),
        action,
        chapterIds: selectedIds,
        clearedBookmarkCount,
        clearedProgress
      }
    });
    await sendTitleMutationResponse(req, res, title, {
      action,
      chapterIds: selectedIds,
      clearedBookmarkCount,
      clearedProgress
    });
  }));

  app.get("/api/moon-v3/user/requests", withUser(requireUser, async (req, res) => {
    const requests = (await loadRequests()).filter((entry) => entry.requestedBy.discordUserId === req.user.discordUserId);
    res.json({
      requests,
      tabs: {
        active: requests.filter((entry) => entry.tab === "active").length,
        completed: requests.filter((entry) => entry.tab === "completed").length,
        closed: requests.filter((entry) => entry.tab === "closed").length
      }
    });
  }));

  app.get("/api/moon-v3/user/requests/search", withUser(requireUser, async (req, res) => {
    res.json(await fetchMetadataSearchResults(req.query.query));
  }));

  app.get("/api/moon-v3/user/requests/metadata-search", withUser(requireUser, async (req, res) => {
    res.json(await fetchMetadataSearchResults(req.query.query));
  }));

  app.post("/api/moon-v3/user/requests/download-options", withUser(requireUser, async (req, res) => {
    const selectedMetadata = normalizeObject(req.body?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "selectedMetadata with provider and providerSeriesId is required."});
      return;
    }
    res.json(await fetchDownloadOptions({
      query: normalizeString(req.body?.query),
      selectedMetadata
    }));
  }));

  app.post("/api/moon-v3/user/requests", withUser(requireUser, async (req, res) => {
    if (!hasPermission(req.user, "create_requests")) {
      logger?.warn("Moon v3 request creation denied by policy.", {
        discordUserId: req.user.discordUserId,
        title: req.body?.title
      });
      res.status(403).json({error: "You cannot create requests."});
      return;
    }

    const selectedMetadata = normalizeObject(req.body?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "You must pick an exact metadata result first."});
      return;
    }

    const requestWorkflow = await readRequestWorkflowSettings();
    const downloadResolution = await fetchDownloadOptions({
      query: normalizeString(req.body?.query),
      selectedMetadata
    });
    const effectiveMetadata = normalizeObject(downloadResolution.selectedMetadata, selectedMetadata) || selectedMetadata;
    const autoSelectedDownload = requestWorkflow.autoApproveAndDownload
      ? selectAutoApproveDownload(downloadResolution.results)
      : null;
    const hasConcreteOptions = normalizeArray(downloadResolution.results).length > 0;
    const nextStatus = autoSelectedDownload?.titleUrl
      ? "pending"
      : (hasConcreteOptions ? "pending" : "unavailable");
    const nextAvailability = hasConcreteOptions ? "available" : "unavailable";

    const guard = evaluateSelectionAgainstGuardState(buildIntakeSelection({
      query: normalizeString(req.body?.query),
      title: normalizeString(req.body?.title, effectiveMetadata.title),
      requestType: normalizeString(req.body?.requestType || autoSelectedDownload?.requestType || effectiveMetadata?.type),
      selectedMetadata: effectiveMetadata,
      selectedDownload: autoSelectedDownload
    }), await loadRequestGuardState());
    if (guard.alreadyInLibrary) {
      res.status(409).json(buildLibraryDuplicatePayload({
        matchingTitle: guard.matchingTitle,
        publicBaseUrl: config.publicBaseUrl
      }));
      return;
    }
    if (guard.alreadyQueuedOrRequested) {
      const duplicateRequest = await resolveDuplicateRequestSummary(guard);
      if (duplicateRequest) {
        await attachDuplicateWaitlist({
          requestSummary: duplicateRequest,
          user: req.user,
          source: "moon"
        });
        res.status(409).json(buildActiveRequestDuplicatePayload({
          matchingRequest: duplicateRequest,
          publicBaseUrl: config.publicBaseUrl
        }));
        return;
      }
      res.status(409).json({error: "That title is already queued or has an active request."});
      return;
    }

    let request;
    try {
      request = await vaultClient.createRequest({
        source: "moon",
        title: normalizeString(effectiveMetadata?.title, req.body?.title || "Untitled request"),
        requestType: normalizeString(req.body?.requestType || autoSelectedDownload?.requestType || effectiveMetadata?.type || "manga", "manga"),
        notes: normalizeString(req.body?.notes),
        requestedBy: req.user.discordUserId,
        status: nextStatus,
        details: {
          query: normalizeString(req.body?.query),
          selectedMetadata: effectiveMetadata,
          selectedDownload: autoSelectedDownload,
          availability: nextAvailability,
          sourceFoundOptions: []
        }
      });
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        const duplicateRequest = error.requestId ? await loadRequestById(error.requestId) : null;
        if (duplicateRequest) {
          await attachDuplicateWaitlist({
            requestSummary: duplicateRequest,
            user: req.user,
            source: "moon"
          });
          res.status(409).json(buildActiveRequestDuplicatePayload({
            matchingRequest: duplicateRequest,
            publicBaseUrl: config.publicBaseUrl
          }));
          return;
        }
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }

    await appendEventForUser({
      domain: "requests",
      eventType: nextStatus === "unavailable" ? "request-unavailable" : "request-created",
      user: req.user,
      targetType: "request",
      targetId: normalizeString(request.id),
      message: nextStatus === "unavailable"
        ? `${req.user.username} created an unavailable metadata-backed request.`
        : `${req.user.username} created a new metadata-backed request.`,
      metadata: {
        requestId: normalizeString(request.id),
        title: normalizeString(request.title),
        status: normalizeString(request.status),
        availability: nextAvailability,
        autoApproved: Boolean(autoSelectedDownload?.titleUrl)
      }
    });

    if (autoSelectedDownload?.titleUrl) {
      const queued = await approveAndQueueRequest({
        requestId: request.id,
        requestSummary: await loadRequestById(request.id),
        requestedBy: req.user.discordUserId,
        actor: "scriptarr-sage",
        actorUser: null,
        eventMessage: "Scriptarr auto-approved and queued this request because the download match was high confidence."
      });
      if (queued.ok) {
        res.status(201).json(queued.payload.request);
        return;
      }

      logger?.warn?.("Moon request auto-approve queue failed, leaving request pending.", {
        requestId: request.id,
        error: queued.payload?.error || queued.status
      });
    }

    res.status(201).json(await loadRequestById(request.id));
  }));

  app.patch("/api/moon-v3/user/requests/:id/notes", withUser(requireUser, async (req, res) => {
    const request = await loadRequestById(req.params.id);
    if (!request) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    if (request.requestedBy.discordUserId !== req.user.discordUserId) {
      res.status(403).json({error: "You can only edit your own requests."});
      return;
    }
    if (!request.canEditNotes) {
      res.status(409).json({error: "Notes can only be edited before moderation completes."});
      return;
    }
    await vaultClient.updateRequest(req.params.id, {
      notes: normalizeString(req.body?.notes),
      actor: req.user.username,
      appendStatusEvent: false
    });
    await appendEventForUser({
      domain: "requests",
      eventType: "request-notes-updated",
      user: req.user,
      targetType: "request",
      targetId: normalizeString(req.params.id),
      message: `${req.user.username} updated request notes.`,
      metadata: {
        requestId: normalizeString(req.params.id)
      }
    });
    res.json(await loadRequestById(req.params.id));
  }));

  app.post("/api/moon-v3/user/requests/:id/cancel", withUser(requireUser, async (req, res) => {
    const request = await loadRequestById(req.params.id);
    if (!request) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    if (request.requestedBy.discordUserId !== req.user.discordUserId) {
      res.status(403).json({error: "You can only cancel your own requests."});
      return;
    }
    if (!request.canCancel) {
      res.status(409).json({error: "This request can no longer be canceled from Moon."});
      return;
    }

    await vaultClient.updateRequest(req.params.id, {
      status: "cancelled",
      eventType: "cancelled",
      eventMessage: "Requester canceled this request.",
      actor: req.user.username
    });
    await appendEventForUser({
      domain: "requests",
      eventType: "request-cancelled",
      user: req.user,
      targetType: "request",
      targetId: normalizeString(req.params.id),
      message: `${req.user.username} canceled their request.`,
      metadata: {
        requestId: normalizeString(req.params.id)
      }
    });
    res.json(await loadRequestById(req.params.id));
  }));

  app.get("/api/moon-v3/user/following", withUser(requireUser, async (req, res) => {
    res.json({
      following: normalizeArray(await readUserScopedSetting(vaultClient, "moon.following", req.user.discordUserId, [])).map((entry) => ({
        ...entry,
        libraryTypeLabel: normalizeString(entry.libraryTypeLabel, normalizeString(entry.mediaType, "Manga")),
        libraryTypeSlug: normalizeTypeSlug(entry.libraryTypeSlug || entry.mediaType)
      }))
    });
  }));

  app.post("/api/moon-v3/user/following", withUser(requireUser, async (req, res) => {
    const current = normalizeArray(await readUserScopedSetting(vaultClient, "moon.following", req.user.discordUserId, []));
    const nextEntry = {
      titleId: normalizeString(req.body.titleId),
      title: normalizeString(req.body.title),
      latestChapter: normalizeString(req.body.latestChapter),
      mediaType: normalizeString(req.body.mediaType, "manga"),
      libraryTypeLabel: normalizeString(req.body.libraryTypeLabel, normalizeString(req.body.mediaType, "Manga")),
      libraryTypeSlug: normalizeTypeSlug(req.body.libraryTypeSlug || req.body.mediaType)
    };
    const deduped = [...current.filter((entry) => entry.titleId !== nextEntry.titleId), nextEntry];
    await writeUserScopedSetting(vaultClient, "moon.following", req.user.discordUserId, deduped);
    await appendEventForUser({
      domain: "follow",
      eventType: "follow-added",
      user: req.user,
      targetType: "title",
      targetId: normalizeString(nextEntry.titleId),
      message: `${req.user.username} followed ${normalizeString(nextEntry.title, "a title")}.`,
      metadata: nextEntry
    });
    res.status(201).json({following: deduped});
  }));

  app.delete("/api/moon-v3/user/following/:titleId", withUser(requireUser, async (req, res) => {
    const current = normalizeArray(await readUserScopedSetting(vaultClient, "moon.following", req.user.discordUserId, []));
    const removed = current.find((entry) => entry.titleId === req.params.titleId) || null;
    const next = current.filter((entry) => entry.titleId !== req.params.titleId);
    await writeUserScopedSetting(vaultClient, "moon.following", req.user.discordUserId, next);
    if (removed) {
      await appendEventForUser({
        domain: "follow",
        eventType: "follow-removed",
        user: req.user,
        targetType: "title",
        targetId: normalizeString(removed.titleId),
        message: `${req.user.username} unfollowed ${normalizeString(removed.title, "a title")}.`,
        metadata: removed
      });
    }
    res.status(204).end();
  }));

  app.get("/api/moon-v3/user/reader/preferences", withUser(requireUser, async (req, res) => {
    const typeSlug = normalizeTypeSlug(req.query.typeSlug || req.query.type || "manga");
    const titleId = normalizeString(req.query.titleId);
    const storedPreferences = await readUserScopedSetting(vaultClient, "moon.reader.preferences", req.user.discordUserId, {});
    res.json(resolveReaderPreferences(storedPreferences, typeSlug, titleId));
  }));

  app.put("/api/moon-v3/user/reader/preferences", withUser(requireUser, async (req, res) => {
    const typeSlug = normalizeTypeSlug(req.body.typeSlug || req.body.type || "manga");
    const titleId = normalizeString(req.body.titleId);
    const storedPreferences = await readUserScopedSetting(vaultClient, "moon.reader.preferences", req.user.discordUserId, {});
    const nextStore = mergeReaderPreferences(storedPreferences, typeSlug, {...req.body, titleId});
    await writeUserScopedSetting(vaultClient, "moon.reader.preferences", req.user.discordUserId, nextStore);
    res.json(resolveReaderPreferences(nextStore, typeSlug, titleId));
  }));

  app.get("/api/moon-v3/user/reader/bookmarks", withUser(requireUser, async (req, res) => {
    const bookmarks = normalizeArray(await readUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, []));
    const titleId = normalizeString(req.query.titleId);
    const chapterId = normalizeString(req.query.chapterId);
    res.json({
      bookmarks: bookmarks.filter((entry) =>
        (!titleId || entry.titleId === titleId) && (!chapterId || entry.chapterId === chapterId)
      )
    });
  }));

  app.post("/api/moon-v3/user/reader/bookmarks", withUser(requireUser, async (req, res) => {
    const bookmarks = normalizeArray(await readUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, []));
    const nextEntry = {
      id: normalizeString(req.body.id, `bookmark_${Date.now().toString(36)}`),
      titleId: normalizeString(req.body.titleId),
      chapterId: normalizeString(req.body.chapterId),
      pageIndex: Number.parseInt(String(req.body.pageIndex || 0), 10) || 0,
      label: normalizeString(req.body.label, "Bookmark"),
      createdAt: new Date().toISOString()
    };
    const next = [...bookmarks.filter((entry) => entry.id !== nextEntry.id), nextEntry];
    await writeUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, next);
    await appendEventForUser({
      domain: "reader",
      eventType: "bookmark-created",
      user: req.user,
      targetType: "bookmark",
      targetId: normalizeString(nextEntry.id),
      message: `${req.user.username} saved a reader bookmark.`,
      metadata: nextEntry
    });
    res.status(201).json(nextEntry);
  }));

  app.delete("/api/moon-v3/user/reader/bookmarks/:bookmarkId", withUser(requireUser, async (req, res) => {
    const bookmarks = normalizeArray(await readUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, []));
    const removed = bookmarks.find((entry) => entry.id === req.params.bookmarkId) || null;
    const next = bookmarks.filter((entry) => entry.id !== req.params.bookmarkId);
    await writeUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, next);
    if (removed) {
      await appendEventForUser({
        domain: "reader",
        eventType: "bookmark-deleted",
        user: req.user,
        targetType: "bookmark",
        targetId: normalizeString(removed.id),
        message: `${req.user.username} removed a reader bookmark.`,
        metadata: removed
      });
    }
    res.status(204).end();
  }));

  app.get("/api/moon-v3/user/reader/progress", withUser(requireUser, async (req, res) => {
    res.json({progress: normalizeArray(await vaultClient.getProgress(req.user.discordUserId))});
  }));

  app.put("/api/moon-v3/user/reader/progress", withUser(requireUser, async (req, res) => {
    const currentProgress = normalizeArray(await vaultClient.getProgress(req.user.discordUserId));
    const previousEntry = currentProgress.find((entry) => entry.mediaId === normalizeString(req.body.mediaId)) || null;
    const payload = await vaultClient.upsertProgress({
      mediaId: req.body.mediaId,
      discordUserId: req.user.discordUserId,
      chapterLabel: req.body.chapterLabel,
      positionRatio: req.body.positionRatio,
      bookmark: req.body.bookmark || null
    });
    const nextRatio = Number.parseFloat(String(payload?.positionRatio ?? req.body?.positionRatio ?? 0)) || 0;
    const previousRatio = Number.parseFloat(String(previousEntry?.positionRatio ?? 0)) || 0;
    const previousChapter = normalizeString(previousEntry?.chapterLabel);
    const nextChapter = normalizeString(payload?.chapterLabel, normalizeString(req.body?.chapterLabel));
    if (nextChapter && nextChapter !== previousChapter) {
      await appendEventForUser({
        domain: "reader",
        eventType: "chapter-progressed",
        user: req.user,
        targetType: "media",
        targetId: normalizeString(payload?.mediaId, normalizeString(req.body?.mediaId)),
        message: `${req.user.username} moved to ${nextChapter}.`,
        metadata: {
          mediaId: normalizeString(payload?.mediaId, normalizeString(req.body?.mediaId)),
          chapterLabel: nextChapter,
          positionRatio: nextRatio
        }
      });
    }
    if (nextRatio >= 0.999 && previousRatio < 0.999) {
      if (normalizeString(req.body?.bookmark?.chapterId) && normalizeString(req.body?.mediaId)) {
        await vaultClient.markChapterRead({
          discordUserId: req.user.discordUserId,
          mediaId: normalizeString(req.body.mediaId),
          chapterId: normalizeString(req.body.bookmark.chapterId),
          startedAt: previousEntry?.updatedAt || new Date().toISOString()
        });
      }
      await appendEventForUser({
        domain: "reader",
        eventType: "chapter-completed",
        user: req.user,
        targetType: "media",
        targetId: normalizeString(payload?.mediaId, normalizeString(req.body?.mediaId)),
        message: `${req.user.username} completed ${nextChapter || "a chapter"}.`,
        metadata: {
          mediaId: normalizeString(payload?.mediaId, normalizeString(req.body?.mediaId)),
          chapterLabel: nextChapter,
          positionRatio: nextRatio
        }
      });
    }
    res.json(payload);
  }));

  app.get("/api/moon-v3/user/reader/title/:titleId", withUser(requireUser, async (req, res) => {
    const [result, userInputs] = await Promise.all([
      serviceJson(config.ravenBaseUrl, `/v1/reader/${encodeURIComponent(req.params.titleId)}`),
      loadUserStateInputs(req.user.discordUserId)
    ]);
    if (!result.ok) {
      res.status(result.status).json(result.payload);
      return;
    }

    const titleState = buildUserTitleStateFromInputs(toTitleSummary({
      ...(result.payload?.title || {}),
      chapters: normalizeArray(result.payload?.chapters)
    }), userInputs);
    if (!titleState?.title) {
      res.status(404).json({error: "Title not found."});
      return;
    }

    res.json({
      title: titleState.title,
      chapters: normalizeArray(titleState.title.chapters)
    });
  }));

  const loadReaderChapterContext = async ({titleId, chapterId, discordUserId}) => {
    const [chapter, userInputs, bookmarks, storedPreferences] = await Promise.all([
      serviceJson(config.ravenBaseUrl, `/v1/reader/${encodeURIComponent(titleId)}/${encodeURIComponent(chapterId)}`),
      loadUserStateInputs(discordUserId),
      readUserScopedSetting(vaultClient, "moon.reader.bookmarks", discordUserId, []),
      readUserScopedSetting(vaultClient, "moon.reader.preferences", discordUserId, {})
    ]);

    if (!chapter.ok) {
      return {
        ok: false,
        status: chapter.status,
        payload: chapter.payload
      };
    }

    const payload = normalizeObject(chapter.payload, {}) || {};
    const rawTitle = toTitleSummary(payload.title || {id: titleId});
    const titleState = buildUserTitleStateFromInputs(rawTitle, userInputs);
    const fullTitle = titleState?.title || rawTitle;
    const chapterSummary = toChapterSummary(payload.chapter);
    const fullChapters = normalizeArray(fullTitle?.chapters);
    const enrichedChapter = fullChapters.find((entry) => entry.id === chapterId) || chapterSummary;
    const pages = normalizeArray(payload.pages);
    const pageCount = pages.length || enrichedChapter.pageCount || chapterSummary.pageCount || 0;
    const chapterIndex = fullChapters.findIndex((entry) => entry.id === chapterId);
    const adjacentChapterIds = resolveReaderAdjacentChapterIds(fullChapters, chapterId);
    const previousChapterId = adjacentChapterIds.matched
      ? adjacentChapterIds.previousChapterId
      : normalizeString(payload.previousChapterId) || (chapterIndex > 0 ? normalizeString(fullChapters[chapterIndex - 1]?.id) : "");
    const nextChapterId = adjacentChapterIds.matched
      ? adjacentChapterIds.nextChapterId
      : normalizeString(payload.nextChapterId) || (chapterIndex > -1 ? normalizeString(fullChapters[chapterIndex + 1]?.id) : "");
    const typeSlug = normalizeTypeSlug(fullTitle.libraryTypeSlug || fullTitle.mediaType);
    const titleProgressId = normalizeString(payload.title?.id || fullTitle.id || titleId);
    const progressEntry = normalizeArray(userInputs.progress).find((entry) => normalizeString(entry.mediaId) === titleProgressId);
    const pageBase = buildReaderPageBase(titleId, chapterId);
    const pageRevision = buildReaderPageRevision({
      title: fullTitle,
      chapter: enrichedChapter,
      pages
    });

    return {
      ok: true,
      payload,
      fullTitle,
      title: stripReaderTitleChapters(fullTitle),
      chapter: {
        ...enrichedChapter,
        pageCount
      },
      pages,
      pageBase,
      pageRevision,
      pageCount,
      previousChapterId: previousChapterId || null,
      nextChapterId: nextChapterId || null,
      progress: progressEntry || null,
      bookmarks: normalizeArray(bookmarks).filter((entry) =>
        normalizeString(entry.titleId) === normalizeString(titleId)
        && normalizeString(entry.chapterId) === normalizeString(chapterId)
      ),
      preferences: resolveReaderPreferences(storedPreferences, typeSlug, titleId)
    };
  };

  app.get("/api/moon-v3/user/reader/title/:titleId/chapter/:chapterId/session", withUser(requireUser, async (req, res) => {
    const context = await loadReaderChapterContext({
      titleId: req.params.titleId,
      chapterId: req.params.chapterId,
      discordUserId: req.user.discordUserId
    });
    if (!context.ok) {
      res.status(context.status).json(context.payload);
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      title: context.title,
      chapter: context.chapter,
      previousChapterId: context.previousChapterId,
      nextChapterId: context.nextChapterId,
      pageCount: context.pageCount,
      pageBase: context.pageBase,
      pageRevision: context.pageRevision,
      progress: context.progress,
      bookmarks: context.bookmarks,
      preferences: context.preferences
    });
  }));

  app.get("/api/moon-v3/user/reader/title/:titleId/chapter/:chapterId/pages", withUser(requireUser, async (req, res) => {
    const context = await loadReaderChapterContext({
      titleId: req.params.titleId,
      chapterId: req.params.chapterId,
      discordUserId: req.user.discordUserId
    });
    if (!context.ok) {
      res.status(context.status).json(context.payload);
      return;
    }

    const pageRevision = context.pageRevision;
    const immutableRequest = normalizeString(req.query.rev) === pageRevision;
    res.setHeader("Cache-Control", immutableRequest ? "private, max-age=604800" : "no-store");
    res.json({
      titleId: req.params.titleId,
      chapterId: req.params.chapterId,
      pageRevision,
      ...toReaderPageRows({
        pages: context.pages,
        pageBase: context.pageBase,
        pageRevision,
        cursor: req.query.cursor,
        pageSize: req.query.pageSize
      })
    });
  }));

  app.get("/api/moon-v3/user/reader/title/:titleId/chapter/:chapterId", withUser(requireUser, async (req, res) => {
    const [manifest, context] = await Promise.all([
      serviceJson(config.ravenBaseUrl, `/v1/reader/${encodeURIComponent(req.params.titleId)}`),
      loadReaderChapterContext({
        titleId: req.params.titleId,
        chapterId: req.params.chapterId,
        discordUserId: req.user.discordUserId
      })
    ]);

    if (!context.ok) {
      res.status(context.status).json(context.payload);
      return;
    }

    const manifestTitle = manifest.ok
      ? toTitleSummary({
        ...(manifest.payload?.title || context.fullTitle || {}),
        chapters: normalizeArray(manifest.payload?.chapters)
      })
      : context.fullTitle;
    const manifestPayload = manifest.ok
      ? {
        title: context.fullTitle,
        chapters: normalizeArray(context.fullTitle?.chapters).length
          ? normalizeArray(context.fullTitle.chapters)
          : normalizeArray(manifest.payload?.chapters).map(toChapterSummary)
      }
      : {
        title: context.fullTitle,
        chapters: normalizeArray(context.fullTitle?.chapters).length
          ? normalizeArray(context.fullTitle.chapters)
          : [context.chapter]
      };

    if (!manifestPayload.title?.id && manifestTitle?.id) {
      manifestPayload.title = manifestTitle;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...context.payload,
      title: context.fullTitle,
      chapter: context.chapter,
      previousChapterId: context.previousChapterId,
      nextChapterId: context.nextChapterId,
      pageCount: context.pageCount,
      pageRevision: context.pageRevision,
      manifest: manifestPayload,
      pages: context.pages.map((page, offset) => {
        const pageIndex = Number.parseInt(String(page?.index ?? offset), 10);
        const index = Number.isFinite(pageIndex) ? pageIndex : offset;
        return {
          ...page,
          index,
          label: normalizeString(page?.label, `Page ${index + 1}`),
          src: withReaderPageRevision(context.pageBase, index, context.pageRevision)
        };
      }),
      progress: context.progress,
      bookmarks: context.bookmarks,
      preferences: context.preferences
    });
  }));

  app.get("/api/moon-v3/user/reader/title/:titleId/chapter/:chapterId/page/:pageIndex", withUser(requireUser, async (req, res) => {
    const response = await fetch(
      `${config.ravenBaseUrl}/v1/reader/${encodeURIComponent(req.params.titleId)}/${encodeURIComponent(req.params.chapterId)}/page/${encodeURIComponent(req.params.pageIndex)}`,
      {
        headers: {"Accept": "image/svg+xml"}
      }
    );

    res.status(response.status);
    res.setHeader("Cache-Control", "private, max-age=604800");
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    const contentLength = response.headers.get("content-length");
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    if (etag) {
      res.setHeader("ETag", etag);
    }
    if (lastModified) {
      res.setHeader("Last-Modified", lastModified);
    }
    if (!response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body).pipe(res);
  }));
};

export default registerMoonV3Routes;

