/**
 * @file Scriptarr Sage module: services/sage/lib/registerMoonV3Routes.mjs.
 */
import {hasPermission} from "./auth.mjs";

const defaultReaderPreferences = Object.freeze({
  readingMode: "paged",
  pageFit: "width",
  showSidebar: false,
  showPageNumbers: true
});

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];

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
  readingMode: normalizeTypeSlug(typeSlug) === "webtoon" ? "webtoon" : "paged"
});

const normalizeStoredReaderPreferenceLeaf = (value = {}) => ({
  ...(["paged", "webtoon"].includes(normalizeString(value.readingMode))
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
    readingMode: ["paged", "webtoon"].includes(normalizeString(value.readingMode))
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
  summary: normalizeString(title.summary),
  releaseLabel: normalizeString(title.releaseLabel),
  chapterCount: Number.parseInt(String(title.chapterCount || 0), 10) || 0,
  chaptersDownloaded: Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0,
  author: normalizeString(title.author),
  tags: normalizeArray(title.tags),
  aliases: normalizeArray(title.aliases),
  metadataProvider: normalizeString(title.metadataProvider),
  metadataMatchedAt: parseIso(title.metadataMatchedAt),
  relations: normalizeArray(title.relations),
  chapters: normalizeArray(title.chapters).map(toChapterSummary)
});

const toChapterSummary = (chapter = {}) => ({
  id: normalizeString(chapter.id),
  label: normalizeString(chapter.label, "Chapter"),
  chapterNumber: normalizeString(chapter.chapterNumber),
  pageCount: Number.parseInt(String(chapter.pageCount || 0), 10) || 0,
  releaseDate: normalizeString(chapter.releaseDate),
  available: chapter.available !== false
});

const toRequestSummary = (request = {}, userIndex = new Map()) => {
  const requester = userIndex.get(String(request.requestedBy || "").trim()) || null;
  const timeline = normalizeArray(request.timeline);

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
    timeline,
    requestedBy: {
      discordUserId: normalizeString(request.requestedBy),
      username: requester?.username || null,
      role: requester?.role || null
    }
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
    latestChapter: normalizeString(title.latestChapter, entry.chapterLabel || "In progress"),
    summary: normalizeString(title.summary)
  };
};

const readUserScopedSetting = async (vaultClient, prefix, discordUserId, fallback) => {
  const setting = await vaultClient.getSetting(`${prefix}.${discordUserId}`);
  return setting?.value ?? fallback;
};

