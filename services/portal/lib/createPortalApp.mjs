import express from "express";
import {createLogger} from "@scriptarr/logging";
import {resolvePortalConfig} from "./config.mjs";
import {createSageClient} from "./sageClient.mjs";

const commandCatalog = Object.freeze([
  {name: "request", description: "Create a moderated Scriptarr request from Discord."},
  {name: "subscribe", description: "Subscribe to release notifications for a title."},
  {name: "status", description: "Ask Noona for read-only Scriptarr status."},
  {name: "chat", description: "Talk to Noona through Oracle and LocalAI."}
]);

export const createPortalApp = async ({logger = createLogger("PORTAL")} = {}) => {
  const config = resolvePortalConfig();
  const sage = createSageClient(config);
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "scriptarr-portal",
      discord: config.discordToken ? "ready" : "degraded",
      commands: commandCatalog
    });
  });

  app.get("/api/commands", (_req, res) => {
    res.json({
      commands: commandCatalog
    });
  });

  app.post("/api/onboarding/render", (req, res) => {
    const username = String(req.body.username || "reader");
    res.json({
      rendered: config.onboardingTemplate.replaceAll("{username}", username)
    });
  });

  app.post("/api/requests/from-discord", async (req, res) => {
    const discordUserId = String(req.body.discordUserId || "").trim();
    const username = String(req.body.username || "").trim() || "Discord Reader";
    const title = String(req.body.title || "").trim();
    if (!discordUserId || !title) {
      logger.warn("Discord request payload was incomplete.", {
        discordUserIdPresent: Boolean(discordUserId),
        titlePresent: Boolean(title)
      });
      res.status(400).json({error: "discordUserId and title are required."});
      return;
    }

    const userResult = await sage.upsertDiscordUser({
      discordUserId,
      username,
      avatarUrl: req.body.avatarUrl || null,
      role: "member"
    });
    if (!userResult.ok) {
      res.status(userResult.status).json(userResult.payload);
      return;
    }

    const request = await sage.createRequest({
      source: "discord",
      title,
      requestType: req.body.requestType || "manga",
      notes: req.body.notes || "",
      requestedBy: discordUserId
    });

    res.status(request.status).json(request.payload);
  });

  app.post("/api/chat", async (req, res) => {
    const response = await sage.chat({message: req.body.message});
    res.status(response.status).json(response.payload);
  });

  logger.info("Portal app initialized.", {
    discordReady: Boolean(config.discordToken)
  });

  return {app, config};
};
