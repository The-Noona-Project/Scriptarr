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

const requestJson = async (baseUrl, path, headers, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      ...headers,
      ...(options.headers || {})
    },
    body: options.body == null ? undefined : JSON.stringify(options.body)
  });
  const payload = await json(response);
  return {
    ok: response.ok,
    status: response.status,
    payload
  };
};

export const createSageClient = (config) => {
  const headers = withBearer(config.serviceToken);
  const baseUrl = config.sageBaseUrl;

  return {
    async getSetting(key) {
      const response = await requestJson(baseUrl, `/api/internal/vault/settings/${encodeURIComponent(key)}`, headers);
      return response.payload;
    },
    async getSecret(key) {
      const response = await requestJson(baseUrl, `/api/internal/vault/secrets/${encodeURIComponent(key)}`, headers);
      return response.payload;
    },
    async getBootstrapStatus() {
      const response = await requestJson(baseUrl, "/api/internal/warden/bootstrap", headers);
      if (!response.ok) {
        throw new Error(response.payload?.error || `Sage bootstrap request failed with ${response.status}`);
      }
      return response.payload;
    }
  };
};

export default createSageClient;
