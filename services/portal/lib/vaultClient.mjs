const json = async (response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  return JSON.parse(text);
};

export const createVaultClient = (config) => {
  const headers = {
    "Authorization": `Bearer ${config.serviceToken}`,
    "Content-Type": "application/json"
  };

  return {
    async upsertDiscordUser(payload) {
      const response = await fetch(`${config.vaultBaseUrl}/api/service/users/upsert-discord`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      return json(response);
    },
    async createRequest(payload) {
      const response = await fetch(`${config.vaultBaseUrl}/api/service/requests`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      return json(response);
    }
  };
};
