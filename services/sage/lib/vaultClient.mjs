/**
 * @file Scriptarr Sage module: services/sage/lib/vaultClient.mjs.
 */
const withBearer = (token) => ({
  "Authorization": `Bearer ${token}`,
  "Content-Type": "application/json"
});

const json = async (response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {raw: text};
  }
};

const buildHttpError = (status, payload, context) => {
  const detail = payload?.error || payload?.raw || `HTTP ${status}`;
  const error = new Error(`${context}: ${detail}`);
  error.status = status;
  error.payload = payload;
  return error;
};

const requestJson = async (baseUrl, headers, path, {method = "GET", body, allowStatuses = [], context = "Vault request failed"} = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
  const payload = await json(response);
  if (!response.ok && !allowStatuses.includes(response.status)) {
    throw buildHttpError(response.status, payload, context);
  }
  return {
    status: response.status,
    payload
  };
};

/**
 * Build Sage's Vault client facade for settings, sessions, requests, and user
 * mutations.
 *
 * @param {{vaultBaseUrl: string, serviceToken: string}} config
 * @returns {{
 *   getBootstrapStatus: () => Promise<any>,
 *   upsertDiscordUser: (payload: Record<string, unknown>) => Promise<any>,
 *   getUserByDiscordId: (discordUserId: string) => Promise<any>,
 *   listUsers: () => Promise<any>,
 *   getAccessOverview: () => Promise<any>,
 *   listPermissionGroups: () => Promise<any>,
 *   createPermissionGroup: (payload: Record<string, unknown>) => Promise<any>,
 *   updatePermissionGroup: (groupId: string, payload: Record<string, unknown>) => Promise<any>,
 *   deletePermissionGroup: (groupId: string) => Promise<any>,
 *   assignUserGroups: (discordUserId: string, groupIds: string[]) => Promise<any>,
 *   deleteUser: (discordUserId: string) => Promise<any>,
 *   createSession: (discordUserId: string) => Promise<any>,
 *   clearSession: (token: string) => Promise<any>,
 *   clearSessionsForUser: (discordUserId: string) => Promise<any>,
 *   getSessionUser: (token: string) => Promise<any>,
 *   listEvents: (filters?: Record<string, unknown>) => Promise<any>,
 *   appendEvent: (payload: Record<string, unknown>) => Promise<any>,
 *   pruneEvents: (retentionDays?: number) => Promise<any>,
 *   listRequests: () => Promise<any>,
 *   getRequest: (id: string | number) => Promise<any>,
 *   getSetting: (key: string) => Promise<any>,
 *   setSetting: (key: string, value: unknown) => Promise<any>,
 *   getSecret: (key: string) => Promise<any>,
 *   setSecret: (key: string, value: unknown) => Promise<any>,
 *   createRequest: (payload: Record<string, unknown>) => Promise<any>,
 *   updateRequest: (id: string | number, payload: Record<string, unknown>) => Promise<any>,
 *   reviewRequest: (id: string | number, payload: Record<string, unknown>) => Promise<any>,
 *   getProgress: (discordUserId: string) => Promise<any>,
 *   upsertProgress: (payload: Record<string, unknown>) => Promise<any>
 * }}
 */
