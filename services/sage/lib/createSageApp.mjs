/**
 * @file Scriptarr Sage module: services/sage/lib/createSageApp.mjs.
 */
import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import express from "express";
import {createLogger} from "@scriptarr/logging";
import {resolveSageConfig} from "./config.mjs";
import {createVaultClient} from "./vaultClient.mjs";
import {buildCallbackUrl, buildDiscordOauthUrl, exchangeDiscordCode} from "./discordAuth.mjs";
import {requirePermission, requireSession} from "./auth.mjs";
import {registerMoonV3Routes} from "./registerMoonV3Routes.mjs";
import {createServiceAuth} from "./serviceAuth.mjs";
import {registerInternalBrokerRoutes} from "./registerInternalBrokerRoutes.mjs";
import {buildIntakeSelection, evaluateSelectionAgainstGuardState} from "./requestSelectionGuards.mjs";
import {
  PORTAL_DISCORD_KEY,
  knownPortalDiscordCommands,
  normalizePortalDiscordSettings,
  readPortalDiscordSettings,
  renderPortalOnboardingTemplate
} from "./portalDiscordSettings.mjs";

const RAVEN_VPN_KEY = "raven.vpn";
const RAVEN_VPN_PASSWORD_SECRET = "raven.vpn.piaPassword";
const RAVEN_METADATA_KEY = "raven.metadata.providers";
const RAVEN_DOWNLOAD_PROVIDERS_KEY = "raven.download.providers";
const ORACLE_SETTINGS_KEY = "oracle.settings";
const ORACLE_OPENAI_API_KEY_SECRET = "oracle.openai.apiKey";
const MOON_BRANDING_KEY = "moon.branding";
const MOON_PUBLIC_API_KEY = "moon.publicApi";
const MOON_PUBLIC_API_HASH_SECRET = "moon.publicApi.keyHash";
const ORACLE_OPENAI_DEFAULT_MODEL = process.env.SCRIPTARR_ORACLE_OPENAI_MODEL || "gpt-4.1-mini";
const ORACLE_LOCALAI_DEFAULT_MODEL = "gpt-4";
const PUBLIC_API_SELECTION_TTL_MS = 5 * 60 * 1000;

