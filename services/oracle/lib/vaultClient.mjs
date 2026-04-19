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

export const createVaultClient = (config) => {
  const headers = withBearer(config.serviceToken);
  const baseUrl = config.vaultBaseUrl;

  return {
    async getSetting(key) {
      const response = await fetch(`${baseUrl}/api/service/settings/${encodeURIComponent(key)}`, {headers});
      return json(response);
    },
    async getSecret(key) {
      const response = await fetch(`${baseUrl}/api/service/secrets/${encodeURIComponent(key)}`, {headers});
      return json(response);
    }
  };
};

