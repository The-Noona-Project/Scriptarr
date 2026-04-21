import {proxyJson} from "./proxy.mjs";

/**
 * Register the original Moon proxy routes that older Scriptarr surfaces still
 * understand while the Moon v3 interfaces take over.
 *
 * @param {import("express").Express} app
 * @param {{
 *   config: {sageBaseUrl: string},
 *   getSessionToken: (request: import("express").Request) => string
 * }} options
 * @returns {void}
 */
export const registerLegacyApiRoutes = (app, {config, getSessionToken}) => {
  const proxyToSage = (req, targetPath, options = {}) => proxyJson({
    baseUrl: config.sageBaseUrl,
    path: targetPath,
    sessionToken: getSessionToken(req),
    ...options
  });

  app.get("/api/moon/library", async (req, res) => {
    const result = await proxyToSage(req, "/api/library");
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/requests", async (req, res) => {
    const result = await proxyToSage(req, "/api/requests");
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/requests", async (req, res) => {
    const result = await proxyToSage(req, "/api/requests", {
      method: "POST",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/reader/progress", async (req, res) => {
    const result = await proxyToSage(req, "/api/reader/progress");
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/reader/progress", async (req, res) => {
    const result = await proxyToSage(req, "/api/reader/progress", {
      method: "POST",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/status", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/status");
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/metadata/providers", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/metadata/providers");
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/settings/raven/vpn", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/raven/vpn");
    res.status(result.status).json(result.payload);
  });

  app.put("/api/moon/admin/settings/raven/vpn", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/raven/vpn", {
      method: "PUT",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/settings/raven/naming", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/raven/naming");
    res.status(result.status).json(result.payload);
  });

  app.put("/api/moon/admin/settings/raven/naming", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/raven/naming", {
      method: "PUT",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/settings/raven/metadata", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/raven/metadata");
    res.status(result.status).json(result.payload);
  });

  app.put("/api/moon/admin/settings/raven/metadata", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/raven/metadata", {
      method: "PUT",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/settings/raven/download-providers", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/raven/download-providers");
    res.status(result.status).json(result.payload);
  });

  app.put("/api/moon/admin/settings/raven/download-providers", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/raven/download-providers", {
      method: "PUT",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/settings/oracle", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/oracle");
    res.status(result.status).json(result.payload);
  });

  app.put("/api/moon/admin/settings/oracle", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/oracle", {
      method: "PUT",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/settings/moon/branding", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/moon/branding");
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/settings/portal/discord", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/portal/discord");
    res.status(result.status).json(result.payload);
  });

  app.put("/api/moon/admin/settings/portal/discord", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/portal/discord", {
      method: "PUT",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/admin/settings/portal/discord/onboarding/test", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/portal/discord/onboarding/test", {
      method: "POST",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.put("/api/moon/admin/settings/moon/branding", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/moon/branding", {
      method: "PUT",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/settings/moon/public-api", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/moon/public-api");
    res.status(result.status).json(result.payload);
  });

  app.put("/api/moon/admin/settings/moon/public-api", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/moon/public-api", {
      method: "PUT",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/admin/settings/moon/public-api/key", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/settings/moon/public-api/key", {
      method: "POST",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/moon/admin/warden/localai", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/warden/localai");
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/admin/warden/localai/install", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/warden/localai/install", {
      method: "POST",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/admin/warden/localai/start", async (req, res) => {
    const result = await proxyToSage(req, "/api/admin/warden/localai/start", {
      method: "POST",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.post("/api/moon/admin/requests/:id/review", async (req, res) => {
    const result = await proxyToSage(req, `/api/admin/requests/${encodeURIComponent(req.params.id)}/review`, {
      method: "POST",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });
};

export default registerLegacyApiRoutes;
