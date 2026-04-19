const json = async (response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  return JSON.parse(text);
};

const requestJson = async (baseUrl, headers, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body == null ? undefined : JSON.stringify(options.body)
  });

  return {
    ok: response.ok,
    status: response.status,
    payload: await json(response)
  };
};

export const createSageClient = (config) => {
  const headers = {
    "Authorization": `Bearer ${config.serviceToken}`,
    "Content-Type": "application/json"
  };

  return {
    upsertDiscordUser(payload) {
      return requestJson(config.sageBaseUrl, headers, "/api/internal/vault/users/upsert-discord", {
        method: "POST",
        body: payload
      });
    },
    createRequest(payload) {
      return requestJson(config.sageBaseUrl, headers, "/api/internal/vault/requests", {
        method: "POST",
        body: payload
      });
    },
    chat(payload) {
      return requestJson(config.sageBaseUrl, headers, "/api/internal/oracle/chat", {
        method: "POST",
        body: payload
      });
    }
  };
};
