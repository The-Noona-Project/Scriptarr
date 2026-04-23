const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cloneValue = (value) => {
  if (value == null) {
    return value;
  }

  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
};

const stableStringify = (value) => {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
};

const makeListKey = (prefix, filters = {}) => `${prefix}:${stableStringify(filters)}`;

/**
 * Wrap a Vault store with an in-memory TTL cache. Reads are cache-first and
 * writes remain authoritative in the underlying store while refreshing or
 * invalidating the affected cache entries.
 *
 * @param {Record<string, any>} baseStore
 * @param {{ttlMs?: number, now?: () => number}} [options]
 * @returns {Record<string, any>}
 */
export const createCachedStore = (
  baseStore,
  {
    ttlMs = DEFAULT_CACHE_TTL_MS,
    now = () => Date.now()
  } = {}
) => {
  const cache = new Map();

  const readEntry = (key) => {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }

    return cloneValue(entry.value);
  };

  const writeEntry = (key, value) => {
    cache.set(key, {
      value: cloneValue(value),
      expiresAt: now() + ttlMs
    });
    return value;
  };

  const invalidate = (...keys) => {
    for (const key of keys) {
      cache.delete(key);
    }
  };

  const invalidatePrefix = (...prefixes) => {
    for (const key of Array.from(cache.keys())) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        cache.delete(key);
      }
    }
  };

  const readThrough = async (key, loader) => {
    const cached = readEntry(key);
    if (cached !== undefined) {
      return cached;
    }

    return writeEntry(key, await loader());
  };

  const cachedStore = {
    ...baseStore,
    cacheTtlMs: ttlMs,
    cacheSize: () => cache.size,
    clearCache: () => cache.clear(),
    async getBootstrapStatus(superuserId) {
      return readThrough(`bootstrap:${superuserId}`, () => baseStore.getBootstrapStatus(superuserId));
    },
    async upsertDiscordUser(payload) {
      const user = await baseStore.upsertDiscordUser(payload);
      writeEntry(`user:${user.discordUserId}`, user);
      invalidate("users:list");
      invalidatePrefix("bootstrap:", "session-user:");
      return user;
    },
    async getUserByDiscordId(discordUserId) {
      return readThrough(`user:${discordUserId}`, () => baseStore.getUserByDiscordId(discordUserId));
    },
    async listUsers() {
      return readThrough("users:list", () => baseStore.listUsers());
    },
    async listPermissionGroups() {
      return readThrough("permission-groups:list", () => baseStore.listPermissionGroups());
    },
    async getPermissionGroup(groupId) {
      return readThrough(`permission-group:${groupId}`, () => baseStore.getPermissionGroup(groupId));
    },
    async createPermissionGroup(payload) {
      const group = await baseStore.createPermissionGroup(payload);
      invalidate("permission-groups:list");
      writeEntry(`permission-group:${group.id}`, group);
      invalidate("users:list");
      invalidatePrefix("user:", "session-user:");
      return group;
    },
    async updatePermissionGroup(groupId, payload) {
      const group = await baseStore.updatePermissionGroup(groupId, payload);
      invalidate("permission-groups:list", `permission-group:${groupId}`, "users:list");
      invalidatePrefix("user:", "session-user:");
      if (group) {
        writeEntry(`permission-group:${group.id}`, group);
      }
      return group;
    },
    async deletePermissionGroup(groupId) {
      const group = await baseStore.deletePermissionGroup(groupId);
      invalidate("permission-groups:list", `permission-group:${groupId}`, "users:list");
      invalidatePrefix("user:", "session-user:");
      return group;
    },
    async assignUserGroups(discordUserId, groupIds) {
      const user = await baseStore.assignUserGroups(discordUserId, groupIds);
      invalidate("users:list", `user:${discordUserId}`);
      invalidatePrefix("session-user:");
      return user;
    },
    async deleteUser(discordUserId) {
      const user = await baseStore.deleteUser(discordUserId);
      invalidate("users:list", `user:${discordUserId}`);
      invalidatePrefix("session:", "session-user:");
      return user;
    },
    async getAccessOverview() {
      return readThrough("access:overview", () => baseStore.getAccessOverview());
    },
    async createSession(payload) {
      const session = await baseStore.createSession(payload);
      writeEntry(`session:${session.token}`, session);
      invalidate(`session-user:${session.token}`);
      return session;
    },
    async clearSession(token) {
      const session = await baseStore.clearSession(token);
      invalidate(`session:${token}`, `session-user:${token}`);
      return session;
    },
    async clearSessionsForUser(discordUserId) {
      const result = await baseStore.clearSessionsForUser(discordUserId);
      invalidatePrefix("session:", "session-user:");
      return result;
    },
    async getSession(token) {
      return readThrough(`session:${token}`, () => baseStore.getSession(token));
    },
    async getUserForSession(token) {
      return readThrough(`session-user:${token}`, async () => {
        const session = await cachedStore.getSession(token);
        if (!session) {
          return null;
        }
        return cachedStore.getUserByDiscordId(session.discordUserId);
      });
    },
    async setSetting(key, value) {
      const setting = await baseStore.setSetting(key, value);
      writeEntry(`setting:${key}`, setting);
      return setting;
    },
    async getSetting(key) {
      return readThrough(`setting:${key}`, () => baseStore.getSetting(key));
    },
    async setSecret(key, value) {
      const secret = await baseStore.setSecret(key, value);
      writeEntry(`secret:${key}`, secret);
      return secret;
    },
    async getSecret(key) {
      return readThrough(`secret:${key}`, () => baseStore.getSecret(key));
    },
    async appendEvent(payload) {
      const event = await baseStore.appendEvent(payload);
      invalidatePrefix("events:");
      invalidate("access:overview");
      return event;
    },
    async listEvents(filters = {}) {
      return readThrough(makeListKey("events", filters), () => baseStore.listEvents(filters));
    },
    async pruneEvents(retentionDays) {
      const result = await baseStore.pruneEvents(retentionDays);
      invalidatePrefix("events:");
      return result;
    },
    async listRequests() {
      return readThrough("requests:list", () => baseStore.listRequests());
    },
    async getRequest(id) {
      return readThrough(`request:${id}`, () => baseStore.getRequest(id));
    },
    async createRequest(payload) {
      const request = await baseStore.createRequest(payload);
      invalidate("requests:list");
      writeEntry(`request:${request.id}`, request);
      return request;
    },
    async updateRequest(id, payload) {
      const request = await baseStore.updateRequest(id, payload);
      invalidate("requests:list");
      if (request) {
        writeEntry(`request:${request.id}`, request);
      } else {
        invalidate(`request:${id}`);
      }
      return request;
    },
    async reviewRequest(id, payload) {
      const request = await baseStore.reviewRequest(id, payload);
      invalidate("requests:list");
      if (request) {
        writeEntry(`request:${request.id}`, request);
      } else {
        invalidate(`request:${id}`);
      }
      return request;
    },
    async upsertProgress(payload) {
      const progress = await baseStore.upsertProgress(payload);
      invalidate(`progress:${payload.discordUserId}`);
      return progress;
    },
    async getProgressByUser(discordUserId) {
      return readThrough(`progress:${discordUserId}`, () => baseStore.getProgressByUser(discordUserId));
    },
    async listRavenTitles() {
      return readThrough("raven-titles:list", () => baseStore.listRavenTitles());
    },
    async getRavenTitle(titleId) {
      return readThrough(`raven-title:${titleId}`, () => baseStore.getRavenTitle(titleId));
    },
    async upsertRavenTitle(payload) {
      const title = await baseStore.upsertRavenTitle(payload);
      writeEntry(`raven-title:${title.id}`, title);
      invalidate("raven-titles:list");
      return title;
    },
    async replaceRavenChapters(titleId, chapters) {
      const replaced = await baseStore.replaceRavenChapters(titleId, chapters);
      invalidate("raven-titles:list", `raven-title:${titleId}`);
      return replaced;
    },
    async listRavenDownloadTasks() {
      return readThrough("raven-download-tasks:list", () => baseStore.listRavenDownloadTasks());
    },
    async upsertRavenDownloadTask(payload) {
      const task = await baseStore.upsertRavenDownloadTask(payload);
      invalidate("raven-download-tasks:list");
      return task;
    },
    async getRavenMetadataMatch(titleId) {
      return readThrough(`raven-metadata:${titleId}`, () => baseStore.getRavenMetadataMatch(titleId));
    },
    async setRavenMetadataMatch(titleId, value) {
      const entry = await baseStore.setRavenMetadataMatch(titleId, value);
      writeEntry(`raven-metadata:${titleId}`, entry);
      return entry;
    },
    async listJobs(filters = {}) {
      return readThrough(makeListKey("jobs", filters), () => baseStore.listJobs(filters));
    },
    async getJob(jobId) {
      return readThrough(`job:${jobId}`, () => baseStore.getJob(jobId));
    },
    async upsertJob(payload) {
      const job = await baseStore.upsertJob(payload);
      writeEntry(`job:${job.jobId}`, job);
      invalidatePrefix("jobs:");
      return job;
    },
    async listJobTasks(filters = {}) {
      return readThrough(makeListKey("job-tasks", filters), () => baseStore.listJobTasks(filters));
    },
    async upsertJobTask(jobId, payload) {
      const task = await baseStore.upsertJobTask(jobId, payload);
      invalidatePrefix("job-tasks:");
      writeEntry(`job-task:${task.taskId}`, task);
      invalidate(`job:${jobId}`);
      return task;
    }
  };

  return cachedStore;
};

export default createCachedStore;
