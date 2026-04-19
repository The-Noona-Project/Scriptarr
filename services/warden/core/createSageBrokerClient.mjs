/**
 * @file Scriptarr Warden module: services/warden/core/createSageBrokerClient.mjs.
 */

const normalizeBaseUrl = (value, fallback) => String(value || fallback).replace(/\/$/, "");

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

const requestJson = async (baseUrl, headers, path, {
  method = "GET",
  body,
  allowStatuses = [],
  context = "Sage broker request failed"
} = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2000)
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
 * Create Warden's Sage internal-broker client for durable job/task snapshots.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{
 *   listJobs: (filters?: Record<string, string>) => Promise<any[]>,
 *   getJob: (jobId: string) => Promise<any>,
 *   upsertJob: (jobId: string, payload: Record<string, unknown>) => Promise<any>,
 *   listJobTasks: (jobId: string, filters?: Record<string, string>) => Promise<any[]>,
 *   upsertJobTask: (jobId: string, taskId: string, payload: Record<string, unknown>) => Promise<any>
 * }}
 */
export const createSageBrokerClient = ({env = process.env} = {}) => {
  const baseUrl = normalizeBaseUrl(env.SCRIPTARR_SAGE_BASE_URL, "http://scriptarr-sage:3004");
  const headers = {
    "Authorization": `Bearer ${env.SCRIPTARR_SERVICE_TOKEN || env.SCRIPTARR_WARDEN_SERVICE_TOKEN || "warden-dev-token"}`,
    "Content-Type": "application/json"
  };

  const buildSuffix = (filters = {}) => {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value != null && value !== "") {
        searchParams.set(key, String(value));
      }
    }
    return searchParams.size ? `?${searchParams.toString()}` : "";
  };

  return {
    async listJobs(filters = {}) {
      return (await requestJson(baseUrl, headers, `/api/internal/jobs${buildSuffix(filters)}`, {
        context: "Failed to list broker jobs through Sage"
      })).payload;
    },
    async getJob(jobId) {
      const result = await requestJson(baseUrl, headers, `/api/internal/jobs/${encodeURIComponent(jobId)}`, {
        allowStatuses: [404],
        context: "Failed to load a broker job through Sage"
      });
      return result.status === 404 ? null : result.payload;
    },
    async upsertJob(jobId, payload) {
      return (await requestJson(baseUrl, headers, `/api/internal/jobs/${encodeURIComponent(jobId)}`, {
        method: "PUT",
        body: payload,
        context: "Failed to upsert a broker job through Sage"
      })).payload;
    },
    async listJobTasks(jobId, filters = {}) {
      return (await requestJson(baseUrl, headers, `/api/internal/jobs/${encodeURIComponent(jobId)}/tasks${buildSuffix(filters)}`, {
        context: "Failed to list broker job tasks through Sage"
      })).payload;
    },
    async upsertJobTask(jobId, taskId, payload) {
      return (await requestJson(baseUrl, headers, `/api/internal/jobs/${encodeURIComponent(jobId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: "PUT",
        body: payload,
        context: "Failed to upsert a broker job task through Sage"
      })).payload;
    }
  };
};

export default createSageBrokerClient;
