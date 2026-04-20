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

const requestJson = async (baseUrl, headers, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: options.body == null
      ? {"Authorization": headers.Authorization}
      : headers,
    body: options.body == null ? undefined : JSON.stringify(options.body)
  });

  return {
    ok: response.ok,
    status: response.status,
    payload: await json(response)
  };
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
    createDiscordRequest(payload) {
      return requestJson(config.sageBaseUrl, jsonHeaders, "/api/internal/portal/requests/from-discord", {
        method: "POST",
        body: payload
      });
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
        body: payload
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
