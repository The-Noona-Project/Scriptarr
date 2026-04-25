/**
 * @file Scriptarr Sage module: services/sage/lib/registerMoonV3Routes.mjs.
 */
import {ADMIN_ACCESS_DOMAINS} from "@scriptarr/access";
import {hasDomainAccess, hasPermission} from "./auth.mjs";
import {appendDurableEvent, appendUserEvent, buildServiceActor, buildUserActor} from "./adminEvents.mjs";
import {buildIntakeSelection, evaluateSelectionAgainstGuardState} from "./requestSelectionGuards.mjs";
import {buildRequestWorkConflictPayload, isRequestWorkConflictError} from "./requestConflict.mjs";
import {buildMoonHomePayload} from "./buildMoonHomePayload.mjs";
import {
  buildMoonUserLibraryState,
  getTagPreference,
  normalizeTagPreferenceStore,
  setTagPreference
} from "./moonUserState.mjs";
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

const defaultReaderPreferences = Object.freeze({
  readingMode: "infinite",
  pageFit: "width",
  showSidebar: false,
  showPageNumbers: true
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
  settings: "settings",
  system: "system",
  publicapi: "publicapi",
  follow: "library",
  reader: "library"
});

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

const defaultReaderPreferencesForType = (typeSlug) => ({
  ...defaultReaderPreferences,
  readingMode: normalizeTypeSlug(typeSlug) === "webtoon" ? "infinite" : "infinite"
});

const normalizeStoredReaderPreferenceLeaf = (value = {}) => ({
  ...(["paged", "webtoon", "infinite"].includes(normalizeString(value.readingMode))
    ? {readingMode: normalizeString(value.readingMode)}
    : {}),
  ...(["width", "contain", "height"].includes(normalizeString(value.pageFit))
    ? {pageFit: normalizeString(value.pageFit)}
    : {}),
  ...(typeof value.showSidebar === "boolean" ? {showSidebar: value.showSidebar} : {}),
  ...(typeof value.showPageNumbers === "boolean" ? {showPageNumbers: value.showPageNumbers} : {})
});

const normalizeReaderPreferenceLeaf = (value = {}, typeSlug = "manga") => {
  const defaults = defaultReaderPreferencesForType(typeSlug);
  return {
    readingMode: ["paged", "webtoon", "infinite"].includes(normalizeString(value.readingMode))
      ? normalizeString(value.readingMode)
      : defaults.readingMode,
    pageFit: ["width", "contain", "height"].includes(normalizeString(value.pageFit))
      ? normalizeString(value.pageFit)
      : defaults.pageFit,
    showSidebar: typeof value.showSidebar === "boolean" ? value.showSidebar : defaults.showSidebar,
    showPageNumbers: typeof value.showPageNumbers === "boolean" ? value.showPageNumbers : defaults.showPageNumbers
  };
};

const normalizeReaderPreferenceStore = (value = {}) => {
  const legacy = value
    && !value.defaultPreferences
    && !value.typePreferences
    && ["readingMode", "pageFit", "showSidebar", "showPageNumbers"].some((key) => key in value)
    ? value
    : null;
  const rawTypePreferences = legacy ? {} : value?.typePreferences;
  return {
    defaultPreferences: normalizeStoredReaderPreferenceLeaf(legacy || value?.defaultPreferences || {}),
    typePreferences: Object.fromEntries(Object.entries(rawTypePreferences || {}).map(([typeSlug, preferences]) => [
      normalizeTypeSlug(typeSlug),
      normalizeReaderPreferenceLeaf(preferences, typeSlug)
    ]))
  };
};

const resolveReaderPreferences = (value, typeSlug) => {
  const store = normalizeReaderPreferenceStore(value);
  const normalizedType = normalizeTypeSlug(typeSlug);
  return {
    ...defaultReaderPreferencesForType(normalizedType),
    ...store.defaultPreferences,
    ...(store.typePreferences[normalizedType] || {})
  };
};

const mergeReaderPreferences = (currentValue, typeSlug, nextValue) => {
  const store = normalizeReaderPreferenceStore(currentValue);
  const normalizedType = normalizeTypeSlug(typeSlug);
  return {
    ...store,
    typePreferences: {
      ...store.typePreferences,
      [normalizedType]: normalizeReaderPreferenceLeaf(nextValue, normalizedType)
    }
  };
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
  sourceUrl: normalizeString(chapter.sourceUrl)
});

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