const knownMetadataProviders = Object.freeze([
  {id: "mangadex", name: "MangaDex", scopes: ["manga", "webtoon"], enabled: true, priority: 10},
  {id: "anilist", name: "AniList", scopes: ["manga"], enabled: false, priority: 20},
  {id: "mangaupdates", name: "MangaUpdates", scopes: ["manga", "webtoon"], enabled: false, priority: 30},
  {id: "mal", name: "MyAnimeList", scopes: ["manga"], enabled: false, priority: 40, credentialKey: "malClientId"},
  {id: "comicvine", name: "ComicVine", scopes: ["comic"], enabled: false, priority: 50, credentialKey: "comicVineApiKey"}
]);
const knownDownloadProviders = Object.freeze([
  {id: "weebcentral", name: "WeebCentral", scopes: ["manga", "webtoon", "comic"], enabled: true, priority: 10}
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
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

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
const defaultDownloadProviderSettings = () => ({
  key: RAVEN_DOWNLOAD_PROVIDERS_KEY,
  providers: knownDownloadProviders.map((provider) => ({...provider}))
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
const defaultMoonPublicApiSettings = () => ({
  key: MOON_PUBLIC_API_KEY,
  enabled: false,
  keyConfigured: false,
  lastRotatedAt: null
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
const normalizeDownloadProviderSettings = (value) => {
  const requested = Array.isArray(value?.providers) ? value.providers : [];
  const requestedById = new Map(requested.map((entry) => [normalizeProviderId(entry?.id), entry]));

  return {
    key: RAVEN_DOWNLOAD_PROVIDERS_KEY,
    providers: knownDownloadProviders
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

const normalizeMoonPublicApiSettings = (value, hashValue) => {
  const defaults = defaultMoonPublicApiSettings();
  const rotatedAt = normalizeString(value?.lastRotatedAt);
  return {
    ...defaults,
    enabled: normalizeBoolean(value?.enabled, defaults.enabled),
    keyConfigured: Boolean(hashValue),
    lastRotatedAt: rotatedAt || null
  };
};

const hashPublicApiKey = (value) => createHash("sha256").update(normalizeString(value)).digest("hex");

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
const readDownloadProviderSettings = async (vaultClient) => {
  const settingsValue = await readSetting(vaultClient, RAVEN_DOWNLOAD_PROVIDERS_KEY, defaultDownloadProviderSettings());
  return normalizeDownloadProviderSettings(settingsValue);
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

const readMoonPublicApiSettings = async (vaultClient) => {
  const [settingsValue, apiKeyHash] = await Promise.all([
    readSetting(vaultClient, MOON_PUBLIC_API_KEY, defaultMoonPublicApiSettings()),
    readSecret(vaultClient, MOON_PUBLIC_API_HASH_SECRET)
  ]);
  return normalizeMoonPublicApiSettings(settingsValue, apiKeyHash);
};

const loadPortalDiscordRuntime = async (config, settings) => {
  const [health, commands] = await Promise.all([
    safeJson(fetchJsonWithTimeout(`${config.portalBaseUrl}/health`)),
    safeJson(serviceJson(config.portalBaseUrl, "/api/commands"))
  ]);
  const healthPayload = health?.payload || health;

  return {
    authConfigured: Boolean(config.discordClientId && config.discordClientSecret),
    botTokenConfigured: Boolean(config.discordToken),
    configuredGuildId: settings.guildId,
    connected: Boolean(healthPayload?.runtime?.connected ?? healthPayload?.connected),
    connectionState: normalizeString(healthPayload?.runtime?.connectionState, normalizeString(healthPayload?.discord, "degraded")),
    registeredGuildId: normalizeString(healthPayload?.runtime?.registeredGuildId, settings.guildId),
    error: normalizeString(healthPayload?.runtime?.error),
    syncError: normalizeString(healthPayload?.runtime?.syncError),
    warning: normalizeString(healthPayload?.runtime?.warning),
    capabilities: healthPayload?.runtime?.capabilities || {},
    portal: healthPayload,
    commandInventory: normalizeArray(commands?.payload?.commands || commands?.commands).length > 0
      ? normalizeArray(commands?.payload?.commands || commands?.commands)
      : knownPortalDiscordCommands
  };
};

const portalInternalHeaders = (config) => {
  const sageToken = config.serviceTokens?.["scriptarr-sage"];
  return sageToken ? {"Authorization": `Bearer ${sageToken}`} : {};
};

const reloadPortalDiscordRuntime = async (config) => safeJson(serviceJson(config.portalBaseUrl, "/api/runtime/discord/reload", {
  method: "POST",
  headers: portalInternalHeaders(config),
  body: {}
}));

const sendPortalOnboardingTest = async (config, payload) => safeJson(serviceJson(config.portalBaseUrl, "/api/onboarding/test", {
  method: "POST",
  headers: portalInternalHeaders(config),
  body: payload
}));

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
  const publicSelectionTokens = new Map();

  app.use(express.json());

  const purgeExpiredPublicSelectionTokens = () => {
    const now = Date.now();
    for (const [token, entry] of publicSelectionTokens.entries()) {
      if (!entry || Number(entry.expiresAt || 0) <= now) {
        publicSelectionTokens.delete(token);
      }
    }
  };

  const issuePublicSelectionToken = (payload) => {
    purgeExpiredPublicSelectionTokens();
    const token = randomBytes(24).toString("hex");
    publicSelectionTokens.set(token, {
      ...payload,
      expiresAt: Date.now() + PUBLIC_API_SELECTION_TTL_MS
    });
    return token;
  };

  const readPublicSelectionToken = (token) => {
    purgeExpiredPublicSelectionTokens();
    const entry = publicSelectionTokens.get(normalizeString(token));
    if (!entry) {
      return null;
    }
    if (Number(entry.expiresAt || 0) <= Date.now()) {
      publicSelectionTokens.delete(normalizeString(token));
      return null;
    }
    return entry;
  };

  const deletePublicSelectionToken = (token) => {
    publicSelectionTokens.delete(normalizeString(token));
  };

  const normalizePublicRequestSummary = (request = {}) => {
    const details = normalizeObject(request.details, {}) || {};
    const selectedMetadata = normalizeObject(details.selectedMetadata);
    const selectedDownload = normalizeObject(details.selectedDownload);
    return {
      id: request.id,
      source: normalizeString(request.source),
      title: normalizeString(request.title, "Untitled request"),
      requestType: normalizeString(request.requestType, "manga"),
      status: normalizeString(request.status, "pending"),
      availability: normalizeString(details.availability, selectedDownload?.titleUrl ? "available" : "unavailable"),
      notes: normalizeString(request.notes),
      query: normalizeString(details.query),
      coverUrl: normalizeString(details.coverUrl, normalizeString(selectedDownload?.coverUrl, normalizeString(selectedMetadata?.coverUrl))),
      jobId: normalizeString(details.jobId),
      taskId: normalizeString(details.taskId),
      createdAt: request.createdAt || null,
      updatedAt: request.updatedAt || null
    };
  };

  const loadPublicApiGuardState = async () => {
    const [libraryResult, requests, taskResult] = await Promise.all([
      serviceJson(config.ravenBaseUrl, "/v1/library"),
      vaultClient.listRequests(),
      serviceJson(config.ravenBaseUrl, "/v1/downloads/tasks")
    ]);

    return {
      libraryTitles: normalizeArray(libraryResult.payload?.titles),
      requests: normalizeArray(requests),
      tasks: normalizeArray(taskResult.payload)
    };
  };

  const buildPublicApiSelection = (entry, guardState) => {
    const metadata = normalizeObject(entry.metadata, {}) || {};
    const download = normalizeObject(entry.download);
    const selection = {
      ...buildIntakeSelection({
        ...entry,
        metadata,
        download
      }),
      nsfw: Boolean(download?.nsfw || metadata?.nsfw || metadata?.details?.adultContent || entry.nsfw)
    };
    const {
      alreadyInLibrary,
      alreadyQueuedOrRequested
    } = evaluateSelectionAgainstGuardState(selection, guardState);

    return {
      ...selection,
      metadataProviderId: normalizeString(entry.metadataProviderId, metadata.provider),
      providerSeriesId: normalizeString(entry.providerSeriesId, metadata.providerSeriesId),
      aliases: normalizeArray(entry.aliases || metadata.aliases),
      titleUrl: normalizeString(download?.titleUrl),
      downloadProviderId: normalizeString(entry.downloadProviderId, download?.providerId),
      alreadyInLibrary,
      alreadyQueuedOrRequested,
      selectionToken: issuePublicSelectionToken(selection)
    };
  };

  const hasValidPublicApiKey = async (presentedKey) => {
    const storedHash = normalizeString(await readSecret(vaultClient, MOON_PUBLIC_API_HASH_SECRET));
    const normalizedKey = normalizeString(presentedKey);
    if (!storedHash || !normalizedKey) {
      return false;
    }
    const presentedHash = hashPublicApiKey(normalizedKey);
    const storedBuffer = Buffer.from(storedHash, "utf8");
    const presentedBuffer = Buffer.from(presentedHash, "utf8");
    return storedBuffer.length === presentedBuffer.length && timingSafeEqual(storedBuffer, presentedBuffer);
  };

  const requirePublicApiKey = async (req, res, next) => {
    const settings = await readMoonPublicApiSettings(vaultClient);
    if (!settings.enabled) {
      res.status(503).json({error: "The public Moon API is disabled."});
      return;
    }

    const apiKey = req.get("X-Scriptarr-Api-Key");
    if (!(await hasValidPublicApiKey(apiKey))) {
      res.status(401).json({error: "A valid X-Scriptarr-Api-Key header is required."});
      return;
    }

    await next();
  };

  const publicOpenApiDocument = () => ({
    openapi: "3.1.0",
    info: {
      title: "Scriptarr Moon Public API",
      version: "1.0.0",
      description: "Trusted automation API for safe Scriptarr search and queued title requests."
    },
    servers: [{url: "/"}],
    components: {
      securitySchemes: {
        ScriptarrApiKey: {
          type: "apiKey",
          in: "header",
          name: "X-Scriptarr-Api-Key"
        }
      },
      schemas: {
        SearchResult: {
          type: "object",
          properties: {
            canonicalTitle: {type: "string"},
            requestType: {type: "string"},
            coverUrl: {type: "string"},
            nsfw: {type: "boolean"},
            alreadyInLibrary: {type: "boolean"},
            alreadyQueuedOrRequested: {type: "boolean"},
            availability: {type: "string"},
            selectionToken: {type: "string"}
          }
        }
      }
    },
    paths: {
      "/api/public/v1/search": {
        get: {
          summary: "Search intake results",
          parameters: [{name: "q", in: "query", required: true, schema: {type: "string"}}],
          responses: {"200": {description: "Search results"}}
        }
      },
      "/api/public/v1/requests": {
        post: {
          summary: "Queue a safe external request",
          security: [{ScriptarrApiKey: []}],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["selectionToken"],
                  properties: {
                    selectionToken: {type: "string"},
                    notes: {type: "string"}
                  }
                }
              }
            }
          },
          responses: {"202": {description: "Queued request"}}
        }
      },
      "/api/public/v1/requests/{requestId}": {
        get: {
          summary: "Poll an external request",
          security: [{ScriptarrApiKey: []}],
          parameters: [{name: "requestId", in: "path", required: true, schema: {type: "string"}}],
          responses: {"200": {description: "Request status"}}
        }
      }
    }
  });

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

    const selection = buildIntakeSelection({
      query: normalizeString(req.body?.query),
      title: normalizeString(req.body?.title),
      requestType: normalizeString(req.body?.requestType),
      selectedMetadata: normalizeObject(req.body?.selectedMetadata),
      selectedDownload: normalizeObject(req.body?.selectedDownload)
    });
    const guardState = await loadPublicApiGuardState();
    const guard = evaluateSelectionAgainstGuardState(selection, guardState);
    if (guard.alreadyInLibrary) {
      res.status(409).json({error: "That title is already in the Scriptarr library."});
      return;
    }
    if (guard.alreadyQueuedOrRequested) {
      res.status(409).json({error: "That title is already queued or has an active request."});
      return;
    }

    const request = await vaultClient.createRequest({
      source: req.body.source || "moon",
      title: normalizeString(req.body?.selectedMetadata?.title, req.body.title),
      requestType: normalizeString(req.body?.requestType || req.body?.selectedDownload?.requestType || req.body?.selectedMetadata?.type || "manga", "manga"),
      notes: normalizeString(req.body.notes),
      requestedBy: req.user.discordUserId,
      status: normalizeObject(req.body?.selectedDownload)?.titleUrl ? "pending" : "unavailable",
      details: {
        query: normalizeString(req.body?.query),
        selectedMetadata: normalizeObject(req.body?.selectedMetadata),
        selectedDownload: normalizeObject(req.body?.selectedDownload),
        availability: normalizeObject(req.body?.selectedDownload)?.titleUrl ? "available" : "unavailable"
      }
    });
    res.status(201).json(request);
  });

  app.post("/api/admin/requests/:id/review", requirePermission(vaultClient, "moderate_requests"), async (req, res) => {
    const request = await vaultClient.getRequest(req.params.id);
    if (!request) {
      logger.warn("Moderation target was not found.", {
        requestId: req.params.id,
        actor: req.user.username
      });
      res.status(404).json({error: "Request not found."});
      return;
    }

    if (normalizeString(req.body.status) === "approved") {
      const selectedDownload = normalizeObject(request.details?.selectedDownload);
      if (!selectedDownload?.titleUrl) {
        res.status(409).json({error: "This request is unavailable and must be resolved with a concrete download match before it can be approved."});
        return;
      }

      const guardState = await loadPublicApiGuardState();
      const guard = evaluateSelectionAgainstGuardState(buildIntakeSelection({
        title: request.title,
        requestType: request.requestType,
        selectedMetadata: normalizeObject(request.details?.selectedMetadata),
        selectedDownload
      }), guardState, {ignoreRequestId: req.params.id});
      if (guard.alreadyInLibrary) {
        res.status(409).json({error: "That title is already in the Scriptarr library."});
        return;
      }
      if (guard.alreadyQueuedOrRequested) {
        res.status(409).json({error: "That title is already queued or has an active request."});
        return;
      }

      const queued = await serviceJson(config.ravenBaseUrl, "/v1/downloads/queue", {
        method: "POST",
        body: {
          titleName: normalizeString(selectedDownload.titleName, request.title),
          titleUrl: normalizeString(selectedDownload.titleUrl),
          requestType: normalizeString(selectedDownload.requestType, request.requestType),
          providerId: normalizeString(selectedDownload.providerId),
          requestId: String(request.id),
          requestedBy: request.requestedBy,
          selectedMetadata: normalizeObject(request.details?.selectedMetadata, {}),
          selectedDownload
        }
      });
      if (!queued.ok) {
        res.status(queued.status).json(queued.payload);
        return;
      }

      await vaultClient.updateRequest(req.params.id, {
        status: "queued",
        eventType: "approved",
        eventMessage: normalizeString(req.body.comment, "Approved from Moon admin."),
        moderatorComment: normalizeString(req.body.comment),
        actor: req.user.username,
        appendStatusEvent: false,
        detailsMerge: {
          availability: "available",
          selectedMetadata: normalizeObject(request.details?.selectedMetadata, {}),
          selectedDownload,
          jobId: normalizeString(queued.payload?.jobId),
          taskId: normalizeString(queued.payload?.taskId)
        }
      });
      res.json(await vaultClient.getRequest(req.params.id));
      return;
    }

    const reviewed = await vaultClient.reviewRequest(req.params.id, {
      status: req.body.status,
      comment: req.body.comment,
      actor: req.user.username
    });
    res.json(reviewed);
  });

  app.get("/api/admin/status", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    const [warden, portal, oracle, raven, ravenVpn, metadataProviders, downloadProviders] = await Promise.all([
      loadWardenStatus(config.wardenBaseUrl),
      safeJson(fetch(`${config.portalBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.oracleBaseUrl}/health`).then((response) => response.json())),
      safeJson(fetch(`${config.ravenBaseUrl}/health`).then((response) => response.json())),
      readRavenVpnSettings(vaultClient),
      readMetadataProviderSettings(vaultClient),
      readDownloadProviderSettings(vaultClient)
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
        metadataProviders,
        downloadProviders
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

  app.get("/api/admin/settings/raven/download-providers", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    res.json(await readDownloadProviderSettings(vaultClient));
  });

  app.put("/api/admin/settings/raven/download-providers", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const nextSettings = normalizeDownloadProviderSettings(req.body);
    await vaultClient.setSetting(RAVEN_DOWNLOAD_PROVIDERS_KEY, nextSettings);
    res.json(await readDownloadProviderSettings(vaultClient));
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

  app.get("/api/admin/settings/moon/public-api", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    res.json(await readMoonPublicApiSettings(vaultClient));
  });

  app.put("/api/admin/settings/moon/public-api", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const existing = await readMoonPublicApiSettings(vaultClient);
    const nextSettings = normalizeMoonPublicApiSettings({
      ...existing,
      enabled: normalizeBoolean(req.body?.enabled, existing.enabled),
      lastRotatedAt: existing.lastRotatedAt
    }, await readSecret(vaultClient, MOON_PUBLIC_API_HASH_SECRET));
    await vaultClient.setSetting(MOON_PUBLIC_API_KEY, {
      key: MOON_PUBLIC_API_KEY,
      enabled: nextSettings.enabled,
      lastRotatedAt: nextSettings.lastRotatedAt
    });
    res.json(await readMoonPublicApiSettings(vaultClient));
  });

  app.post("/api/admin/settings/moon/public-api/key", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    const nextApiKey = randomBytes(24).toString("hex");
    const nextSettings = {
      ...(await readMoonPublicApiSettings(vaultClient)),
      enabled: true,
      lastRotatedAt: new Date().toISOString()
    };
    await Promise.all([
      vaultClient.setSecret(MOON_PUBLIC_API_HASH_SECRET, hashPublicApiKey(nextApiKey)),
      vaultClient.setSetting(MOON_PUBLIC_API_KEY, {
        key: MOON_PUBLIC_API_KEY,
        enabled: nextSettings.enabled,
        lastRotatedAt: nextSettings.lastRotatedAt
      })
    ]);
    res.json({
      ...(await readMoonPublicApiSettings(vaultClient)),
      apiKey: nextApiKey
    });
  });

  app.get("/api/admin/settings/portal/discord", requirePermission(vaultClient, "manage_settings"), async (_req, res) => {
    const settings = await readPortalDiscordSettings(vaultClient);
    const runtime = await loadPortalDiscordRuntime(config, settings);
    res.json({
      ...settings,
      runtime
    });
  });

  app.put("/api/admin/settings/portal/discord", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const nextSettings = normalizePortalDiscordSettings(req.body);
    await vaultClient.setSetting(PORTAL_DISCORD_KEY, nextSettings);
    const reload = await reloadPortalDiscordRuntime(config);
    const settings = await readPortalDiscordSettings(vaultClient);
    const runtime = await loadPortalDiscordRuntime(config, settings);
    res.json({
      ...settings,
      runtime: {
        ...runtime,
        reload: reload.payload || reload
      }
    });
  });

  app.post("/api/admin/settings/portal/discord/onboarding/test", requirePermission(vaultClient, "manage_settings"), async (req, res) => {
    const [discordSettings, branding] = await Promise.all([
      readPortalDiscordSettings(vaultClient),
      readMoonBrandingSettings(vaultClient)
    ]);
    const previewSettings = normalizePortalDiscordSettings({
      ...discordSettings,
      ...normalizeObject(req.body),
      onboarding: {
        ...discordSettings.onboarding,
        ...normalizeObject(req.body?.onboarding)
      }
    });
    const username = normalizeString(req.body?.username, "Discord Reader");
    const rendered = renderPortalOnboardingTemplate({
      template: previewSettings.onboarding.template,
      username,
      userMention: req.body?.userMention,
      siteName: branding.siteName,
      guildName: normalizeString(req.body?.guildName, "Moon Admin Preview"),
      guildId: previewSettings.guildId,
      moonUrl: config.publicBaseUrl
    });
    const portal = await sendPortalOnboardingTest(config, {
      username,
      settings: previewSettings,
      branding,
      rendered
    });

    if (!portal.ok) {
      res.status(portal.status || 503).json({
        error: portal.payload?.error || "Portal could not send the onboarding test.",
        rendered,
        preview: {
          username,
          siteName: branding.siteName,
          guildId: previewSettings.guildId,
          channelId: previewSettings.onboarding.channelId
        }
      });
      return;
    }

    res.json({
      rendered,
      preview: {
        username,
        siteName: branding.siteName,
        guildId: previewSettings.guildId,
        channelId: previewSettings.onboarding.channelId
      },
      portal: portal.payload || portal
    });
  });

  app.get("/api/public/openapi.json", async (_req, res) => {
    res.json(publicOpenApiDocument());
  });

  app.get("/api/public/v1/search", async (req, res) => {
    const query = normalizeString(req.query.q);
    if (!query) {
      res.json({query: "", results: []});
      return;
    }

    const [intakeResult, guardState] = await Promise.all([
      serviceJson(config.ravenBaseUrl, `/v1/intake/search?query=${encodeURIComponent(query)}`),
      loadPublicApiGuardState()
    ]);
    if (!intakeResult.ok) {
      res.status(intakeResult.status).json(intakeResult.payload);
      return;
    }

    const results = normalizeArray(intakeResult.payload?.results).map((entry) => buildPublicApiSelection({
      ...entry,
      query
    }, guardState));

    res.json({
      query,
      results
    });
  });

  app.post("/api/public/v1/requests", requirePublicApiKey, async (req, res) => {
    const selectionToken = normalizeString(req.body?.selectionToken);
    const selection = readPublicSelectionToken(selectionToken);
    if (!selection) {
      res.status(410).json({error: "That selection token is missing or expired. Search again to queue a title."});
      return;
    }

    const guardState = await loadPublicApiGuardState();
    const {
      alreadyInLibrary,
      alreadyQueuedOrRequested
    } = evaluateSelectionAgainstGuardState(selection, guardState);

    if (selection.nsfw) {
      res.status(409).json({error: "NSFW titles are blocked from the public Moon API."});
      return;
    }
    if (alreadyInLibrary) {
      res.status(409).json({error: "That title is already in the Scriptarr library."});
      return;
    }
    if (alreadyQueuedOrRequested) {
      res.status(409).json({error: "That title is already queued or has an active request."});
      return;
    }
    if (!normalizeString(selection.selectedDownload?.titleUrl)) {
      res.status(409).json({error: "That title does not have an enabled downloadable source right now."});
      return;
    }

    const request = await vaultClient.createRequest({
      source: "external_api",
      title: selection.canonicalTitle,
      requestType: selection.requestType,
      notes: normalizeString(req.body?.notes),
      requestedBy: "external-api",
      status: "pending",
      details: {
        query: selection.query,
        selectedMetadata: selection.selectedMetadata,
        selectedDownload: selection.selectedDownload,
        availability: "available",
        coverUrl: selection.coverUrl
      }
    });

    const queued = await serviceJson(config.ravenBaseUrl, "/v1/downloads/queue", {
      method: "POST",
      body: {
        titleName: normalizeString(selection.selectedDownload?.titleName, selection.canonicalTitle),
        titleUrl: normalizeString(selection.selectedDownload?.titleUrl),
        requestType: selection.requestType,
        providerId: normalizeString(selection.selectedDownload?.providerId),
        requestId: String(request.id),
        requestedBy: "external-api",
        priority: "low",
        selectedMetadata: selection.selectedMetadata,
        selectedDownload: selection.selectedDownload
      }
    });

    if (!queued.ok) {
      await vaultClient.updateRequest(request.id, {
        status: "failed",
        actor: "scriptarr-public-api",
        eventType: "failed",
        eventMessage: normalizeString(queued.payload?.error, "External API queue failed."),
        appendStatusEvent: false,
        detailsMerge: {
          coverUrl: selection.coverUrl
        }
      });
      res.status(queued.status).json(queued.payload);
      return;
    }

    deletePublicSelectionToken(selectionToken);
    await vaultClient.updateRequest(request.id, {
      status: "queued",
      actor: "scriptarr-public-api",
      eventType: "approved",
      eventMessage: "Queued from the public Moon API.",
      appendStatusEvent: false,
      detailsMerge: {
        availability: "available",
        selectedMetadata: selection.selectedMetadata,
        selectedDownload: selection.selectedDownload,
        coverUrl: selection.coverUrl,
        jobId: normalizeString(queued.payload?.jobId),
        taskId: normalizeString(queued.payload?.taskId)
      }
    });

    res.status(202).json({
      request: normalizePublicRequestSummary(await vaultClient.getRequest(request.id))
    });
  });

  app.get("/api/public/v1/requests/:id", requirePublicApiKey, async (req, res) => {
    const request = await vaultClient.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    res.json({request: normalizePublicRequestSummary(request)});
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
    readDownloadProviderSettings: () => readDownloadProviderSettings(vaultClient),
    readOracleSettings: () => readOracleSettings(vaultClient),
    readMoonBrandingSettings: () => readMoonBrandingSettings(vaultClient),
    readMoonPublicApiSettings: () => readMoonPublicApiSettings(vaultClient),
    readPortalDiscordSettings: () => readPortalDiscordSettings(vaultClient),
    serviceJson,
    safeJson
  });

  logger.info("Sage app initialized.", {
    publicBaseUrl: config.publicBaseUrl
  });

  return {app, config};
};

