import express from "express";
import {createLogger} from "@scriptarr/logging";
import {resolveVaultConfig} from "./config.mjs";
import {serviceAuth} from "./serviceAuth.mjs";
import {createStore} from "./createStore.mjs";
import {DEFAULT_EVENT_RETENTION_DAYS} from "./vaultEvents.mjs";

const JSON_BODY_LIMIT = "10mb";
const EVENT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const requireJson = express.json({limit: JSON_BODY_LIMIT});
const sendStoreError = (logger, res, error, context = {}) => {
  if (error?.code === "OWNER_ALREADY_CLAIMED") {
    logger.warn("Owner claim was rejected because an owner already exists.", context);
    res.status(409).json({error: "Owner already claimed.", code: error.code});
    return true;
  }
  if (error?.code === "REQUEST_REVISION_CONFLICT") {
    logger.warn("Request review revision conflict.", context);
    res.status(409).json({error: "Request revision conflict.", code: error.code});
    return true;
  }
  if (error?.code === "REQUEST_WORK_KEY_CONFLICT") {
    logger.warn("Request create or update hit an active work-key conflict.", {
      ...context,
      requestId: error?.requestId,
      workKeyKind: error?.workKeyKind
    });
    res.status(409).json({
      error: "That title is already queued or has an active request.",
      code: error.code,
      ...(error?.requestId ? {requestId: error.requestId} : {}),
      ...(error?.workKey ? {workKey: error.workKey} : {}),
      ...(error?.workKeyKind ? {workKeyKind: error.workKeyKind} : {})
    });
    return true;
  }
  if (["PROTECTED_OWNER", "DEFAULT_GROUP_REQUIRED", "PERMISSION_GROUP_CONFLICT"].includes(error?.code)) {
    logger.warn("Vault rejected an access-control mutation.", {
      ...context,
      code: error.code
    });
    res.status(409).json({error: error.message, code: error.code});
    return true;
  }
  return false;
};

