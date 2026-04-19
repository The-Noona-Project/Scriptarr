/**
 * @file Scriptarr Sage module: services/sage/lib/createSageApp.mjs.
 */
import express from "express";
import {resolveSageConfig} from "./config.mjs";
import {createVaultClient} from "./vaultClient.mjs";
import {buildCallbackUrl, buildDiscordOauthUrl, exchangeDiscordCode} from "./discordAuth.mjs";
import {requirePermission, requireSession} from "./auth.mjs";
import {registerMoonV3Routes} from "./registerMoonV3Routes.mjs";

const readerLibrary = Object.freeze([
  {
    id: "dan-da-dan",
    title: "Dandadan",
    type: "manga",
    status: "watching",
    latestChapter: "166",
    coverAccent: "#ff6a3d"
  },
  {
    id: "sakamoto-days",
    title: "Sakamoto Days",
    type: "manga",
    status: "active",
    latestChapter: "209",
    coverAccent: "#e4d7b8"
  },
  {
    id: "blacksad",
    title: "Blacksad",
    type: "comic",
    status: "completed",
    latestChapter: "Vol. 7",
    coverAccent: "#5a7184"
  }
]);

const RAVEN_VPN_KEY = "raven.vpn";
const RAVEN_VPN_PASSWORD_SECRET = "raven.vpn.piaPassword";
const RAVEN_METADATA_KEY = "raven.metadata.providers";
const ORACLE_SETTINGS_KEY = "oracle.settings";
const ORACLE_OPENAI_API_KEY_SECRET = "oracle.openai.apiKey";

const knownMetadataProviders = Object.freeze([
  {id: "mangadex", name: "MangaDex", scopes: ["manga", "webtoon"], enabled: true, priority: 10},
  {id: "anilist", name: "AniList", scopes: ["manga"], enabled: false, priority: 20},
  {id: "comicvine", name: "ComicVine", scopes: ["comic"], enabled: false, priority: 30, credentialKey: "comicVineApiKey"}
]);

