import express from "express";
import {createLogger} from "@scriptarr/logging";
import {resolvePortalConfig} from "./config.mjs";
import {createPortalRuntime} from "./portalRuntime.mjs";
import {createSageClient} from "./sageClient.mjs";

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

export const createPortalApp = async ({
  logger = createLogger("PORTAL"),
  clientFactory
} = {}) => {
  const config = resolvePortalConfig();
  const sage = createSageClient(config);
  const runtime = createPortalRuntime({
    config,
    sage,
    logger,
    clientFactory
  });
  const app = express();
  app.use(express.json());

  const runtimeStatePayload = () => {
    const state = runtime.getState();
    return {
      ...state,
      connectionState: state.connectionState,
      registeredGuildId: state.registeredGuildId || state.guildId || ""
    };
  };

  app.get("/health", (_req, res) => {
    const state = runtimeStatePayload();
    res.json({
      ok: true,
      service: "scriptarr-portal",
      discord: state.mode,
      connected: state.connected,
      authConfigured: state.authConfigured,
      commands: state.commands,
      runtime: state
    });
  });

  app.get("/api/runtime", (_req, res) => {
    res.json(runtimeStatePayload());
  });

  app.post("/api/runtime/refresh", async (_req, res) => {
    await runtime.refreshSettings();
    res.json(runtimeStatePayload());
  });

  app.post("/api/runtime/discord/reload", async (_req, res) => {
    await runtime.refreshSettings();
    res.json(runtimeStatePayload());
  });

  app.get("/api/commands", (_req, res) => {
    const state = runtimeStatePayload();
    res.json({
      discord: {
        mode: state.mode,
        connectionState: state.connectionState,
        connected: state.connected,
        guildId: state.guildId,
        registeredGuildId: state.registeredGuildId,
        lastSyncAt: state.lastSyncAt,
        registeredCount: state.registeredCount,
        registeredGlobalCount: state.registeredGlobalCount,
        registeredGuildCount: state.registeredGuildCount,
        error: state.error,
        syncError: state.syncError,
        warning: state.warning,
        requestedIntents: state.requestedIntents,
        requestedPartials: state.requestedPartials,
        lastDirectMessageReceivedAt: state.lastDirectMessageReceivedAt,
        lastDownloadAllHandledAt: state.lastDownloadAllHandledAt,
        lastDownloadAllError: state.lastDownloadAllError,
        lastDownloadAllSource: state.lastDownloadAllSource,
        capabilities: state.capabilities
      },
      commands: state.commands
    });
  });

  app.post("/api/onboarding/render", async (req, res) => {
    await runtime.refreshSettings().catch(() => {});
    res.json({
      rendered: runtime.renderOnboarding(req.body || {})
    });
  });

  app.post("/api/onboarding/test", async (req, res) => {
    try {
      await runtime.refreshSettings().catch(() => {});
      res.json(await runtime.sendOnboardingTest(req.body || {}));
    } catch (error) {
      logger.warn("Portal onboarding test failed.", {error});
      res.status(409).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/requests/from-discord", async (req, res) => {
    const discordUserId = normalizeString(req.body?.discordUserId);
    const username = normalizeString(req.body?.username, "Discord Reader");
    const title = normalizeString(
      req.body?.title
      || req.body?.canonicalTitle
      || req.body?.selectedMetadata?.title
      || req.body?.selectedDownload?.titleName
    );
    const selectedMetadata = req.body?.selectedMetadata || null;
    const selectedDownload = req.body?.selectedDownload || null;
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
      avatarUrl: req.body?.avatarUrl || null,
      role: "member"
    });
    if (!userResult.ok) {
      res.status(userResult.status).json(userResult.payload);
      return;
    }

    const request = selectedMetadata || selectedDownload
      ? await sage.createDiscordRequest({
        source: "discord",
        discordUserId,
        username,
        title,
        query: normalizeString(req.body?.query, title),
        requestType: normalizeString(req.body?.requestType || selectedDownload?.requestType || selectedMetadata?.type, "manga"),
        notes: normalizeString(req.body?.notes),
        selectedMetadata,
        selectedDownload,
        ...(req.body?.targetIdentity ? {targetIdentity: req.body.targetIdentity} : {})
      })
      : await sage.createRequest({
        source: "discord",
        title,
        requestType: normalizeString(req.body?.requestType, "manga"),
        notes: normalizeString(req.body?.notes),
        requestedBy: discordUserId
      });

    res.status(request.status).json(request.payload);
  });

  app.post("/api/chat", async (req, res) => {
    const response = await sage.chat({message: req.body?.message});
    res.status(response.status).json(response.payload);
  });

  logger.info("Portal app initialized.", {
    discordConfigured: Boolean(config.discordToken && config.discordClientId)
  });

  return {app, config, runtime};
};