export const createVaultApp = async ({logger = createLogger("VAULT")} = {}) => {
  const config = resolveVaultConfig();
  const store = createStore(config);
  await store.init();
  const pruneTimer = setInterval(() => {
    void store.pruneEvents(DEFAULT_EVENT_RETENTION_DAYS).catch((error) => {
      logger.warn("Vault failed to prune expired durable events.", {
        retentionDays: DEFAULT_EVENT_RETENTION_DAYS,
        error
      });
    });
  }, EVENT_PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();

  const app = express();
  const auth = serviceAuth(config);

  app.get("/health", async (_req, res) => {
    const health = await store.health();
    res.json({
      ok: true,
      service: "scriptarr-vault",
      driver: store.driver,
      ...health
    });
  });

  app.get("/api/public/bootstrap-status", async (_req, res) => {
    res.json(await store.getBootstrapStatus(process.env.SUPERUSER_ID || ""));
  });

  app.use("/api/service", auth);

  app.post("/api/service/users/upsert-discord", requireJson, async (req, res) => {
    try {
      const user = await store.upsertDiscordUser(req.body);
      res.json(user);
    } catch (error) {
      if (sendStoreError(logger, res, error, {discordUserId: req.body?.discordUserId})) {
        return;
      }
      throw error;
    }
  });

  app.get("/api/service/users", async (_req, res) => {
    res.json(await store.listUsers());
  });

  app.get("/api/service/access", async (_req, res) => {
    res.json(await store.getAccessOverview());
  });

  app.get("/api/service/permission-groups", async (_req, res) => {
    res.json(await store.listPermissionGroups());
  });

  app.post("/api/service/permission-groups", requireJson, async (req, res) => {
    try {
      res.status(201).json(await store.createPermissionGroup(req.body || {}));
    } catch (error) {
      if (sendStoreError(logger, res, error, {groupId: req.body?.id || req.body?.name})) {
        return;
      }
      throw error;
    }
  });

  app.patch("/api/service/permission-groups/:groupId", requireJson, async (req, res) => {
    try {
      const group = await store.updatePermissionGroup(req.params.groupId, req.body || {});
      if (!group) {
        res.status(404).json({error: "Permission group not found."});
        return;
      }
      res.json(group);
    } catch (error) {
      if (sendStoreError(logger, res, error, {groupId: req.params.groupId})) {
        return;
      }
      throw error;
    }
  });

  app.delete("/api/service/permission-groups/:groupId", async (req, res) => {
    try {
      const group = await store.deletePermissionGroup(req.params.groupId);
      if (!group) {
        res.status(404).json({error: "Permission group not found."});
        return;
      }
      res.json(group);
    } catch (error) {
      if (sendStoreError(logger, res, error, {groupId: req.params.groupId})) {
        return;
      }
      throw error;
    }
  });

  app.put("/api/service/users/:discordUserId/groups", requireJson, async (req, res) => {
    try {
      const user = await store.assignUserGroups(
        req.params.discordUserId,
        Array.isArray(req.body?.groupIds) ? req.body.groupIds : []
      );
      if (!user) {
        res.status(404).json({error: "User not found."});
        return;
      }
      res.json(user);
    } catch (error) {
      if (sendStoreError(logger, res, error, {discordUserId: req.params.discordUserId})) {
        return;
      }
      throw error;
    }
  });

  app.delete("/api/service/users/:discordUserId", async (req, res) => {
    try {
      const user = await store.deleteUser(req.params.discordUserId);
      if (!user) {
        res.status(404).json({error: "User not found."});
        return;
      }
      res.json(user);
    } catch (error) {
      if (sendStoreError(logger, res, error, {discordUserId: req.params.discordUserId})) {
        return;
      }
      throw error;
    }
  });

  app.get("/api/service/users/by-discord/:discordUserId", async (req, res) => {
    const user = await store.getUserByDiscordId(req.params.discordUserId);
    if (!user) {
      logger.warn("Discord user lookup missed.", {
        discordUserId: req.params.discordUserId
      });
      res.status(404).json({error: "User not found."});
      return;
    }
    res.json(user);
  });

  app.post("/api/service/sessions", requireJson, async (req, res) => {
    res.json(await store.createSession(req.body));
  });

  app.get("/api/service/sessions/:token", async (req, res) => {
    const user = await store.getUserForSession(req.params.token);
    if (!user) {
      logger.warn("Session lookup missed.", {
        token: req.params.token
      });
      res.status(404).json({error: "Session not found."});
      return;
    }
    res.json(user);
  });

  app.delete("/api/service/sessions/:token", async (req, res) => {
    const session = await store.clearSession(req.params.token);
    if (!session) {
      res.status(404).json({error: "Session not found."});
      return;
    }
    res.json(session);
  });

  app.delete("/api/service/sessions/user/:discordUserId", async (req, res) => {
    res.json(await store.clearSessionsForUser(req.params.discordUserId));
  });

  app.get("/api/service/settings/:key", async (req, res) => {
    const setting = await store.getSetting(req.params.key);
    res.json(setting || {key: req.params.key, value: null});
  });

  app.put("/api/service/settings/:key", requireJson, async (req, res) => {
    res.json(await store.setSetting(req.params.key, req.body.value));
  });

  app.get("/api/service/secrets/:key", async (req, res) => {
    const secret = await store.getSecret(req.params.key);
    res.json(secret || {key: req.params.key, value: null});
  });

  app.put("/api/service/secrets/:key", requireJson, async (req, res) => {
    res.json(await store.setSecret(req.params.key, req.body.value));
  });

  app.get("/api/service/events", async (req, res) => {
    const domains = Array.isArray(req.query.domain)
      ? req.query.domain.map((value) => String(value))
      : req.query.domain
        ? [String(req.query.domain)]
        : [];
    res.json(await store.listEvents({
      domains,
      actorId: req.query.actorId ? String(req.query.actorId) : "",
      targetId: req.query.targetId ? String(req.query.targetId) : "",
      afterSequence: req.query.afterSequence || req.query.after || 0,
      limit: req.query.limit || 100,
      newestFirst: req.query.newestFirst !== "false"
    }));
  });

  app.post("/api/service/events", requireJson, async (req, res) => {
    res.status(201).json(await store.appendEvent(req.body || {}));
  });

  app.delete("/api/service/events/prune", async (req, res) => {
    res.json(await store.pruneEvents(req.query.retentionDays || DEFAULT_EVENT_RETENTION_DAYS));
  });

  app.get("/api/service/requests", async (_req, res) => {
    res.json(await store.listRequests());
  });

  app.get("/api/service/requests/:id", async (req, res) => {
    const request = await store.getRequest(req.params.id);
    if (!request) {
      logger.warn("Request lookup target was not found.", {
        requestId: req.params.id
      });
      res.status(404).json({error: "Request not found."});
      return;
    }
    res.json(request);
  });

  app.post("/api/service/requests", requireJson, async (req, res) => {
    try {
      res.status(201).json(await store.createRequest(req.body));
    } catch (error) {
      if (sendStoreError(logger, res, error, {
        requestedBy: req.body?.requestedBy,
        source: req.body?.source
      })) {
        return;
      }
      throw error;
    }
  });

  app.patch("/api/service/requests/:id", requireJson, async (req, res) => {
    try {
      const updated = await store.updateRequest(req.params.id, req.body || {});
      if (!updated) {
        logger.warn("Request update target was not found.", {
          requestId: req.params.id
        });
        res.status(404).json({error: "Request not found."});
        return;
      }
      res.json(updated);
    } catch (error) {
      if (sendStoreError(logger, res, error, {requestId: req.params.id})) {
        return;
      }
      throw error;
    }
  });

  app.post("/api/service/requests/:id/review", requireJson, async (req, res) => {
    try {
      const reviewed = await store.reviewRequest(req.params.id, req.body);
      if (!reviewed) {
        logger.warn("Request review target was not found.", {
          requestId: req.params.id
        });
        res.status(404).json({error: "Request not found."});
        return;
      }
      res.json(reviewed);
    } catch (error) {
      if (sendStoreError(logger, res, error, {requestId: req.params.id})) {
        return;
      }
      throw error;
    }
  });

  app.post("/api/service/progress", requireJson, async (req, res) => {
    res.json(await store.upsertProgress(req.body));
  });

  app.get("/api/service/progress/:discordUserId", async (req, res) => {
    res.json(await store.getProgressByUser(req.params.discordUserId));
  });

  app.get("/api/service/raven/titles", async (_req, res) => {
    res.json(await store.listRavenTitles());
  });

  app.get("/api/service/raven/titles/:titleId", async (req, res) => {
    const title = await store.getRavenTitle(req.params.titleId);
    if (!title) {
      res.status(404).json({error: "Raven title not found."});
      return;
    }
    res.json(title);
  });

  app.put("/api/service/raven/titles/:titleId", requireJson, async (req, res) => {
    const chapters = Array.isArray(req.body?.chapters) ? req.body.chapters : null;
    const title = await store.upsertRavenTitle({
      ...req.body,
      id: req.params.titleId
    });
    if (chapters) {
      await store.replaceRavenChapters(req.params.titleId, chapters);
    }
    res.json(await store.getRavenTitle(req.params.titleId) || title);
  });

  app.put("/api/service/raven/titles/:titleId/chapters", requireJson, async (req, res) => {
    res.json(await store.replaceRavenChapters(req.params.titleId, Array.isArray(req.body?.chapters) ? req.body.chapters : []));
  });

  app.get("/api/service/raven/download-tasks", async (_req, res) => {
    res.json(await store.listRavenDownloadTasks());
  });

  app.put("/api/service/raven/download-tasks/:taskId", requireJson, async (req, res) => {
    res.json(await store.upsertRavenDownloadTask({
      ...req.body,
      taskId: req.params.taskId
    }));
  });

  app.get("/api/service/raven/metadata-matches/:titleId", async (req, res) => {
    const match = await store.getRavenMetadataMatch(req.params.titleId);
    res.json(match || {titleId: req.params.titleId, provider: null, providerSeriesId: null, details: {}});
  });

  app.put("/api/service/raven/metadata-matches/:titleId", requireJson, async (req, res) => {
    res.json(await store.setRavenMetadataMatch(req.params.titleId, req.body || {}));
  });

  app.get("/api/service/jobs", async (req, res) => {
    res.json(await store.listJobs({
      ownerService: req.query.ownerService ? String(req.query.ownerService) : undefined,
      kind: req.query.kind ? String(req.query.kind) : undefined,
      status: req.query.status ? String(req.query.status) : undefined
    }));
  });

  app.get("/api/service/jobs/:jobId", async (req, res) => {
    const job = await store.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({error: "Job not found."});
      return;
    }
    res.json(job);
  });

  app.put("/api/service/jobs/:jobId", requireJson, async (req, res) => {
    res.json(await store.upsertJob({
      ...req.body,
      jobId: req.params.jobId
    }));
  });

  app.get("/api/service/jobs/:jobId/tasks", async (req, res) => {
    res.json(await store.listJobTasks({
      jobId: req.params.jobId,
      status: req.query.status ? String(req.query.status) : undefined
    }));
  });

  app.put("/api/service/jobs/:jobId/tasks/:taskId", requireJson, async (req, res) => {
    res.json(await store.upsertJobTask(req.params.jobId, {
      ...req.body,
      taskId: req.params.taskId
    }));
  });

  logger.info("Vault app initialized.", {
    driver: config.driver
  });

  return {
    app,
    config,
    store,
    close() {
      clearInterval(pruneTimer);
    }
  };
};