const safeJson = async (promise) => {
  try {
    return await promise;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

const loadWardenStatus = async (baseUrl) => {
  const [health, bootstrap, runtime] = await Promise.all([
    safeJson(fetch(`${baseUrl}/health`).then((response) => response.json())),
    safeJson(serviceJson(baseUrl, "/api/bootstrap")),
    safeJson(serviceJson(baseUrl, "/api/runtime"))
  ]);

  return {
    health: health.payload || health,
    bootstrap: bootstrap.payload || bootstrap,
    runtime: runtime.payload || runtime
  };
};

const serviceJson = async (baseUrl, servicePath, options = {}) => {
  const method = options.method || "GET";
  const response = await fetch(`${baseUrl}${servicePath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body == null ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return {
    ok: response.ok,
    status: response.status,
    payload
  };
};

const normalizeBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const defaultRavenVpnSettings = () => ({
  key: RAVEN_VPN_KEY,
  enabled: false,
  region: "us_california",
  piaUsername: "",
  passwordConfigured: false
});

const defaultMetadataProviderSettings = () => ({
  key: RAVEN_METADATA_KEY,
  providers: knownMetadataProviders.map((provider) => ({...provider}))
});

const defaultOracleSettings = () => ({
  key: ORACLE_SETTINGS_KEY,
  enabled: false,
  provider: "openai",
  model: process.env.SCRIPTARR_ORACLE_OPENAI_MODEL || "gpt-4.1-mini",
  temperature: 0.2,
  localAiProfileKey: "nvidia",
  localAiImageMode: "preset",
  localAiCustomImage: "",
  openAiApiKeyConfigured: false
});

const normalizeProviderId = (value) => normalizeString(value).toLowerCase();

const normalizeMetadataProviderSettings = (value) => {
  const requested = Array.isArray(value?.providers) ? value.providers : [];
  const requestedById = new Map(requested.map((entry) => [normalizeProviderId(entry?.id), entry]));

  return {
    key: RAVEN_METADATA_KEY,
    providers: knownMetadataProviders
      .map((provider) => {
        const requestedEntry = requestedById.get(provider.id) || {};
        const parsedPriority = Number.parseInt(String(requestedEntry.priority ?? provider.priority), 10);
        return {
          ...provider,
          enabled: normalizeBoolean(requestedEntry.enabled, provider.enabled),
          priority: Number.isInteger(parsedPriority) && parsedPriority > 0 ? parsedPriority : provider.priority
        };
      })
      .sort((left, right) => left.priority - right.priority)
  };
};

const normalizeRavenVpnSettings = (value, secretValue) => {
  const defaults = defaultRavenVpnSettings();
  return {
    ...defaults,
    enabled: normalizeBoolean(value?.enabled, defaults.enabled),
    region: normalizeString(value?.region, defaults.region),
    piaUsername: normalizeString(value?.piaUsername, defaults.piaUsername),
    passwordConfigured: Boolean(secretValue)
  };
};

const normalizeOracleSettings = (value, secretValue) => {
  const defaults = defaultOracleSettings();
  const temperature = Number.parseFloat(String(value?.temperature ?? defaults.temperature));
  return {
    ...defaults,
    enabled: normalizeBoolean(value?.enabled, defaults.enabled),
    provider: ["openai", "localai"].includes(normalizeString(value?.provider, defaults.provider))
      ? normalizeString(value?.provider, defaults.provider)
      : defaults.provider,
    model: normalizeString(value?.model, defaults.model),
    temperature: Number.isFinite(temperature) ? temperature : defaults.temperature,
    localAiProfileKey: normalizeString(value?.localAiProfileKey, defaults.localAiProfileKey),
    localAiImageMode: ["preset", "custom"].includes(normalizeString(value?.localAiImageMode, defaults.localAiImageMode))
      ? normalizeString(value?.localAiImageMode, defaults.localAiImageMode)
      : defaults.localAiImageMode,
    localAiCustomImage: normalizeString(value?.localAiCustomImage, defaults.localAiCustomImage),
    openAiApiKeyConfigured: Boolean(secretValue)
  };
};

const readSetting = async (vaultClient, key, fallback) => {
  const setting = await vaultClient.getSetting(key);
  return setting?.value ?? fallback;
};

const readSecret = async (vaultClient, key) => {
  const secret = await vaultClient.getSecret(key);
  return secret?.value ?? null;
};

const readRavenVpnSettings = async (vaultClient) => {
  const [settingsValue, password] = await Promise.all([
    readSetting(vaultClient, RAVEN_VPN_KEY, defaultRavenVpnSettings()),
    readSecret(vaultClient, RAVEN_VPN_PASSWORD_SECRET)
  ]);
  return normalizeRavenVpnSettings(settingsValue, password);
};

const readMetadataProviderSettings = async (vaultClient) => {
  const settingsValue = await readSetting(vaultClient, RAVEN_METADATA_KEY, defaultMetadataProviderSettings());
  return normalizeMetadataProviderSettings(settingsValue);
};

const readOracleSettings = async (vaultClient) => {
  const [settingsValue, apiKey] = await Promise.all([
    readSetting(vaultClient, ORACLE_SETTINGS_KEY, defaultOracleSettings()),
    readSecret(vaultClient, ORACLE_OPENAI_API_KEY_SECRET)
  ]);
  return normalizeOracleSettings(settingsValue, apiKey);
};

const syncWardenLocalAiConfig = async (config, oracleSettings) => {
  const payload = {
    profileKey: oracleSettings.localAiProfileKey,
    imageMode: oracleSettings.localAiImageMode,
    customImage: oracleSettings.localAiCustomImage
  };
  return safeJson(serviceJson(config.wardenBaseUrl, "/api/localai/config", {
    method: "PUT",
    body: payload
  }));
};

const upsertUserFromDiscord = async ({vaultClient, config, identity}) => {
  const bootstrap = await vaultClient.getBootstrapStatus();
  const existing = await vaultClient.getUserByDiscordId(identity.discordUserId);

  if (!bootstrap.ownerClaimed) {
    if (!config.superuserId) {
      throw new Error("The instance does not have SUPERUSER_ID configured.");
    }
    if (identity.discordUserId !== config.superuserId) {
      throw new Error("This Discord account is not allowed to claim the first admin session.");
    }

    return vaultClient.upsertDiscordUser({
      ...identity,
      role: "owner",
      claimOwner: true
    });
  }

  if (existing) {
    return vaultClient.upsertDiscordUser({
      ...identity,
      role: existing.role,
      permissions: existing.permissions
    });
  }

  if (!config.autoProvisionDiscordUsers) {
    throw new Error("This Discord account is not provisioned for Scriptarr.");
  }

  return vaultClient.upsertDiscordUser({
    ...identity,
    role: "member"
  });
};

/**
 * Create the Scriptarr Sage Express application that brokers Moon-facing auth,
 * moderation, settings, and Warden orchestration routes.
 *
 * @returns {Promise<{app: import("express").Express, config: ReturnType<typeof resolveSageConfig>}>}
 */
export const createSageApp = async () => {
  const config = resolveSageConfig();
  const vaultClient = createVaultClient(config);
  const app = express();
  const requireUser = requireSession(vaultClient);

  app.use(express.json());

  app.get("/health", async (_req, res) => {
    const [vault, warden, portal, oracle, raven] = await Promise.all([
      safeJson(fetch(`${config.vaultBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.wardenBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.portalBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.oracleBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.ravenBaseUrl}/health`).then((response) => response.json()))
    ]);

    res.json({
      ok: true,
      service: "scriptarr-sage",
      callbackUrl: buildCallbackUrl(config),
      dependencies: {vault, warden, portal, oracle, raven}
    });
  });

  app.get("/api/auth/bootstrap-status", async (_req, res) => {
    const bootstrap = await vaultClient.getBootstrapStatus();
    res.json({
      ...bootstrap,
      callbackUrl: buildCallbackUrl(config),
      oauthConfigured: Boolean(config.discordClientId && config.discordClientSecret)
    });
  });

  app.get("/api/auth/discord/url", (_req, res) => {
    res.json({
      callbackUrl: buildCallbackUrl(config),
      oauthUrl: buildDiscordOauthUrl(config)
    });
  });

  app.post("/api/auth/claim", async (req, res) => {
    try {
      const identity = {
        discordUserId: String(req.body.discordUserId || "").trim(),
        username: String(req.body.username || "").trim() || "Scriptarr User",
        avatarUrl: req.body.avatarUrl || null
      };
      if (!identity.discordUserId) {
        res.status(400).json({error: "discordUserId is required."});
        return;
      }
      const user = await upsertUserFromDiscord({vaultClient, config, identity});
      const session = await vaultClient.createSession(user.discordUserId);
      res.json({token: session.token, user, callbackUrl: buildCallbackUrl(config)});
    } catch (error) {
      res.status(403).json({error: error instanceof Error ? error.message : String(error)});
    }
  });

  app.get("/api/auth/discord/callback", async (req, res) => {
    try {
      const mockDiscordUserId = String(req.query.mockDiscordUserId || "").trim();
      const identity = mockDiscordUserId
        ? {
          discordUserId: mockDiscordUserId,
          username: String(req.query.username || "Dev Discord User"),
          avatarUrl: null
        }
        : await exchangeDiscordCode(config, String(req.query.code || ""));

      const user = await upsertUserFromDiscord({vaultClient, config, identity});
      const session = await vaultClient.createSession(user.discordUserId);
      res.json({token: session.token, user});
    } catch (error) {
      res.status(403).json({error: error instanceof Error ? error.message : String(error)});
    }
  });

  app.get("/api/auth/status", requireUser, async (req, res) => {
    res.json({
      authenticated: true,
      user: req.user
    });
  });

  app.get("/api/library", requireUser, async (req, res) => {
    const progress = await vaultClient.getProgress(req.user.discordUserId);
    res.json({
      library: readerLibrary,
      progress
    });
  });

  app.get("/api/reader/progress", requireUser, async (req, res) => {
    res.json(await vaultClient.getProgress(req.user.discordUserId));
  });

  app.post("/api/reader/progress", requireUser, async (req, res) => {
    const payload = await vaultClient.upsertProgress({
      ...req.body,
      discordUserId: req.user.discordUserId
    });
    res.json(payload);
  });

  app.get("/api/requests", requireUser, async (_req, res) => {
    res.json(await vaultClient.listRequests());
  });

  app.post("/api/requests", requireUser, async (req, res) => {
    const canCreate = req.user.permissions.includes("create_requests") || req.user.permissions.includes("admin");
    if (!canCreate) {
      res.status(403).json({error: "You cannot create requests."});
      return;
    }

    const request = await vaultClient.createRequest({
      source: req.body.source || "moon",
      title: req.body.title,
      requestType: req.body.requestType || "manga",
      notes: req.body.notes || "",
      requestedBy: req.user.discordUserId
    });
    res.status(201).json(request);
  });

  app.post("/api/admin/requests/:id/review", requirePermission(vaultClient, "moderate_requests"), async (req, res) => {
    const reviewed = await vaultClient.reviewRequest(req.params.id, {
      status: req.body.status,
      comment: req.body.comment,
      actor: req.user.username
    });
    if (!reviewed) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    res.json(reviewed);
  });

  app.get("/api/admin/status", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    const [warden, portal, oracle, raven, ravenVpn, metadataProviders] = await Promise.all([
      loadWardenStatus(config.wardenBaseUrl),
      safeJson(fetch(`${config.portalBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.oracleBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.ravenBaseUrl}/health`).then((response) => response.json())),
      readRavenVpnSettings(vaultClient),
      readMetadataProviderSettings(vaultClient)
    ]);

    res.json({
      services: {
        warden: warden.health,
        portal,
        oracle,
        raven
      },
      summaries: {
        warden,
        ravenVpn,
        metadataProviders
      }
    });
  });

  app.get("/api/admin/metadata/providers", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    res.json(await readMetadataProviderSettings(vaultClient));
  });

  app.get("/api/admin/settings/raven/vpn", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    res.json(await readRavenVpnSettings(vaultClient));
  });

  app.put("/api/admin/settings/raven/vpn", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const password = normalizeString(req.body.piaPassword);
    const nextSettings = normalizeRavenVpnSettings(req.body, password || await readSecret(vaultClient, RAVEN_VPN_PASSWORD_SECRET));
    await vaultClient.setSetting(RAVEN_VPN_KEY, {
      key: RAVEN_VPN_KEY,
      enabled: nextSettings.enabled,
      region: nextSettings.region,
      piaUsername: nextSettings.piaUsername
    });
    if (password) {
      await vaultClient.setSecret(RAVEN_VPN_PASSWORD_SECRET, password);
    }
    res.json(await readRavenVpnSettings(vaultClient));
  });

  app.get("/api/admin/settings/raven/metadata", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    res.json(await readMetadataProviderSettings(vaultClient));
  });

  app.put("/api/admin/settings/raven/metadata", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const nextSettings = normalizeMetadataProviderSettings(req.body);
    await vaultClient.setSetting(RAVEN_METADATA_KEY, nextSettings);
    res.json(await readMetadataProviderSettings(vaultClient));
  });

  app.get("/api/admin/settings/oracle", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    res.json(await readOracleSettings(vaultClient));
  });

  app.put("/api/admin/settings/oracle", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const password = normalizeString(req.body.openAiApiKey);
    const nextSettings = normalizeOracleSettings(req.body, password || await readSecret(vaultClient, ORACLE_OPENAI_API_KEY_SECRET));
    await vaultClient.setSetting(ORACLE_SETTINGS_KEY, {
      key: ORACLE_SETTINGS_KEY,
      enabled: nextSettings.enabled,
      provider: nextSettings.provider,
      model: nextSettings.model,
      temperature: nextSettings.temperature,
      localAiProfileKey: nextSettings.localAiProfileKey,
      localAiImageMode: nextSettings.localAiImageMode,
      localAiCustomImage: nextSettings.localAiCustomImage
    });
    if (password) {
      await vaultClient.setSecret(ORACLE_OPENAI_API_KEY_SECRET, password);
    }
    const wardenSync = await syncWardenLocalAiConfig(config, nextSettings);
    res.json({
      ...(await readOracleSettings(vaultClient)),
      wardenSync: wardenSync.payload || wardenSync
    });
  });

  app.get("/api/admin/warden/localai", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    const [oracleSettings, localAiStatus] = await Promise.all([
      readOracleSettings(vaultClient),
      safeJson(serviceJson(config.wardenBaseUrl, "/api/localai/status"))
    ]);
    res.json({
      oracle: oracleSettings,
      warden: localAiStatus.payload || localAiStatus
    });
  });

  app.post("/api/admin/warden/localai/install", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    const oracleSettings = await readOracleSettings(vaultClient);
    await syncWardenLocalAiConfig(config, oracleSettings);
    const result = await safeJson(serviceJson(config.wardenBaseUrl, "/api/localai/actions/install", {
      method: "POST"
    }));
    res.status(result.status || 200).json(result.payload || result);
  });

  app.post("/api/admin/warden/localai/start", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    const oracleSettings = await readOracleSettings(vaultClient);
    await syncWardenLocalAiConfig(config, oracleSettings);
    const result = await safeJson(serviceJson(config.wardenBaseUrl, "/api/localai/actions/start", {
      method: "POST"
    }));
    res.status(result.status || 200).json(result.payload || result);
  });

  registerMoonV3Routes(app, {
    config,
    vaultClient,
    requireUser,
    requirePermission: (permission) => requirePermission(vaultClient, permission),
    readRavenVpnSettings: () => readRavenVpnSettings(vaultClient),
    readMetadataProviderSettings: () => readMetadataProviderSettings(vaultClient),
    readOracleSettings: () => readOracleSettings(vaultClient),
    serviceJson,
    safeJson
  });

  return {app, config};
};

