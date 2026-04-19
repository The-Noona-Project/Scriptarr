import express from "express";
import {createLogger} from "@scriptarr/logging";
import {resolveVaultConfig} from "./config.mjs";
import {serviceAuth} from "./serviceAuth.mjs";
import {createStore} from "./createStore.mjs";

const requireJson = express.json();

export const createVaultApp = async ({logger = createLogger("VAULT")} = {}) => {
  const config = resolveVaultConfig();
  const store = createStore(config);
  await store.init();

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
    const user = await store.upsertDiscordUser(req.body);
    res.json(user);
  });

  app.get("/api/service/users", async (_req, res) => {
    res.json(await store.listUsers());
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

  app.get("/api/service/requests", async (_req, res) => {
    res.json(await store.listRequests());
  });

  app.post("/api/service/requests", requireJson, async (req, res) => {
    res.status(201).json(await store.createRequest(req.body));
  });

  app.post("/api/service/requests/:id/review", requireJson, async (req, res) => {
    const reviewed = await store.reviewRequest(req.params.id, req.body);
    if (!reviewed) {
      logger.warn("Request review target was not found.", {
        requestId: req.params.id
      });
      res.status(404).json({error: "Request not found."});
      return;
    }
    res.json(reviewed);
  });

  app.post("/api/service/progress", requireJson, async (req, res) => {
    res.json(await store.upsertProgress(req.body));
  });

  app.get("/api/service/progress/:discordUserId", async (req, res) => {
    res.json(await store.getProgressByUser(req.params.discordUserId));
  });

  logger.info("Vault app initialized.", {
    driver: config.driver
  });

  return {app, config, store};
};
