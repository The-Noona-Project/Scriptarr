/**
 * @file Scriptarr Sage module: services/sage/lib/createSageApp.mjs.
 */
import express from "express";
import {createLogger} from "@scriptarr/logging";
import {resolveSageConfig} from "./config.mjs";
import {createVaultClient} from "./vaultClient.mjs";
import {buildCallbackUrl, buildDiscordOauthUrl, exchangeDiscordCode} from "./discordAuth.mjs";
import {requirePermission, requireSession} from "./auth.mjs";
import {registerMoonV3Routes} from "./registerMoonV3Routes.mjs";
import {createServiceAuth} from "./serviceAuth.mjs";
import {registerInternalBrokerRoutes} from "./registerInternalBrokerRoutes.mjs";

const RAVEN_VPN_KEY = "raven.vpn";
const RAVEN_VPN_PASSWORD_SECRET = "raven.vpn.piaPassword";
const RAVEN_METADATA_KEY = "raven.metadata.providers";
const ORACLE_SETTINGS_KEY = "oracle.settings";
const ORACLE_OPENAI_API_KEY_SECRET = "oracle.openai.apiKey";
const MOON_BRANDING_KEY = "moon.branding";
const ORACLE_OPENAI_DEFAULT_MODEL = process.env.SCRIPTARR_ORACLE_OPENAI_MODEL || "gpt-4.1-mini";
const ORACLE_LOCALAI_DEFAULT_MODEL = "gpt-4";

