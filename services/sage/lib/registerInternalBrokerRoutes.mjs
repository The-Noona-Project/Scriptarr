/**
 * @file Scriptarr Sage module: services/sage/lib/registerInternalBrokerRoutes.mjs.
 */

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const withService = (requireService, allowedServices, handler) => async (req, res) => {
  await requireService(allowedServices)(req, res, async () => {
    await handler(req, res);
  });
};

const proxyResult = async (res, promise) => {
  const result = await promise;
  res.status(result.status).json(result.payload);
};

/**
 * Register Sage's token-authenticated internal broker routes. These routes are
 * for first-party service-to-service traffic only; browser clients should
 * continue using Moon-facing Sage endpoints instead.
 *
 * @param {import("express").Express} app
 * @param {{
 *   config: Record<string, string>,
 *   vaultClient: ReturnType<import("./vaultClient.mjs").createVaultClient>,
 *   requireService: (allowedServices: string | string[]) => import("express").RequestHandler,
 *   serviceJson: (baseUrl: string, path: string, options?: {method?: string, body?: unknown, headers?: Record<string, string>}) => Promise<{ok: boolean, status: number, payload: any}>
 * }} options
 */
export const registerInternalBrokerRoutes = (app, {
  config,
  vaultClient,
  requireService,
  serviceJson
}) => {
  app.post("/api/internal/vault/users/upsert-discord", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    res.json(await vaultClient.upsertDiscordUser(req.body || {}));
  }));

  app.get("/api/internal/vault/users/by-discord/:discordUserId", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const user = await vaultClient.getUserByDiscordId(req.params.discordUserId);
    if (!user) {
      res.status(404).json({error: "User not found."});
      return;
    }
    res.json(user);
  }));

  app.get("/api/internal/vault/settings/:key", withService(requireService, ["scriptarr-oracle", "scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.getSetting(req.params.key));
  }));

  app.put("/api/internal/vault/settings/:key", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.setSetting(req.params.key, req.body?.value));
  }));

  app.get("/api/internal/vault/secrets/:key", withService(requireService, ["scriptarr-oracle", "scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.getSecret(req.params.key));
  }));

  app.put("/api/internal/vault/secrets/:key", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.setSecret(req.params.key, req.body?.value));
  }));

  app.get("/api/internal/vault/requests", withService(requireService, ["scriptarr-portal"], async (_req, res) => {
    res.json(await vaultClient.listRequests());
  }));

  app.post("/api/internal/vault/requests", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    res.status(201).json(await vaultClient.createRequest(req.body || {}));
  }));

  app.post("/api/internal/vault/requests/:id/review", withService(requireService, ["scriptarr-warden"], async (req, res) => {
    const reviewed = await vaultClient.reviewRequest(req.params.id, req.body || {});
    if (!reviewed) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    res.json(reviewed);
  }));

  app.get("/api/internal/vault/raven/titles", withService(requireService, ["scriptarr-raven"], async (_req, res) => {
    res.json(await vaultClient.listRavenTitles());
  }));

  app.get("/api/internal/vault/raven/titles/:titleId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    const title = await vaultClient.getRavenTitle(req.params.titleId);
    if (!title) {
      res.status(404).json({error: "Raven title not found."});
      return;
    }
    res.json(title);
  }));

  app.put("/api/internal/vault/raven/titles/:titleId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.upsertRavenTitle(req.params.titleId, {
      ...req.body,
      id: req.params.titleId
    }));
  }));

  app.put("/api/internal/vault/raven/titles/:titleId/chapters", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.replaceRavenChapters(req.params.titleId, normalizeArray(req.body?.chapters)));
  }));

  app.get("/api/internal/vault/raven/download-tasks", withService(requireService, ["scriptarr-raven"], async (_req, res) => {
    res.json(await vaultClient.listRavenDownloadTasks());
  }));

  app.put("/api/internal/vault/raven/download-tasks/:taskId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.upsertRavenDownloadTask(req.params.taskId, {
      ...req.body,
      taskId: req.params.taskId
    }));
  }));

  app.get("/api/internal/vault/raven/metadata-matches/:titleId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.getRavenMetadataMatch(req.params.titleId));
  }));

  app.put("/api/internal/vault/raven/metadata-matches/:titleId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.setRavenMetadataMatch(req.params.titleId, req.body || {}));
  }));

  app.get("/api/internal/jobs", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.listJobs({
      ownerService: normalizeString(req.query.ownerService),
      kind: normalizeString(req.query.kind),
      status: normalizeString(req.query.status)
    }));
  }));

  app.get("/api/internal/jobs/:jobId", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    const job = await vaultClient.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({error: "Job not found."});
      return;
    }
    res.json(job);
  }));

  app.put("/api/internal/jobs/:jobId", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.upsertJob(req.params.jobId, {
      ...req.body,
      jobId: req.params.jobId
    }));
  }));

  app.get("/api/internal/jobs/:jobId/tasks", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.listJobTasks(req.params.jobId, {
      status: normalizeString(req.query.status)
    }));
  }));

  app.put("/api/internal/jobs/:jobId/tasks/:taskId", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.upsertJobTask(req.params.jobId, req.params.taskId, {
      ...req.body,
      taskId: req.params.taskId
    }));
  }));

  app.get("/api/internal/warden/bootstrap", withService(requireService, ["scriptarr-oracle"], async (_req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/bootstrap"));
  }));

  app.get("/api/internal/warden/runtime", withService(requireService, ["scriptarr-oracle"], async (_req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/runtime"));
  }));

  app.get("/api/internal/warden/updates", withService(requireService, ["scriptarr-oracle"], async (_req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/updates"));
  }));

  app.post("/api/internal/warden/updates/check", withService(requireService, ["scriptarr-oracle"], async (req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/updates/check", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    }));
  }));

  app.post("/api/internal/warden/updates/install", withService(requireService, ["scriptarr-oracle"], async (req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/updates/install", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    }));
  }));

  app.get("/api/internal/oracle/status", withService(requireService, ["scriptarr-portal"], async (_req, res) => {
    await proxyResult(res, serviceJson(config.oracleBaseUrl, "/api/status"));
  }));

  app.post("/api/internal/oracle/chat", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    await proxyResult(res, serviceJson(config.oracleBaseUrl, "/api/chat", {
      method: "POST",
      body: req.body || {}
    }));
  }));
};

export default registerInternalBrokerRoutes;