const writeUserScopedSetting = async (vaultClient, prefix, discordUserId, value) =>
  vaultClient.setSetting(`${prefix}.${discordUserId}`, value);

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
 *   readRavenVpnSettings: () => Promise<Record<string, unknown>>,
 *   readMetadataProviderSettings: () => Promise<Record<string, unknown>>,
 *   readOracleSettings: () => Promise<Record<string, unknown>>,
 *   readMoonBrandingSettings: () => Promise<Record<string, unknown>>,
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
  readRavenVpnSettings,
  readMetadataProviderSettings,
  readOracleSettings,
  readMoonBrandingSettings,
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

  const loadRequests = async () => {
    const [userIndex, requests] = await Promise.all([
      loadUserIndex(),
      vaultClient.listRequests()
    ]);

    return normalizeArray(requests).map((request) => toRequestSummary(request, userIndex));
  };

  const loadTasks = async () => {
    const ravenPayload = await fetchRavenJson("/v1/downloads/tasks");
    const ravenTasks = normalizeArray(ravenPayload).map((task) => ({
      taskId: normalizeString(task.taskId),
      titleName: normalizeString(task.titleName),
      titleUrl: normalizeString(task.titleUrl),
      requestType: normalizeString(task.requestType, "manga"),
      requestedBy: normalizeString(task.requestedBy),
      status: normalizeString(task.status, "queued"),
      message: normalizeString(task.message),
      percent: Number.parseInt(String(task.percent || 0), 10) || 0,
      queuedAt: parseIso(task.queuedAt),
      updatedAt: parseIso(task.updatedAt)
    }));
    const jobs = normalizeArray(await vaultClient.listJobs()).filter((job) =>
      ["scriptarr-warden", "scriptarr-raven"].includes(normalizeString(job.ownerService))
    );
    const brokerTasksNested = await Promise.all(jobs.map(async (job) =>
      normalizeArray(await vaultClient.listJobTasks(job.jobId)).map((task) => ({
        taskId: normalizeString(task.taskId),
        jobId: normalizeString(job.jobId),
        titleName: normalizeString(task.label || job.label || job.kind, "Background job"),
        titleUrl: "",
        requestType: normalizeString(job.kind, "job"),
        requestedBy: normalizeString(job.ownerService || task.requestedBy || "scriptarr"),
        status: normalizeString(task.status || job.status, "queued"),
        message: normalizeString(task.message || job.label || "Background task updated."),
        percent: Number.parseInt(String(task.percent || 0), 10) || 0,
        queuedAt: parseIso(task.createdAt || job.createdAt),
        updatedAt: parseIso(task.updatedAt || job.updatedAt)
      }))
    ));
    const brokerTasks = brokerTasksNested.flat();

    return [...ravenTasks, ...brokerTasks].sort((left, right) =>
      Date.parse(right.updatedAt || right.queuedAt || "") - Date.parse(left.updatedAt || left.queuedAt || "")
    );
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

  const requireAdminSettings = (handler) => withPermission(requirePermission, "manage_settings", handler);
  const requireLibraryRead = (handler) => withPermission(requirePermission, "read_library", handler);
  const requireRequestRead = (handler) => withPermission(requirePermission, "read_requests", handler);

  app.get("/api/moon-v3/public/branding", async (_req, res) => {
    res.json(await readMoonBrandingSettings());
  });

  app.get("/api/moon-v3/admin/overview", requireLibraryRead(async (_req, res) => {
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

  app.get("/api/moon-v3/admin/add/search", requireLibraryRead(async (req, res) => {
    const query = normalizeString(req.query.query);
    if (!query) {
      res.json({query: "", results: []});
      return;
    }

    const results = await fetchRavenJson(`/v1/downloads/search?query=${encodeURIComponent(query)}`);
    res.json({query, results: normalizeArray(results)});
  }));

  app.post("/api/moon-v3/admin/add/queue", requireLibraryRead(async (req, res) => {
    const result = await serviceJson(config.ravenBaseUrl, "/v1/downloads/queue", {
      method: "POST",
      body: {
        ...req.body,
        requestedBy: req.user.discordUserId
      }
    });
    res.status(result.status).json(result.payload);
  }));

  app.get("/api/moon-v3/admin/import", requireLibraryRead(async (_req, res) => {
    res.json({
      imports: [],
      summary: {
        detected: 0,
        note: "Import scanning is not wired into the Scriptarr scaffold yet."
      }
    });
  }));

  app.get("/api/moon-v3/admin/calendar", requireLibraryRead(async (_req, res) => {
    const titles = await loadLibrary();
    const entries = titles.flatMap((title) =>
      normalizeArray(title.chapters).map((chapter) => ({
        titleId: title.id,
        title: title.title,
        chapterId: chapter.id,
        chapterLabel: chapter.label,
        releaseDate: chapter.releaseDate,
        available: chapter.available,
        mediaType: title.mediaType
      }))
    ).sort((left, right) => Date.parse(right.releaseDate || "") - Date.parse(left.releaseDate || ""));

    res.json({entries});
  }));

  app.get("/api/moon-v3/admin/activity/queue", requireLibraryRead(async (_req, res) => {
    const tasks = await loadTasks();
    res.json({tasks: tasks.filter((entry) => entry.status === "queued" || entry.status === "running")});
  }));

  app.get("/api/moon-v3/admin/activity/history", requireLibraryRead(async (_req, res) => {
    const tasks = await loadTasks();
    res.json({tasks: tasks.filter((entry) => entry.status === "completed" || entry.status === "failed")});
  }));

  app.get("/api/moon-v3/admin/activity/blocklist", requireRequestRead(async (_req, res) => {
    const requests = await loadRequests();
    res.json({
      entries: requests.filter((entry) => entry.status === "denied" || entry.status === "blocked")
    });
  }));

  app.get("/api/moon-v3/admin/wanted/missing-chapters", requireLibraryRead(async (_req, res) => {
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

  app.get("/api/moon-v3/admin/wanted/metadata-gaps", requireLibraryRead(async (_req, res) => {
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

  app.get("/api/moon-v3/admin/users", requireAdminSettings(async (_req, res) => {
    const users = normalizeArray(await vaultClient.listUsers());
    res.json({users});
  }));

  app.get("/api/moon-v3/admin/settings", requireAdminSettings(async (_req, res) => {
    const [ravenVpn, metadataProviders, oracle, branding, wardenStatus] = await Promise.all([
      readRavenVpnSettings(),
      readMetadataProviderSettings(),
      readOracleSettings(),
      readMoonBrandingSettings(),
      safeJson(serviceJson(config.wardenBaseUrl, "/api/localai/status"))
    ]);

    res.json({
      ravenVpn,
      metadataProviders,
      oracle,
      branding,
      warden: wardenStatus.payload || wardenStatus
    });
  }));

  app.get("/api/moon-v3/admin/system/status", requireAdminSettings(async (_req, res) => {
    const [services, bootstrap, runtime] = await Promise.all([
      loadServiceStatus(),
      safeJson(serviceJson(config.wardenBaseUrl, "/api/bootstrap")),
      safeJson(serviceJson(config.wardenBaseUrl, "/api/runtime"))
    ]);

    res.json({
      services,
      bootstrap: bootstrap.payload || bootstrap,
      runtime: runtime.payload || runtime
    });
  }));

  app.get("/api/moon-v3/admin/system/tasks", requireAdminSettings(async (_req, res) => {
    const [tasks, requests] = await Promise.all([loadTasks(), loadRequests()]);
    res.json({
      tasks,
      pendingRequests: requests.filter((entry) => entry.status === "pending")
    });
  }));

  app.get("/api/moon-v3/admin/system/updates", requireAdminSettings(async (_req, res) => {
    const updates = await serviceJson(config.wardenBaseUrl, "/api/updates");
    res.status(updates.status).json(updates.payload);
  }));

  app.post("/api/moon-v3/admin/system/updates/check", requireAdminSettings(async (req, res) => {
    const updates = await serviceJson(config.wardenBaseUrl, "/api/updates/check", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    });
    res.status(updates.status).json(updates.payload);
  }));

  app.post("/api/moon-v3/admin/system/updates/install", requireAdminSettings(async (req, res) => {
    const updates = await serviceJson(config.wardenBaseUrl, "/api/updates/install", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    });
    res.status(updates.status).json(updates.payload);
  }));

  app.get("/api/moon-v3/admin/system/events", requireAdminSettings(async (_req, res) => {
    const [requests, tasks] = await Promise.all([loadRequests(), loadTasks()]);
    res.json({events: buildEventRows(requests, tasks)});
  }));

  app.get("/api/moon-v3/admin/system/logs", requireAdminSettings(async (_req, res) => {
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
    const [titles, requests, progress, following] = await Promise.all([
      loadLibrary(),
      loadRequests(),
      vaultClient.getProgress(req.user.discordUserId),
      readUserScopedSetting(vaultClient, "moon.following", req.user.discordUserId, [])
    ]);
    const titleIndex = new Map(titles.map((title) => [title.id, title]));

    res.json({
      latestTitles: titles.slice(0, 8),
      continueReading: normalizeArray(progress).map((entry) => enrichProgressEntry(entry, titleIndex)),
      requests: requests.filter((entry) => entry.requestedBy.discordUserId === req.user.discordUserId),
      following: normalizeArray(following).map((entry) => ({
        ...entry,
        libraryTypeLabel: normalizeString(entry.libraryTypeLabel, normalizeString(entry.mediaType, "Manga")),
        libraryTypeSlug: normalizeTypeSlug(entry.libraryTypeSlug || entry.mediaType)
      }))
    });
  }));

  app.get("/api/moon-v3/user/library", withUser(requireUser, async (_req, res) => {
    res.json({titles: await loadLibrary()});
  }));

  app.get("/api/moon-v3/user/title/:titleId", withUser(requireUser, async (req, res) => {
    const result = await serviceJson(config.ravenBaseUrl, `/v1/library/${encodeURIComponent(req.params.titleId)}`);
    if (!result.ok) {
      res.status(result.status).json(result.payload);
      return;
    }

    const [following, requests] = await Promise.all([
      readUserScopedSetting(vaultClient, "moon.following", req.user.discordUserId, []),
      loadRequests()
    ]);

    const title = toTitleSummary(result.payload);
    res.json({
      title,
      following: normalizeArray(following).some((entry) => entry.titleId === title.id),
      requests: requests.filter((entry) => entry.requestedBy.discordUserId === req.user.discordUserId && entry.title === title.title)
    });
  }));

  app.get("/api/moon-v3/user/requests", withUser(requireUser, async (req, res) => {
    const requests = await loadRequests();
    res.json({
      requests: requests.filter((entry) => entry.requestedBy.discordUserId === req.user.discordUserId)
    });
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

    const request = await vaultClient.createRequest({
      source: "moon",
      title: req.body.title,
      requestType: req.body.requestType || "manga",
      notes: req.body.notes || "",
      requestedBy: req.user.discordUserId
    });
    res.status(201).json(request);
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
    res.status(201).json({following: deduped});
  }));

  app.delete("/api/moon-v3/user/following/:titleId", withUser(requireUser, async (req, res) => {
    const current = normalizeArray(await readUserScopedSetting(vaultClient, "moon.following", req.user.discordUserId, []));
    const next = current.filter((entry) => entry.titleId !== req.params.titleId);
    await writeUserScopedSetting(vaultClient, "moon.following", req.user.discordUserId, next);
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
    res.status(201).json(nextEntry);
  }));

  app.delete("/api/moon-v3/user/reader/bookmarks/:bookmarkId", withUser(requireUser, async (req, res) => {
    const bookmarks = normalizeArray(await readUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, []));
    const next = bookmarks.filter((entry) => entry.id !== req.params.bookmarkId);
    await writeUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, next);
    res.status(204).end();
  }));

  app.get("/api/moon-v3/user/reader/progress", withUser(requireUser, async (req, res) => {
    res.json({progress: normalizeArray(await vaultClient.getProgress(req.user.discordUserId))});
  }));

  app.put("/api/moon-v3/user/reader/progress", withUser(requireUser, async (req, res) => {
    const payload = await vaultClient.upsertProgress({
      mediaId: req.body.mediaId,
      discordUserId: req.user.discordUserId,
      chapterLabel: req.body.chapterLabel,
      positionRatio: req.body.positionRatio,
      bookmark: req.body.bookmark || null
    });
    res.json(payload);
  }));

  app.get("/api/moon-v3/user/reader/title/:titleId", withUser(requireUser, async (req, res) => {
    const result = await serviceJson(config.ravenBaseUrl, `/v1/reader/${encodeURIComponent(req.params.titleId)}`);
    if (!result.ok) {
      res.status(result.status).json(result.payload);
      return;
    }

    res.json({
      title: toTitleSummary(result.payload?.title),
      chapters: normalizeArray(result.payload?.chapters).map(toChapterSummary)
    });
  }));

  app.get("/api/moon-v3/user/reader/title/:titleId/chapter/:chapterId", withUser(requireUser, async (req, res) => {
    const [manifest, chapter, progress, bookmarks, storedPreferences] = await Promise.all([
      serviceJson(config.ravenBaseUrl, `/v1/reader/${encodeURIComponent(req.params.titleId)}`),
      serviceJson(config.ravenBaseUrl, `/v1/reader/${encodeURIComponent(req.params.titleId)}/${encodeURIComponent(req.params.chapterId)}`),
      vaultClient.getProgress(req.user.discordUserId),
      readUserScopedSetting(vaultClient, "moon.reader.bookmarks", req.user.discordUserId, []),
      readUserScopedSetting(vaultClient, "moon.reader.preferences", req.user.discordUserId, {})
    ]);

    if (!chapter.ok) {
      res.status(chapter.status).json(chapter.payload);
      return;
    }

    const payload = chapter.payload;
    const title = toTitleSummary(payload.title);
    const chapterSummary = toChapterSummary(payload.chapter);
    const manifestPayload = manifest.ok
      ? {
        title: toTitleSummary(manifest.payload?.title || payload.title),
        chapters: normalizeArray(manifest.payload?.chapters).map(toChapterSummary)
      }
      : {
        title,
        chapters: [chapterSummary]
      };
    const typeSlug = normalizeTypeSlug(title.libraryTypeSlug || title.mediaType);
    const progressEntry = normalizeArray(progress).find((entry) => entry.mediaId === payload.title.id);
    const pageBase = `/api/moon/v3/user/reader/title/${encodeURIComponent(req.params.titleId)}/chapter/${encodeURIComponent(req.params.chapterId)}/page`;

    res.json({
      ...payload,
      title,
      chapter: chapterSummary,
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

