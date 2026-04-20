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
 *   createSession: (discordUserId: string) => Promise<any>,
 *   getSessionUser: (token: string) => Promise<any>,
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
    async createSession(discordUserId) {
      const response = await fetch(`${baseUrl}/api/service/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({discordUserId})
      });
      return json(response);
    },
    async getSessionUser(token) {
      const response = await fetch(`${baseUrl}/api/service/sessions/${encodeURIComponent(token)}`, {
        headers
      });
      return response.status === 404 ? null : json(response);
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