const buildLogRows = ({bootstrap, oracle, portal, raven, titles, tasks, requests}) => {
  const rows = [];

  if (bootstrap?.services) {
    for (const service of bootstrap.services) {
      rows.push(`[bootstrap] ${service.name} -> ${service.image}`);
    }
  }

  rows.push(`[oracle] provider=${oracle?.provider || "unknown"} enabled=${oracle?.enabled === true}`);
  rows.push(`[portal] discord=${portal?.discord || "unknown"}`);
  rows.push(`[raven] titles=${titles.length} tasks=${tasks.length}`);

  for (const request of requests.slice(0, 10)) {
    rows.push(`[request:${request.status}] ${request.title} (${request.requestedBy.username || request.requestedBy.discordUserId || "unknown"})`);
  }

  return rows;
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
 *   readRequestWorkflowSettings: () => Promise<Record<string, unknown>>,
 *   readOracleSettings: () => Promise<Record<string, unknown>>,
 *   readMoonBrandingSettings: () => Promise<Record<string, unknown>>,
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
  readRequestWorkflowSettings,
  readOracleSettings,
  readMoonBrandingSettings,
  readMoonPublicApiSettings,
  readPortalDiscordSettings,
  serviceJson,
  safeJson
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

  const readUserTagPreferences = async (discordUserId) =>
    normalizeTagPreferenceStore(await readUserScopedSetting(vaultClient, "moon.tag-preferences", discordUserId, {}));

  const loadUserLibraryState = async (discordUserId, titles = null) => {
    const resolvedTitles = Array.isArray(titles) ? titles : await loadLibrary();
    const [progress, readState, following, tagPreferences] = await Promise.all([
      vaultClient.getProgress(discordUserId),
      vaultClient.getReadState(discordUserId),
      readUserScopedSetting(vaultClient, "moon.following", discordUserId, []),
      readUserTagPreferences(discordUserId)
    ]);
    const normalizedFollowing = normalizeArray(following).map(normalizeFollowingEntry);
    const derived = buildMoonUserLibraryState({
      titles: resolvedTitles,
      progress: normalizeArray(progress),
      readState,
      following: normalizedFollowing
    });
    return {
      ...derived,
      progress: normalizeArray(progress),
      readState,
      following: normalizedFollowing,
      tagPreferences
    };
  };

  const loadUserTitleState = async (discordUserId, titleId, title = null) => {
    const resolvedTitle = title || await loadLibraryTitle(titleId);
    if (!resolvedTitle?.id) {
      return null;
    }
    const userLibrary = await loadUserLibraryState(discordUserId, [resolvedTitle]);
    const userTitle = userLibrary.titles[0] || resolvedTitle;
    return {
      title: decorateTitleWithTagPreferences(userTitle, userLibrary.tagPreferences),
      userLibrary
    };
  };

  const loadRequestById = async (requestId) => {
    const [userIndex, request] = await Promise.all([
      loadUserIndex(),
      vaultClient.getRequest(requestId)
    ]);
    return request ? toRequestSummary(request, userIndex) : null;
  };

  const loadTasks = async () => {
    const ravenPayload = await fetchRavenJson("/v1/downloads/tasks");
    const ravenTasks = normalizeArray(ravenPayload).map((task) => ({
      taskId: normalizeString(task.taskId),
      jobId: normalizeString(task.jobId, normalizeString(task.taskId)),
      requestId: normalizeString(task.requestId),
      titleId: normalizeString(task.titleId),
      titleName: normalizeString(task.titleName),
      titleUrl: normalizeString(task.titleUrl),
      providerId: normalizeString(task.providerId),
      requestType: normalizeString(task.requestType, "manga"),
      libraryTypeSlug: normalizeTypeSlug(task.libraryTypeSlug || task.requestType),
      coverUrl: normalizeString(task.coverUrl, normalizeString(task.details?.coverUrl)),
      requestedBy: normalizeString(task.requestedBy),
      status: normalizeString(task.status, "queued"),
      message: normalizeString(task.message),
      percent: Number.parseInt(String(task.percent || 0), 10) || 0,
      queuedAt: parseIso(task.queuedAt),
      updatedAt: parseIso(task.updatedAt),
      source: "raven"
    }));
    const jobs = normalizeArray(await vaultClient.listJobs()).filter((job) =>
      ["scriptarr-warden", "scriptarr-raven"].includes(normalizeString(job.ownerService))
    );
    const brokerTasksNested = await Promise.all(jobs.map(async (job) =>
      normalizeArray(await vaultClient.listJobTasks(job.jobId)).map((task) => ({
        taskId: normalizeString(task.taskId),
        jobId: normalizeString(job.jobId),
        requestId: normalizeString(task.payload?.requestId, normalizeString(job.payload?.requestId)),
        titleId: normalizeString(task.result?.titleId, normalizeString(job.result?.titleId)),
        titleName: normalizeString(task.label || job.label || job.kind, "Background job"),
        titleUrl: normalizeString(task.payload?.titleUrl, normalizeString(job.payload?.titleUrl)),
        providerId: normalizeString(task.payload?.providerId, normalizeString(job.payload?.providerId)),
        requestType: normalizeString(task.payload?.requestType || job.payload?.requestType || job.kind, "job"),
        libraryTypeSlug: normalizeTypeSlug(task.payload?.libraryTypeSlug || job.payload?.libraryTypeSlug || task.payload?.requestType || job.payload?.requestType || "manga"),
        coverUrl: normalizeString(task.result?.coverUrl, normalizeString(job.result?.coverUrl)),
        requestedBy: normalizeString(job.ownerService || task.requestedBy || "scriptarr"),
        status: normalizeString(task.status || job.status, "queued"),
        message: normalizeString(task.message || job.label || "Background task updated."),
        percent: Number.parseInt(String(task.percent || 0), 10) || 0,
        queuedAt: parseIso(task.createdAt || job.createdAt),
        updatedAt: parseIso(task.updatedAt || job.updatedAt),
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

  const fetchMetadataSearchResults = async (query) => {
    const normalizedQuery = normalizeString(query);
    if (!normalizedQuery) {
      return {query: "", results: []};
    }

    const payload = await fetchRavenJson(`/v1/metadata/search?name=${encodeURIComponent(normalizedQuery)}`);
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

  const approveAndQueueRequest = async ({
    requestId,
    requestSummary,
    requestedBy,
    actor,
    actorUser,
    comment,
    eventMessage
  }) => {
    const queueResult = await queueSelectedDownload({
      requestId,
      requestSummary,
      requestedBy
    });
    if (!queueResult.ok) {
      return queueResult;
    }

    await vaultClient.updateRequest(requestId, {
      status: "queued",
      eventType: "approved",
      eventMessage: normalizeString(eventMessage, normalizeString(comment, "Approved from Moon admin.")),
      moderatorComment: normalizeString(comment),
      actor: normalizeString(actor),
      appendStatusEvent: false,
      detailsMerge: {
        availability: "available",
        selectedMetadata: requestSummary.details?.selectedMetadata || null,
        selectedDownload: requestSummary.details?.selectedDownload || null,
        sourceFoundAt: "",
        sourceFoundOptions: [],
        jobId: normalizeString(queueResult.payload?.jobId),
        taskId: normalizeString(queueResult.payload?.taskId)
      }
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
        request: await loadRequestById(requestId),
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
  const requireWantedRead = (handler) => withAdminAccess("wanted", "read", handler);
  const requireRequestRead = (handler) => withAdminAccess("requests", "read", handler);
  const requireRequestWrite = (handler) => withAdminAccess("requests", "write", handler);
  const requireRequestRoot = (handler) => withAdminAccess("requests", "root", handler);
  const requireUsersRead = (handler) => withAdminAccess("users", "read", handler);
  const requireUsersRoot = (handler) => withAdminAccess("users", "root", handler);
  const requireDiscordRead = (handler) => withAdminAccess("discord", "read", handler);
  const requireMediaManagementRead = (handler) => withAdminAccess("mediamanagement", "read", handler);
  const requireSettingsRead = (handler) => withAdminAccess("settings", "read", handler);
  const requireSettingsWrite = (handler) => withAdminAccess("settings", "write", handler);
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

  app.get("/api/moon-v3/public/branding", async (_req, res) => {
    res.json(await readMoonBrandingSettings());
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
    const rawEntries = titles.flatMap((title) =>
      normalizeArray(title.chapters).map((chapter) => ({
        titleId: title.id,
        title: title.title,
        coverUrl: title.coverUrl || "",
        libraryTypeLabel: title.libraryTypeLabel || title.mediaType || "Manga",
        libraryTypeSlug: title.libraryTypeSlug || title.mediaType || "manga",
        mediaType: title.mediaType,
        metadataProvider: title.metadataProvider || "",
        sourceUrl: title.sourceUrl || chapter.sourceUrl || "",
        chapterId: chapter.id,
        chapterLabel: chapter.label,
        chapterNumber: chapter.chapterNumber || "",
        pageCount: chapter.pageCount || 0,
        titleStatus: title.status || "active",
        releaseDate: chapter.releaseDate,
        available: chapter.available
      }))
    );
    const entries = rawEntries
      .filter((entry) => Date.parse(entry.releaseDate || ""))
      .sort((left, right) => Date.parse(left.releaseDate || "") - Date.parse(right.releaseDate || ""));

    res.json({
      entries,
      undatedCount: Math.max(0, rawEntries.length - entries.length)
    });
  }));

  app.get("/api/moon-v3/admin/activity/queue", requireActivityRead(async (_req, res) => {
    const tasks = await loadTasks();
    res.json({tasks: tasks.filter((entry) => entry.status === "queued" || entry.status === "running")});
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
    res.json({
      entries: titles
        .map((title) => ({
          ...title,
          missingCount: Math.max(0, title.chapterCount - title.chaptersDownloaded)
        }))
        .filter((title) => title.missingCount > 0)
    });
  }));

  app.get("/api/moon-v3/admin/wanted/metadata-gaps", requireWantedRead(async (_req, res) => {
    const titles = await loadLibrary();
    res.json({
      entries: titles
        .map((title) => ({
          ...title,
          gaps: [
            !title.metadataProvider ? "provider" : null,
            !title.summary ? "summary" : null,
            title.aliases.length === 0 ? "aliases" : null
          ].filter(Boolean)
        }))
        .filter((title) => title.gaps.length > 0)
    });
  }));

  app.get("/api/moon-v3/admin/requests", requireRequestRead(async (_req, res) => {
    res.json({requests: await loadRequests()});
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
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }

    const approved = await approveAndQueueRequest({
      requestId: req.params.id,
      requestSummary: await loadRequestById(req.params.id),
      requestedBy: existing.requestedBy.discordUserId || req.user.discordUserId,
      actor: req.user.username,
      actorUser: req.user,
      comment: normalizeString(req.body?.comment, "Approved from Moon admin."),
      eventMessage: normalizeString(req.body?.comment, "Approved from Moon admin.")
    });
    res.status(approved.status).json(approved.payload);
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
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
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
        detailsMerge: {
          query: normalizeString(req.body?.query, existing.details?.query),
          selectedMetadata,
          selectedDownload,
          availability: "available"
        },
        actor: req.user.username
      });
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
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

    await vaultClient.updateRequest(req.params.id, {
      status: "queued",
      eventType: "approved",
      eventMessage: "Unavailable request resolved and queued from Moon admin.",
      actor: req.user.username,
      appendStatusEvent: false,
      detailsMerge: {
        query: normalizeString(req.body?.query, existing.details?.query),
        selectedMetadata,
        selectedDownload,
        availability: "available",
        jobId: normalizeString(queueResult.payload?.jobId),
        taskId: normalizeString(queueResult.payload?.taskId)
      }
    });
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
      request: await vaultClient.getRequest(req.params.id),
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
    await vaultClient.updateRequest(req.params.id, {
      status: nextOptions.length ? "pending" : "unavailable",
      actor: req.user.username,
      appendStatusEvent: false,
      detailsMerge: {
        selectedMetadata: normalizeObject(downloads.selectedMetadata, selectedMetadata) || selectedMetadata,
        selectedDownload: null,
        availability: nextOptions.length ? "available" : "unavailable",
        sourceFoundAt: nextOptions.length ? new Date().toISOString() : "",
        sourceFoundOptions: nextOptions
      }
    });
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

  app.get("/api/moon-v3/admin/settings", requireSettingsRead(async (_req, res) => {
    const [ravenVpn, metadataProviders, downloadProviders, requestWorkflow, oracle, branding, discord, wardenStatus] = await Promise.all([
      readRavenVpnSettings(),
      readMetadataProviderSettings(),
      readDownloadProviderSettings(),
      readRequestWorkflowSettings(),
      readOracleSettings(),
      readMoonBrandingSettings(),
      readPortalDiscordSettings(),
      safeJson(serviceJson(config.wardenBaseUrl, "/api/localai/status"))
    ]);

    res.json({
      ravenVpn,
      metadataProviders,
      downloadProviders,
      requestWorkflow,
      oracle,
      branding,
      discord,
      warden: wardenStatus.payload || wardenStatus
    });
  }));

  app.get("/api/moon-v3/admin/events", withUser(requireUser, async (req, res) => {
    const domains = normalizeRequestedEventDomains(req.query.domain);
    if (!ensureEventReadAccess(req.user, domains)) {
      res.status(403).json({error: "Missing admin grant for the requested event domains."});
      return;
    }
    res.json({
      events: normalizeArray(await vaultClient.listEvents({
        domains,
        actorId: normalizeString(req.query.actorId),
        targetId: normalizeString(req.query.targetId),
        afterSequence: req.query.afterSequence || req.query.after || 0,
        limit: req.query.limit || 100,
        newestFirst: req.query.newestFirst !== "false"
      }))
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

  app.get("/api/moon-v3/admin/system/status", requireSystemRead(async (_req, res) => {
    const [services, bootstrap, runtime, contentReset] = await Promise.all([
      loadServiceStatus(),
      safeJson(serviceJson(config.wardenBaseUrl, "/api/bootstrap")),
      safeJson(serviceJson(config.wardenBaseUrl, "/api/runtime")),
      previewContentReset()
    ]);

    res.json({
      services,
      bootstrap: bootstrap.payload || bootstrap,
      runtime: runtime.payload || runtime,
      contentReset
    });
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
    const [tasks, requests] = await Promise.all([loadTasks(), loadRequests()]);
    res.json({
      tasks,
      pendingRequests: requests.filter((entry) => entry.status === "pending")
    });
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

  app.get("/api/moon-v3/admin/system/events", requireSystemRead(async (_req, res) => {
    res.json({
      events: normalizeArray(await vaultClient.listEvents({
        limit: 120
      }))
    });
  }));

  app.get("/api/moon-v3/admin/system/logs", requireSystemRead(async (_req, res) => {
    const [bootstrap, oracle, portal, raven, titles, tasks, requests] = await Promise.all([
      safeJson(serviceJson(config.wardenBaseUrl, "/api/bootstrap")),
      safeJson(fetch(`${config.oracleBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.portalBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.ravenBaseUrl}/health`).then((response) => response.json())),
      loadLibrary(),
      loadTasks(),
      loadRequests()
    ]);

    res.json({
      entries: buildLogRows({
        bootstrap: bootstrap.payload || bootstrap,
        oracle,
        portal,
        raven,
        titles,
        tasks,
        requests
      })
    });
  }));

  app.get("/api/moon-v3/user/home", withUser(requireUser, async (req, res) => {
    const [titles, requests, userLibrary] = await Promise.all([
      loadLibrary(),
      loadRequests(),
      loadUserLibraryState(req.user.discordUserId)
    ]);

    res.json(buildMoonHomePayload({
      titles: userLibrary.titles.length ? userLibrary.titles : titles,
      requests,
      bookshelf: userLibrary.bookshelf,
      following: userLibrary.following,
      discordUserId: req.user.discordUserId,
      tagPreferences: userLibrary.tagPreferences
    }));
  }));

  app.get("/api/moon-v3/user/library", withUser(requireUser, async (_req, res) => {
    res.json({titles: await loadLibrary()});
  }));

  app.get("/api/moon-v3/user/title/:titleId", withUser(requireUser, async (req, res) => {
    const [titleState, requests] = await Promise.all([
      loadUserTitleState(req.user.discordUserId, req.params.titleId),
      loadRequests()
    ]);
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
    const refreshed = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    res.json({
      title: refreshed?.title || titleState.title
    });
  }));

  app.post("/api/moon-v3/user/title/:titleId/unread", withUser(requireUser, async (req, res) => {
    const titleState = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    if (!titleState?.title) {
      res.status(404).json({error: "Title not found."});
      return;
    }
    await vaultClient.markTitleUnread({
      discordUserId: req.user.discordUserId,
      mediaId: titleState.title.id,
      startedAt: new Date().toISOString()
    });
    await appendEventForUser({
      domain: "reader",
      eventType: "title-marked-unread",
      user: req.user,
      targetType: "title",
      targetId: normalizeString(titleState.title.id),
      message: `${req.user.username} put ${titleState.title.title} back on their bookshelf.`,
      metadata: {
        titleId: normalizeString(titleState.title.id)
      }
    });
    const refreshed = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    res.json({
      title: refreshed?.title || titleState.title
    });
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
    const refreshed = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    res.json({
      title: refreshed?.title || title,
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
    const refreshed = await loadUserTitleState(req.user.discordUserId, req.params.titleId);
    res.json({
      title: refreshed?.title || title,
      chapterId: normalizeString(chapter.id)
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
    const storedPreferences = await readUserScopedSetting(vaultClient, "moon.reader.preferences", req.user.discordUserId, {});
    res.json(resolveReaderPreferences(storedPreferences, typeSlug));
  }));

  app.put("/api/moon-v3/user/reader/preferences", withUser(requireUser, async (req, res) => {
    const typeSlug = normalizeTypeSlug(req.body.typeSlug || req.body.type || "manga");
    const storedPreferences = await readUserScopedSetting(vaultClient, "moon.reader.preferences", req.user.discordUserId, {});
    const nextStore = mergeReaderPreferences(storedPreferences, typeSlug, req.body);
    await writeUserScopedSetting(vaultClient, "moon.reader.preferences", req.user.discordUserId, nextStore);
    res.json(resolveReaderPreferences(nextStore, typeSlug));
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
    const result = await serviceJson(config.ravenBaseUrl, `/v1/reader/${encodeURIComponent(req.params.titleId)}`);
    if (!result.ok) {
      res.status(result.status).json(result.payload);
      return;
    }

    const titleState = await loadUserTitleState(req.user.discordUserId, req.params.titleId, toTitleSummary(result.payload?.title));
    if (!titleState?.title) {
      res.status(404).json({error: "Title not found."});
      return;
    }

    res.json({
      title: titleState.title,
      chapters: normalizeArray(titleState.title.chapters)
    });
  }));

  app.get("/api/moon-v3/user/reader/title/:titleId/chapter/:chapterId", withUser(requireUser, async (req, res) => {
    const [manifest, chapter, progress, bookmarks, storedPreferences, titleState] = await Promise.all([
      serviceJson(config.ravenBaseUrl, `/v1/reader/${encodeURIComponent(req.params.titleId)}`),
      serviceJson(config.ravenBaseUrl, `/v1/reader/${encodeURIComponent(req.params.titleId)}/${encodeURIComponent(req.params.chapterId)}`),
      vaultClient.getProgress(req.user.discordUserId),
      readUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, []),
      readUserScopedSetting(vaultClient, "moon.reader.preferences", req.user.discordUserId, {}),
      loadUserTitleState(req.user.discordUserId, req.params.titleId)
    ]);

    if (!chapter.ok) {
      res.status(chapter.status).json(chapter.payload);
      return;
    }

    const payload = chapter.payload;
    const title = titleState?.title || toTitleSummary(payload.title);
    const chapterSummary = toChapterSummary(payload.chapter);
    const manifestPayload = manifest.ok
      ? {
        title,
        chapters: normalizeArray(title?.chapters).length ? normalizeArray(title.chapters) : normalizeArray(manifest.payload?.chapters).map(toChapterSummary)
      }
      : {
        title,
        chapters: normalizeArray(title?.chapters).length ? normalizeArray(title.chapters) : [chapterSummary]
      };
    const typeSlug = normalizeTypeSlug(title.libraryTypeSlug || title.mediaType);
    const progressEntry = normalizeArray(progress).find((entry) => entry.mediaId === payload.title.id);
    const pageBase = `/api/moon/v3/user/reader/title/${encodeURIComponent(req.params.titleId)}/chapter/${encodeURIComponent(req.params.chapterId)}/page`;
    const enrichedChapter = normalizeArray(title?.chapters).find((entry) => entry.id === req.params.chapterId) || chapterSummary;

    res.json({
      ...payload,
      title,
      chapter: enrichedChapter,
      manifest: manifestPayload,
      pages: normalizeArray(payload.pages).map((page) => ({
        ...page,
        src: `${pageBase}/${page.index}`
      })),
      progress: progressEntry || null,
      bookmarks: normalizeArray(bookmarks).filter((entry) => entry.titleId === req.params.titleId && entry.chapterId === req.params.chapterId),
      preferences: resolveReaderPreferences(storedPreferences, typeSlug)
    });
  }));

  app.get("/api/moon-v3/user/reader/title/:titleId/chapter/:chapterId/page/:pageIndex", withUser(requireUser, async (req, res) => {
    const response = await fetch(
      `${config.ravenBaseUrl}/v1/reader/${encodeURIComponent(req.params.titleId)}/${encodeURIComponent(req.params.chapterId)}/page/${encodeURIComponent(req.params.pageIndex)}`,
      {
        headers: {"Accept": "image/svg+xml"}
      }
    );

    const buffer = Buffer.from(await response.arrayBuffer());
    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    res.send(buffer);
  }));
};

export default registerMoonV3Routes;

