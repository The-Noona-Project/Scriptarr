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
 *   getSetting: (key: string) => Promise<any>,
 *   setSetting: (key: string, value: unknown) => Promise<any>,
 *   getSecret: (key: string) => Promise<any>,
 *   setSecret: (key: string, value: unknown) => Promise<any>,
 *   createRequest: (payload: Record<string, unknown>) => Promise<any>,
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
      const response = await fetch(`${baseUrl}/api/service/requests`, {
        headers
      });
      return json(response);
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
      const response = await fetch(`${baseUrl}/api/service/requests`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      return json(response);
    },
    async reviewRequest(id, payload) {
      const response = await fetch(`${baseUrl}/api/service/requests/${encodeURIComponent(id)}/review`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      return response.status === 404 ? null : json(response);
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
    }
  };
};

