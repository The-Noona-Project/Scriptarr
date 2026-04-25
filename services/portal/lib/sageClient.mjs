const json = async (response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  return JSON.parse(text);
};

const withQuery = (path, query = {}) => {
  const entries = Object.entries(query).filter(([, value]) => value != null && String(value).trim() !== "");
  if (!entries.length) {
    return path;
  }

  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    search.set(key, String(value));
  }
  return `${path}?${search.toString()}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableNetworkError = (error) => {
  if (!(error instanceof Error)) {
    return false;
  }
  return /fetch failed/i.test(error.message || "");
};

const requestJson = async (baseUrl, headers, path, options = {}) => {
  const retries = Number.isInteger(options.retries) ? Math.max(1, options.retries) : 1;
  const retryDelayMs = Number.isInteger(options.retryDelayMs) ? Math.max(0, options.retryDelayMs) : 0;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 0;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let timeout = null;
    try {
      const controller = timeoutMs > 0 ? new AbortController() : null;
      timeout = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method || "GET",
        headers: options.body == null
          ? {"Authorization": headers.Authorization}
          : headers,
        body: options.body == null ? undefined : JSON.stringify(options.body),
        signal: controller?.signal
      });
      return {
        ok: response.ok,
        status: response.status,
        payload: await json(response)
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        error = new Error(`Request timed out after ${timeoutMs}ms`);
      }
      lastError = error;
      if (attempt >= retries || !isRetryableNetworkError(error)) {
        throw error;
      }
      await sleep(retryDelayMs);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  throw lastError;
};

export const createSageClient = (config) => {
  const authHeader = {
    "Authorization": `Bearer ${config.serviceToken}`
  };
  const jsonHeaders = {
    ...authHeader,
    "Content-Type": "application/json"
  };

  return {
    getDiscordSettings() {
      return requestJson(config.sageBaseUrl, authHeader, "/api/internal/portal/discord/settings");
    },
    getStatusSummary() {
      return requestJson(config.sageBaseUrl, authHeader, "/api/internal/portal/status");
    },
    searchLibrary(query) {
      return requestJson(config.sageBaseUrl, authHeader, withQuery("/api/internal/portal/library/search", {query}));
    },
    searchIntake(query) {
      return requestJson(config.sageBaseUrl, authHeader, withQuery("/api/internal/portal/intake/search", {query}));
    },
    searchRequestMetadata(query) {
      return requestJson(config.sageBaseUrl, authHeader, withQuery("/api/internal/portal/requests/metadata-search", {query}));
    },
    loadRequestDownloadOptions(payload) {
      return requestJson(config.sageBaseUrl, jsonHeaders, "/api/internal/portal/requests/download-options", {
        method: "POST",
        body: payload
      });
    },
    createDiscordRequest(payload) {
      return requestJson(config.sageBaseUrl, jsonHeaders, "/api/internal/portal/requests/from-discord", {
        method: "POST",
        body: payload
      });
    },
    selectDiscordRequestDownload(requestId, payload) {
      return requestJson(
        config.sageBaseUrl,
        jsonHeaders,
        `/api/internal/portal/requests/${encodeURIComponent(String(requestId || "").trim())}/select-download`,
        {
          method: "POST",
          body: payload
        }
      );
    },
    addFollowing(payload) {
      return requestJson(config.sageBaseUrl, jsonHeaders, "/api/internal/portal/following", {
        method: "POST",
        body: payload
      });
    },
    bulkQueueDownload(payload) {
      return requestJson(config.sageBaseUrl, jsonHeaders, "/api/internal/portal/downloads/bulk-queue", {
        method: "POST",
        body: payload,
        retries: 2,
        retryDelayMs: 250,
        timeoutMs: Number.isInteger(config.bulkQueueTimeoutMs) ? config.bulkQueueTimeoutMs : 900000
      });
    },
    listFollowNotifications() {
      return requestJson(config.sageBaseUrl, authHeader, "/api/internal/portal/notifications/follows");
    },
    acknowledgeFollowNotification(notificationId) {
      return requestJson(
        config.sageBaseUrl,
        jsonHeaders,
        `/api/internal/portal/notifications/follows/${encodeURIComponent(notificationId)}/ack`,
        {
          method: "POST",
          body: {}
        }
      );
    },
    listRequestNotifications() {
      return requestJson(config.sageBaseUrl, authHeader, "/api/internal/portal/notifications/requests");
    },
    acknowledgeRequestNotification(requestId) {
      return requestJson(
        config.sageBaseUrl,
        jsonHeaders,
        `/api/internal/portal/notifications/requests/${encodeURIComponent(requestId)}/ack`,
        {
          method: "POST",
          body: {}
        }
      );
    },
    chat(payload) {
      return requestJson(config.sageBaseUrl, jsonHeaders, "/api/internal/oracle/chat", {
        method: "POST",
        body: payload
      });
    },
    upsertDiscordUser(payload) {
      return requestJson(config.sageBaseUrl, jsonHeaders, "/api/internal/vault/users/upsert-discord", {
        method: "POST",
        body: payload
      });
    },
    createRequest(payload) {
      return requestJson(config.sageBaseUrl, jsonHeaders, "/api/internal/vault/requests", {
        method: "POST",
        body: payload
      });
    }
  };
};
