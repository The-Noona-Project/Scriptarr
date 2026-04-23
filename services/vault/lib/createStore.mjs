import {createHash, randomUUID} from "node:crypto";

import mysql from "mysql2/promise";
import {createCachedStore} from "./createCachedStore.mjs";

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
const sortRavenChapters = (chapters) => [...chapters].sort((left, right) => {
  const leftNumber = Number.parseFloat(String(left.chapterNumber || "0"));
  const rightNumber = Number.parseFloat(String(right.chapterNumber || "0"));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }
  return String(right.chapterNumber || right.label || "").localeCompare(String(left.chapterNumber || left.label || ""));
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
  metadataMatchedAt: title.metadataMatchedAt || null,
  relations: Array.isArray(title.relations) ? title.relations : [],
  sourceUrl: title.sourceUrl || "",
  coverUrl: title.coverUrl || "",
  workingRoot: title.workingRoot || "",
  downloadRoot: title.downloadRoot || "",
  chapters: sortRavenChapters(chapters)
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

const defaultPermissionsForRole = (role) => {
  switch (role) {
    case "owner":
    case "admin":
      return ["admin", "manage_users", "manage_settings", "moderate_requests", "read_requests", "read_library", "read_ai_status"];
    case "moderator":
      return ["moderate_requests", "read_requests", "read_library", "read_ai_status"];
    default:
      return ["read_library", "create_requests", "read_requests", "read_ai_status"];
  }
};

const createConflictError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const createMemoryStore = () => {
  const state = {
    users: new Map(),
    sessions: new Map(),
    settings: new Map(),
    secrets: new Map(),
    requests: new Map(),
    requestWorkLocks: new Map(),
    progress: new Map(),
    ravenTitles: new Map(),
    ravenChapters: new Map(),
    ravenDownloadTasks: new Map(),
    ravenMetadataMatches: new Map(),
    jobs: new Map(),
    jobTasks: new Map(),
    requestSeq: 1
  };

  return {
    driver: "memory",
    async init() {
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
        permissions: permissions?.length ? permissions : defaultPermissionsForRole(nextRole),
        createdAt: existing?.createdAt || nowIso(),
        updatedAt: nowIso()
      };
      state.users.set(discordUserId, next);
      return next;
    },
    async getUserByDiscordId(discordUserId) {
      return state.users.get(discordUserId) || null;
    },
    async listUsers() {
      return Array.from(state.users.values()).sort((left, right) => left.username.localeCompare(right.username));
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
    async setSecret(key, value) {
      state.secrets.set(key, {key, value, updatedAt: nowIso()});
      return state.secrets.get(key);
    },
    async getSecret(key) {
      return state.secrets.get(key) || null;
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
      state.progress.set(entry.mediaId, {
        ...entry,
        updatedAt: nowIso()
      });
      return state.progress.get(entry.mediaId);
    },
    async getProgressByUser(discordUserId) {
      return Array.from(state.progress.values()).filter((entry) => entry.discordUserId === discordUserId);
    },
    async listRavenTitles() {
      return sortRavenTitles(Array.from(state.ravenTitles.values()).map((title) =>
        normalizeRavenTitle(title, Array.from((state.ravenChapters.get(title.id) || new Map()).values()))
      ));
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
        ...chapter,
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
    await ignoreKnownAlterError("ALTER TABLE requests ADD COLUMN request_details_json JSON NULL AFTER moderator_comment");
    await ignoreKnownAlterError("ALTER TABLE requests ADD COLUMN request_work_key TEXT NULL AFTER request_details_json");
    await ignoreKnownAlterError("ALTER TABLE requests ADD COLUMN request_work_key_hash CHAR(64) NULL AFTER request_work_key");
    await ignoreKnownAlterError("ALTER TABLE requests ADD COLUMN revision_number INT NOT NULL DEFAULT 1");
    await ignoreKnownAlterError("ALTER TABLE requests ADD INDEX idx_requests_work_key_hash (request_work_key_hash)");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN library_type_label VARCHAR(255) NULL");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN library_type_slug VARCHAR(191) NULL");
    await ignoreKnownAlterError("ALTER TABLE raven_titles ADD COLUMN working_root TEXT NULL");
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
  };

  const toUser = (row) => ({
    id: row.discord_user_id,
    discordUserId: row.discord_user_id,
    username: row.username,
    avatarUrl: row.avatar_url,
    role: row.role_name,
    permissions: parseJsonColumn(row.permissions_json, []),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  });
  const toRavenChapter = (row) => ({
    id: row.chapter_id,
    label: row.label_name,
    chapterNumber: row.chapter_number,
    pageCount: row.page_count,
    releaseDate: row.release_date,
    available: row.is_available === 1,
    archivePath: row.archive_path,
    sourceUrl: row.source_url,
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
    downloadRoot: row.download_root
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
        const nextPermissions = permissions?.length ? permissions : defaultPermissionsForRole(nextRole);
        await connection.query(`
          INSERT INTO users (discord_user_id, username, avatar_url, role_name, permissions_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE username = VALUES(username), avatar_url = VALUES(avatar_url), role_name = VALUES(role_name),
          permissions_json = VALUES(permissions_json), updated_at = NOW()
        `, [discordUserId, username, avatarUrl || null, nextRole, JSON.stringify(nextPermissions)]);
      });
      return this.getUserByDiscordId(discordUserId);
    },
    async getUserByDiscordId(discordUserId) {
      const [rows] = await pool.query("SELECT * FROM users WHERE discord_user_id = ? LIMIT 1", [discordUserId]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    async listUsers() {
      const [rows] = await pool.query("SELECT * FROM users ORDER BY username ASC");
      return rows.map(toUser);
    },
    async createSession({discordUserId}) {
      const token = randomToken("sess");
      await pool.query("INSERT INTO sessions (token, discord_user_id, created_at) VALUES (?, ?, NOW())", [token, discordUserId]);
      return {token, discordUserId};
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
          metadata_provider, metadata_matched_at, source_url, cover_url, working_root, download_root, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
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
        title.metadataMatchedAt || null,
        title.sourceUrl || null,
        title.coverUrl || null,
        title.workingRoot || null,
        title.downloadRoot || null
      ]);
      return this.getRavenTitle(title.id);
    },
    async replaceRavenChapters(titleId, chapters) {
      return withTransaction(async (connection) => {
        await connection.query("DELETE FROM raven_chapters WHERE title_id = ?", [titleId]);
        for (const chapter of sortRavenChapters(Array.isArray(chapters) ? chapters : [])) {
          await connection.query(`
            INSERT INTO raven_chapters (
              title_id, chapter_id, label_name, chapter_number, page_count, release_date, is_available, archive_path, source_url, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          `, [
            titleId,
            chapter.id,
            chapter.label || chapter.id,
            chapter.chapterNumber || null,
            Number.parseInt(String(chapter.pageCount || 0), 10) || 0,
            chapter.releaseDate || null,
            chapter.available === false ? 0 : 1,
            chapter.archivePath || null,
            chapter.sourceUrl || null
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