export const createVaultClient = (config) => {
  const baseUrl = config.vaultBaseUrl;
  const headers = withBearer(config.serviceToken);

  return {
    async getBootstrapStatus() {
      const response = await fetch(`${baseUrl}/api/public/bootstrap-status`);
      return json(response);
    },
    async upsertDiscordUser(payload) {
      const response = await fetch(`${baseUrl}/api/service/users/upsert-discord`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      return json(response);
    },
    async getUserByDiscordId(discordUserId) {
      const response = await fetch(`${baseUrl}/api/service/users/by-discord/${encodeURIComponent(discordUserId)}`, {
        headers
      });
      return response.status === 404 ? null : json(response);
    },
    async listUsers() {
      const response = await fetch(`${baseUrl}/api/service/users`, {
        headers
      });
      return json(response);
    },
    async getAccessOverview() {
      return (await requestJson(baseUrl, headers, "/api/service/access", {
        context: "Failed to load access overview from Vault"
      })).payload;
    },
    async listPermissionGroups() {
      return (await requestJson(baseUrl, headers, "/api/service/permission-groups", {
        context: "Failed to list permission groups from Vault"
      })).payload;
    },
    async createPermissionGroup(payload) {
      return (await requestJson(baseUrl, headers, "/api/service/permission-groups", {
        method: "POST",
        body: payload,
        context: "Failed to create a permission group in Vault"
      })).payload;
    },
    async updatePermissionGroup(groupId, payload) {
      const {status, payload: responsePayload} = await requestJson(baseUrl, headers, `/api/service/permission-groups/${encodeURIComponent(groupId)}`, {
        method: "PATCH",
        body: payload,
        allowStatuses: [404],
        context: "Failed to update a permission group in Vault"
      });
      return status === 404 ? null : responsePayload;
    },
    async deletePermissionGroup(groupId) {
      const {status, payload} = await requestJson(baseUrl, headers, `/api/service/permission-groups/${encodeURIComponent(groupId)}`, {
        method: "DELETE",
        allowStatuses: [404],
        context: "Failed to delete a permission group in Vault"
      });
      return status === 404 ? null : payload;
    },
    async assignUserGroups(discordUserId, groupIds) {
      const {status, payload} = await requestJson(baseUrl, headers, `/api/service/users/${encodeURIComponent(discordUserId)}/groups`, {
        method: "PUT",
        body: {groupIds},
        allowStatuses: [404],
        context: "Failed to assign permission groups in Vault"
      });
      return status === 404 ? null : payload;
    },
    async deleteUser(discordUserId) {
      const {status, payload} = await requestJson(baseUrl, headers, `/api/service/users/${encodeURIComponent(discordUserId)}`, {
        method: "DELETE",
        allowStatuses: [404],
        context: "Failed to delete a user in Vault"
      });
      return status === 404 ? null : payload;
    },
    async createSession(discordUserId) {
      const response = await fetch(`${baseUrl}/api/service/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({discordUserId})
      });
      return json(response);
    },
    async clearSession(token) {
      const {status, payload} = await requestJson(baseUrl, headers, `/api/service/sessions/${encodeURIComponent(token)}`, {
        method: "DELETE",
        allowStatuses: [404],
        context: "Failed to clear a session in Vault"
      });
      return status === 404 ? null : payload;
    },
    async clearSessionsForUser(discordUserId) {
      return (await requestJson(baseUrl, headers, `/api/service/sessions/user/${encodeURIComponent(discordUserId)}`, {
        method: "DELETE",
        context: "Failed to clear user sessions in Vault"
      })).payload;
    },
    async getSessionUser(token) {
      const response = await fetch(`${baseUrl}/api/service/sessions/${encodeURIComponent(token)}`, {
        headers
      });
      return response.status === 404 ? null : json(response);
    },
    async listEvents(filters = {}) {
      const searchParams = new URLSearchParams();
      const domains = Array.isArray(filters.domains) ? filters.domains : [];
      for (const domain of domains) {
        searchParams.append("domain", String(domain));
      }
      for (const [key, value] of Object.entries(filters)) {
        if (key === "domains") {
          continue;
        }
        if (value != null && value !== "") {
          searchParams.set(key, String(value));
        }
      }
      const suffix = searchParams.size ? `?${searchParams.toString()}` : "";
      return (await requestJson(baseUrl, headers, `/api/service/events${suffix}`, {
        context: "Failed to list durable events from Vault"
      })).payload;
    },
    async appendEvent(payload) {
      return (await requestJson(baseUrl, headers, "/api/service/events", {
        method: "POST",
        body: payload,
        context: "Failed to append a durable event in Vault"
      })).payload;
    },
    async pruneEvents(retentionDays) {
      const suffix = retentionDays == null ? "" : `?retentionDays=${encodeURIComponent(retentionDays)}`;
      return (await requestJson(baseUrl, headers, `/api/service/events/prune${suffix}`, {
        method: "DELETE",
        context: "Failed to prune durable events in Vault"
      })).payload;
    },
    async listRequests() {
      return (await requestJson(baseUrl, headers, "/api/service/requests", {
        context: "Failed to list requests from Vault"
      })).payload;
    },
    async getRequest(id) {
      const {status, payload} = await requestJson(baseUrl, headers, `/api/service/requests/${encodeURIComponent(id)}`, {
        allowStatuses: [404],
        context: "Failed to load a request from Vault"
      });
      return status === 404 ? null : payload;
    },
    async getSetting(key) {
      const response = await fetch(`${baseUrl}/api/service/settings/${encodeURIComponent(key)}`, {
        headers
      });
      return json(response);
    },
    async setSetting(key, value) {
      const response = await fetch(`${baseUrl}/api/service/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({value})
      });
      return json(response);
    },
    async getSecret(key) {
      const response = await fetch(`${baseUrl}/api/service/secrets/${encodeURIComponent(key)}`, {
        headers
      });
      return json(response);
    },
    async setSecret(key, value) {
      const response = await fetch(`${baseUrl}/api/service/secrets/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({value})
      });
      return json(response);
    },
    async createRequest(payload) {
      return (await requestJson(baseUrl, headers, "/api/service/requests", {
        method: "POST",
        body: payload,
        context: "Failed to create a request in Vault"
      })).payload;
    },
    async updateRequest(id, payload) {
      const {status, payload: responsePayload} = await requestJson(baseUrl, headers, `/api/service/requests/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: payload,
        allowStatuses: [404],
        context: "Failed to update a request in Vault"
      });
      return status === 404 ? null : responsePayload;
    },
    async reviewRequest(id, payload) {
      const {status, payload: responsePayload} = await requestJson(baseUrl, headers, `/api/service/requests/${encodeURIComponent(id)}/review`, {
        method: "POST",
        body: payload,
        allowStatuses: [404],
        context: "Failed to review a request in Vault"
      });
      return status === 404 ? null : responsePayload;
    },
    async getProgress(discordUserId) {
      const response = await fetch(`${baseUrl}/api/service/progress/${encodeURIComponent(discordUserId)}`, {
        headers
      });
      return json(response);
    },
    async upsertProgress(payload) {
      const response = await fetch(`${baseUrl}/api/service/progress`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      return json(response);
    },
    async getReadState(discordUserId, mediaId = "") {
      const suffix = mediaId ? `?mediaId=${encodeURIComponent(mediaId)}` : "";
      return (await requestJson(baseUrl, headers, `/api/service/read-state/${encodeURIComponent(discordUserId)}${suffix}`, {
        context: "Failed to load user read state from Vault"
      })).payload;
    },
    async markTitleRead(payload) {
      return (await requestJson(baseUrl, headers, "/api/service/read-state/title/read", {
        method: "POST",
        body: payload,
        context: "Failed to mark the title read in Vault"
      })).payload;
    },
    async markTitleUnread(payload) {
      return (await requestJson(baseUrl, headers, "/api/service/read-state/title/unread", {
        method: "POST",
        body: payload,
        context: "Failed to mark the title unread in Vault"
      })).payload;
    },
    async markChapterRead(payload) {
      return (await requestJson(baseUrl, headers, "/api/service/read-state/chapter/read", {
        method: "POST",
        body: payload,
        context: "Failed to mark the chapter read in Vault"
      })).payload;
    },
    async markChapterUnread(payload) {
      return (await requestJson(baseUrl, headers, "/api/service/read-state/chapter/unread", {
        method: "POST",
        body: payload,
        context: "Failed to mark the chapter unread in Vault"
      })).payload;
    },
    async previewContentReset() {
      return (await requestJson(baseUrl, headers, "/api/service/content-reset/preview", {
        context: "Failed to preview the content reset in Vault"
      })).payload;
    },
    async executeContentReset() {
      return (await requestJson(baseUrl, headers, "/api/service/content-reset/execute", {
        method: "POST",
        body: {},
        context: "Failed to execute the content reset in Vault"
      })).payload;
    },
    async listRavenTitles() {
      const {payload} = await requestJson(baseUrl, headers, "/api/service/raven/titles", {
        context: "Failed to list Raven titles from Vault"
      });
      return payload;
    },
    async getRavenTitle(titleId) {
      const {status, payload} = await requestJson(baseUrl, headers, `/api/service/raven/titles/${encodeURIComponent(titleId)}`, {
        allowStatuses: [404],
        context: "Failed to load a Raven title from Vault"
      });
      return status === 404 ? null : payload;
    },
    async upsertRavenTitle(titleId, payload) {
      return (await requestJson(baseUrl, headers, `/api/service/raven/titles/${encodeURIComponent(titleId)}`, {
        method: "PUT",
        body: payload,
        context: "Failed to upsert a Raven title in Vault"
      })).payload;
    },
    async replaceRavenChapters(titleId, chapters) {
      return (await requestJson(baseUrl, headers, `/api/service/raven/titles/${encodeURIComponent(titleId)}/chapters`, {
        method: "PUT",
        body: {chapters},
        context: "Failed to replace Raven chapters in Vault"
      })).payload;
    },
    async listRavenDownloadTasks() {
      return (await requestJson(baseUrl, headers, "/api/service/raven/download-tasks", {
        context: "Failed to list Raven download tasks from Vault"
      })).payload;
    },
    async upsertRavenDownloadTask(taskId, payload) {
      return (await requestJson(baseUrl, headers, `/api/service/raven/download-tasks/${encodeURIComponent(taskId)}`, {
        method: "PUT",
        body: payload,
        context: "Failed to upsert a Raven download task in Vault"
      })).payload;
    },
    async getRavenMetadataMatch(titleId) {
      return (await requestJson(baseUrl, headers, `/api/service/raven/metadata-matches/${encodeURIComponent(titleId)}`, {
        context: "Failed to load a Raven metadata match from Vault"
      })).payload;
    },
    async setRavenMetadataMatch(titleId, payload) {
      return (await requestJson(baseUrl, headers, `/api/service/raven/metadata-matches/${encodeURIComponent(titleId)}`, {
        method: "PUT",
        body: payload,
        context: "Failed to store a Raven metadata match in Vault"
      })).payload;
    },
    async listJobs(filters = {}) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value != null && value !== "") {
          searchParams.set(key, String(value));
        }
      }
      const suffix = searchParams.size ? `?${searchParams.toString()}` : "";
      return (await requestJson(baseUrl, headers, `/api/service/jobs${suffix}`, {
        context: "Failed to list broker jobs from Vault"
      })).payload;
    },
    async getJob(jobId) {
      const {status, payload} = await requestJson(baseUrl, headers, `/api/service/jobs/${encodeURIComponent(jobId)}`, {
        allowStatuses: [404],
        context: "Failed to load a broker job from Vault"
      });
      return status === 404 ? null : payload;
    },
    async upsertJob(jobId, payload) {
      return (await requestJson(baseUrl, headers, `/api/service/jobs/${encodeURIComponent(jobId)}`, {
        method: "PUT",
        body: payload,
        context: "Failed to upsert a broker job in Vault"
      })).payload;
    },
    async listJobTasks(jobId, filters = {}) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value != null && value !== "") {
          searchParams.set(key, String(value));
        }
      }
      const suffix = searchParams.size ? `?${searchParams.toString()}` : "";
      return (await requestJson(baseUrl, headers, `/api/service/jobs/${encodeURIComponent(jobId)}/tasks${suffix}`, {
        context: "Failed to list broker job tasks from Vault"
      })).payload;
    },
    async upsertJobTask(jobId, taskId, payload) {
      return (await requestJson(baseUrl, headers, `/api/service/jobs/${encodeURIComponent(jobId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: "PUT",
        body: payload,
        context: "Failed to upsert a broker job task in Vault"
      })).payload;
    }
  };
};