const knownMetadataProviders = Object.freeze([
  {id: "mangadex", name: "MangaDex", scopes: ["manga", "webtoon"], enabled: true, priority: 10},
  {id: "anilist", name: "AniList", scopes: ["manga"], enabled: false, priority: 20},
  {id: "mangaupdates", name: "MangaUpdates", scopes: ["manga", "webtoon"], enabled: false, priority: 30},
  {id: "mal", name: "MyAnimeList", scopes: ["manga"], enabled: false, priority: 40, credentialKey: "malClientId"},
  {id: "comicvine", name: "ComicVine", scopes: ["comic"], enabled: false, priority: 50, credentialKey: "comicVineApiKey"}
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

const fetchJsonWithTimeout = async (url, timeoutMs = 1200) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  return response.json();
};

const loadWardenStatus = async (baseUrl) => {
  const [health, bootstrap, runtime] = await Promise.all([
    safeJson(fetchJsonWithTimeout(`${baseUrl}/health`)),
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

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const toLegacyLibraryEntry = (title = {}) => ({
  id: normalizeString(title.id),
  title: normalizeString(title.title, "Untitled"),
  type: normalizeString(title.mediaType || title.type, "manga"),
  status: normalizeString(title.status, "active"),
  latestChapter: normalizeString(title.latestChapter, "Unknown"),
  coverAccent: normalizeString(title.coverAccent, "#4f8f88")
});

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
  model: ORACLE_OPENAI_DEFAULT_MODEL,
  temperature: 0.2,
  localAiProfileKey: "nvidia",
  localAiImageMode: "preset",
  localAiCustomImage: "",
  openAiApiKeyConfigured: false
});

const defaultMoonBrandingSettings = () => ({
  key: MOON_BRANDING_KEY,
  siteName: "Scriptarr"
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
  const provider = ["openai", "localai"].includes(normalizeString(value?.provider, defaults.provider))
    ? normalizeString(value?.provider, defaults.provider)
    : defaults.provider;
  const model = normalizeString(
    value?.model,
    provider === "localai" ? ORACLE_LOCALAI_DEFAULT_MODEL : defaults.model
  );
  return {
    ...defaults,
    enabled: normalizeBoolean(value?.enabled, defaults.enabled),
    provider,
    model,
    temperature: Number.isFinite(temperature) ? temperature : defaults.temperature,
    localAiProfileKey: normalizeString(value?.localAiProfileKey, defaults.localAiProfileKey),
    localAiImageMode: ["preset", "custom"].includes(normalizeString(value?.localAiImageMode, defaults.localAiImageMode))
      ? normalizeString(value?.localAiImageMode, defaults.localAiImageMode)
      : defaults.localAiImageMode,
    localAiCustomImage: normalizeString(value?.localAiCustomImage, defaults.localAiCustomImage),
    openAiApiKeyConfigured: Boolean(secretValue)
  };
};

const normalizeMoonBrandingSettings = (value) => {
  const defaults = defaultMoonBrandingSettings();
  const siteName = normalizeString(value?.siteName, defaults.siteName).slice(0, 80).trim();
  return {
    ...defaults,
    siteName: siteName || defaults.siteName
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

const readMoonBrandingSettings = async (vaultClient) => {
  const settingsValue = await readSetting(vaultClient, MOON_BRANDING_KEY, defaultMoonBrandingSettings());
  return normalizeMoonBrandingSettings(settingsValue);
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

const loadLegacyLibrary = async (config) => {
  const result = await serviceJson(config.ravenBaseUrl, "/v1/library");
  if (!result.ok) {
    throw new Error(result.payload?.error || `Raven library request failed with status ${result.status}.`);
  }

  return normalizeArray(result.payload?.titles).map(toLegacyLibraryEntry);
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
 * @param {{
 *   logger?: {info: Function, warn: Function, error: Function}
 * }} [options]
 * @returns {Promise<{app: import("express").Express, config: ReturnType<typeof resolveSageConfig>}>}
 */
export const createSageApp = async ({logger = createLogger("SAGE")} = {}) => {
  const config = resolveSageConfig();
  const vaultClient = createVaultClient(config);
  const app = express();
  const requireUser = requireSession(vaultClient);
  const requireService = createServiceAuth(config);

  app.use(express.json());

  app.get("/health", async (_req, res) => {
    const [vault, warden, portal, oracle, raven] = await Promise.all([
      safeJson(fetchJsonWithTimeout(`${config.vaultBaseUrl}/health`)),
      safeJson(fetchJsonWithTimeout(`${config.wardenBaseUrl}/health`)),
      safeJson(fetchJsonWithTimeout(`${config.portalBaseUrl}/health`)),
      safeJson(fetchJsonWithTimeout(`${config.oracleBaseUrl}/health`)),
      safeJson(fetchJsonWithTimeout(`${config.ravenBaseUrl}/health`))
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

  app.get("/api/auth/discord/callback", async (req, res) => {
    try {
      const code = String(req.query.code || "").trim();
      if (!code) {
        res.status(400).json({error: "Discord OAuth code is required."});
        return;
      }
      const identity = await exchangeDiscordCode(config, code);
      const user = await upsertUserFromDiscord({vaultClient, config, identity});
      const session = await vaultClient.createSession(user.discordUserId);
      res.json({token: session.token, user});
    } catch (error) {
      logger.warn("Discord callback login failed.", {
        codePresent: Boolean(req.query.code),
        error
      });
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
    try {
      const [library, progress] = await Promise.all([
        loadLegacyLibrary(config),
        vaultClient.getProgress(req.user.discordUserId)
      ]);
      res.json({
        library,
        progress
      });
    } catch (error) {
      logger.warn("Legacy library load failed.", {
        discordUserId: req.user.discordUserId,
        error
      });
      res.status(502).json({error: error instanceof Error ? error.message : String(error)});
    }
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
      logger.warn("Request creation denied by policy.", {
        discordUserId: req.user.discordUserId,
        title: req.body?.title
      });
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
      logger.warn("Moderation target was not found.", {
        requestId: req.params.id,
        actor: req.user.username
      });
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

  app.get("/api/admin/settings/moon/branding", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    res.json(await readMoonBrandingSettings(vaultClient));
  });

  app.put("/api/admin/settings/moon/branding", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const nextSettings = normalizeMoonBrandingSettings(req.body);
    await vaultClient.setSetting(MOON_BRANDING_KEY, nextSettings);
    res.json(await readMoonBrandingSettings(vaultClient));
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

  app.get("/api/updates", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    const result = await serviceJson(config.wardenBaseUrl, "/api/updates");
    res.status(result.status).json(result.payload);
  });

  app.post("/api/updates/check", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const result = await serviceJson(config.wardenBaseUrl, "/api/updates/check", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    });
    res.status(result.status).json(result.payload);
  });

  app.post("/api/updates/install", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const result = await serviceJson(config.wardenBaseUrl, "/api/updates/install", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    });
    res.status(result.status).json(result.payload);
  });

  registerInternalBrokerRoutes(app, {
    config,
    vaultClient,
    requireService,
    serviceJson
  });

  registerMoonV3Routes(app, {
    config,
    logger,
    vaultClient,
    requireUser,
    requirePermission: (permission) => requirePermission(vaultClient, permission),
    readRavenVpnSettings: () => readRavenVpnSettings(vaultClient),
    readMetadataProviderSettings: () => readMetadataProviderSettings(vaultClient),
    readOracleSettings: () => readOracleSettings(vaultClient),
    readMoonBrandingSettings: () => readMoonBrandingSettings(vaultClient),
    serviceJson,
    safeJson
  });

  logger.info("Sage app initialized.", {
    publicBaseUrl: config.publicBaseUrl
  });

  return {app, config};
};

