/**
 * @file Scriptarr Sage module: services/sage/lib/createSageApp.mjs.
 */
import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import express from "express";
import {createLogger} from "@scriptarr/logging";
import {resolveSageConfig} from "./config.mjs";
import {createVaultClient} from "./vaultClient.mjs";
import {
  buildCallbackUrl,
  buildDiscordOauthUrl,
  exchangeDiscordCode,
  parseDiscordOauthState,
  sanitizeReturnToPath
} from "./discordAuth.mjs";
import {hasPermission, requireAdminGrant, requirePermission, requireSession} from "./auth.mjs";
import {appendUserEvent} from "./adminEvents.mjs";
import {
  ADMIN_TOAST_GLOBAL_KEY,
  MOON_BRANDING_KEY,
  adminToastUserKey,
  defaultAdminToastSettings,
  defaultMoonBrandingSettings,
  mergeAdminToastSettings,
  normalizeAdminToastSettings,
  normalizeMoonBrandingSettings
} from "./adminUiSettings.mjs";
import {registerMoonV3Routes} from "./registerMoonV3Routes.mjs";
import {createServiceAuth} from "./serviceAuth.mjs";
import {registerInternalBrokerRoutes} from "./registerInternalBrokerRoutes.mjs";
import {buildIntakeSelection, evaluateSelectionAgainstGuardState} from "./requestSelectionGuards.mjs";
import {buildRequestWorkConflictPayload, isRequestWorkConflictError} from "./requestConflict.mjs";
import {createSystemTaskRuntime} from "./systemTaskRuntime.mjs";
import {
  RAVEN_DOWNLOAD_RUNTIME_KEY,
  normalizeRavenDownloadRuntimeSettings
} from "./ravenDownloadRuntimeSettings.mjs";
import {
  PORTAL_DISCORD_KEY,
  knownPortalDiscordCommands,
  normalizePortalDiscordSettings,
  readPortalDiscordSettings,
  renderPortalOnboardingTemplate
} from "./portalDiscordSettings.mjs";

const RAVEN_VPN_KEY = "raven.vpn";
const RAVEN_VPN_PASSWORD_SECRET = "raven.vpn.piaPassword";
const RAVEN_NAMING_KEY = "raven.naming";
const RAVEN_METADATA_KEY = "raven.metadata.providers";
const RAVEN_DOWNLOAD_PROVIDERS_KEY = "raven.download.providers";
const SAGE_REQUESTS_KEY = "sage.requests";
const ORACLE_SETTINGS_KEY = "oracle.settings";
const ORACLE_OPENAI_API_KEY_SECRET = "oracle.openai.apiKey";
const MOON_PUBLIC_API_KEY = "moon.publicApi";
const MOON_PUBLIC_API_HASH_SECRET = "moon.publicApi.keyHash";
const ORACLE_OPENAI_DEFAULT_MODEL = process.env.SCRIPTARR_ORACLE_OPENAI_MODEL || "gpt-4.1-mini";
const ORACLE_LOCALAI_DEFAULT_MODEL = "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf";
const PUBLIC_API_SELECTION_TTL_MS = 5 * 60 * 1000;
const INTERNAL_JSON_BODY_LIMIT = "10mb";

const knownMetadataProviders = Object.freeze([
  {id: "mangadex", name: "MangaDex", scopes: ["manga", "webtoon"], enabled: true, priority: 10},
  {id: "anilist", name: "AniList", scopes: ["manga"], enabled: false, priority: 20},
  {id: "animeplanet", name: "Anime-Planet", scopes: ["manga", "webtoon"], enabled: true, priority: 25},
  {id: "mangaupdates", name: "MangaUpdates", scopes: ["manga", "webtoon"], enabled: false, priority: 30},
  {id: "mal", name: "MyAnimeList", scopes: ["manga"], enabled: false, priority: 40, credentialKey: "malClientId"},
  {id: "comicvine", name: "ComicVine", scopes: ["comic"], enabled: false, priority: 50, credentialKey: "comicVineApiKey"}
]);
const knownDownloadProviders = Object.freeze([
  {id: "weebcentral", name: "WeebCentral", scopes: ["manga", "webtoon", "comic"], enabled: true, priority: 10},
  {id: "mangadex", name: "MangaDex", scopes: ["manga", "webtoon"], enabled: true, priority: 20}
]);
const knownNamingProfileTypes = Object.freeze([
  {id: "manga", name: "Manga"},
  {id: "manhwa", name: "Manhwa"},
  {id: "manhua", name: "Manhua"},
  {id: "webtoon", name: "Webtoon"},
  {id: "comic", name: "Comic"},
  {id: "oel", name: "OEL"}
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
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : 0;
  const response = await fetch(`${baseUrl}${servicePath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body == null ? undefined : JSON.stringify(options.body),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
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

const defaultRavenNamingProfile = () => ({
  chapterTemplate: "{title} c{chapter_padded} (v{volume_padded}) [Scriptarr].cbz",
  pageTemplate: "{page_padded}{ext}",
  pagePad: 3,
  chapterPad: 3,
  volumePad: 2
});

const defaultRavenNamingSettings = () => {
  const defaults = defaultRavenNamingProfile();
  return {
    key: RAVEN_NAMING_KEY,
    ...defaults,
    profiles: Object.fromEntries(knownNamingProfileTypes.map((type) => [type.id, {...defaults}]))
  };
};

const defaultMetadataProviderSettings = () => ({
  key: RAVEN_METADATA_KEY,
  providers: knownMetadataProviders.map((provider) => ({...provider}))
});
const defaultDownloadProviderSettings = () => ({
  key: RAVEN_DOWNLOAD_PROVIDERS_KEY,
  providers: knownDownloadProviders.map((provider) => ({...provider}))
});
const defaultRavenDownloadRuntimeSettings = () => normalizeRavenDownloadRuntimeSettings({
  key: RAVEN_DOWNLOAD_RUNTIME_KEY
});
const defaultRequestWorkflowSettings = () => ({
  key: SAGE_REQUESTS_KEY,
  autoApproveAndDownload: false
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
const normalizeRequestWorkflowSettings = (value) => {
  const defaults = defaultRequestWorkflowSettings();
  return {
    ...defaults,
    autoApproveAndDownload: normalizeBoolean(value?.autoApproveAndDownload, defaults.autoApproveAndDownload)
  };
};

const normalizeRavenNamingProfile = (value, fallback = defaultRavenNamingProfile()) => {
  const chapterTemplate = normalizeString(value?.chapterTemplate, fallback.chapterTemplate);
  const pageTemplate = normalizeString(value?.pageTemplate, fallback.pageTemplate);
  const pagePad = Number.parseInt(String(value?.pagePad ?? fallback.pagePad), 10);
  const chapterPad = Number.parseInt(String(value?.chapterPad ?? fallback.chapterPad), 10);
  const volumePad = Number.parseInt(String(value?.volumePad ?? fallback.volumePad), 10);
  return {
    chapterTemplate: chapterTemplate.includes("{chapter}") || chapterTemplate.includes("{chapter_padded}")
      ? chapterTemplate
      : fallback.chapterTemplate,
    pageTemplate: pageTemplate.includes("{page}") || pageTemplate.includes("{page_padded}")
      ? pageTemplate
      : fallback.pageTemplate,
    pagePad: Number.isInteger(pagePad) && pagePad > 0 ? pagePad : fallback.pagePad,
    chapterPad: Number.isInteger(chapterPad) && chapterPad > 0 ? chapterPad : fallback.chapterPad,
    volumePad: Number.isInteger(volumePad) && volumePad > 0 ? volumePad : fallback.volumePad
  };
};

const normalizeRavenNamingSettings = (value) => {
  const defaults = defaultRavenNamingSettings();
  const normalizedDefaults = normalizeRavenNamingProfile(value, defaults);
  const configuredProfiles = normalizeObject(value?.profiles, {}) || {};
  const normalizedProfiles = {...defaults.profiles};

  for (const [typeId, profile] of Object.entries(configuredProfiles)) {
    const normalizedTypeId = normalizeTypeSlug(typeId);
    if (!normalizedTypeId) {
      continue;
    }
    normalizedProfiles[normalizedTypeId] = normalizeRavenNamingProfile(
      profile,
      normalizedProfiles[normalizedTypeId] || normalizedDefaults
    );
  }

  for (const type of knownNamingProfileTypes) {
    normalizedProfiles[type.id] = normalizeRavenNamingProfile(
      normalizedProfiles[type.id],
      normalizedDefaults
    );
  }

  return {
    key: RAVEN_NAMING_KEY,
    ...normalizedDefaults,
    profiles: normalizedProfiles
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

const readRavenNamingSettings = async (vaultClient) => {
  const settingsValue = await readSetting(vaultClient, RAVEN_NAMING_KEY, defaultRavenNamingSettings());
  return normalizeRavenNamingSettings(settingsValue);
};

const readMetadataProviderSettings = async (vaultClient) => {
  const settingsValue = await readSetting(vaultClient, RAVEN_METADATA_KEY, defaultMetadataProviderSettings());
  return normalizeMetadataProviderSettings(settingsValue);
};
const readDownloadProviderSettings = async (vaultClient) => {
  const settingsValue = await readSetting(vaultClient, RAVEN_DOWNLOAD_PROVIDERS_KEY, defaultDownloadProviderSettings());
  return normalizeDownloadProviderSettings(settingsValue);
};
const readRavenDownloadRuntimeSettings = async (vaultClient) => {
  const settingsValue = await readSetting(vaultClient, RAVEN_DOWNLOAD_RUNTIME_KEY, defaultRavenDownloadRuntimeSettings());
  return normalizeRavenDownloadRuntimeSettings(settingsValue);
};
const readRequestWorkflowSettings = async (vaultClient) => {
  const settingsValue = await readSetting(vaultClient, SAGE_REQUESTS_KEY, defaultRequestWorkflowSettings());
  return normalizeRequestWorkflowSettings(settingsValue);
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

const readAdminToastSettings = async (vaultClient, user = {}) => {
  const discordUserId = normalizeString(user?.discordUserId);
  const [globalSetting, personalSetting] = await Promise.all([
    readSetting(vaultClient, ADMIN_TOAST_GLOBAL_KEY, defaultAdminToastSettings()),
    discordUserId
      ? readSetting(vaultClient, adminToastUserKey(discordUserId), null)
      : null
  ]);
  const global = normalizeAdminToastSettings(globalSetting);
  const personal = personalSetting ? normalizeAdminToastSettings(personalSetting, global) : null;
  return {
    global,
    personal,
    effective: mergeAdminToastSettings(global, personal),
    canEditGlobal: user?.isOwner === true || user?.role === "owner"
  };
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

const persistOracleSettings = async ({config, vaultClient, user, body, appendAdminUserEvent}) => {
  const password = normalizeString(body?.openAiApiKey);
  const existingSecret = await readSecret(vaultClient, ORACLE_OPENAI_API_KEY_SECRET);
  const nextSettings = normalizeOracleSettings(body, password || existingSecret);
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
  await appendAdminUserEvent(user, {
    domain: "settings",
    eventType: "oracle-settings-updated",
    targetType: "setting",
    targetId: ORACLE_SETTINGS_KEY,
    message: `${user.username} updated Oracle settings.`,
    metadata: {
      enabled: nextSettings.enabled,
      provider: nextSettings.provider,
      model: nextSettings.model
    }
  });
  return {
    ...(await readOracleSettings(vaultClient)),
    localAiSync: {
      ok: true,
      owner: "scriptarr-oracle",
      message: "Embedded LocalAI settings are applied by Oracle runtime."
    }
  };
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
  const appendAdminUserEvent = (user, payload) => appendUserEvent(vaultClient, {
    ...payload,
    user
  }, logger);

  app.use(express.json({limit: INTERNAL_JSON_BODY_LIMIT}));

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

  const resolveStoredApiKey = async (presentedKey) => {
    const normalizedKey = normalizeString(presentedKey);
    if (!normalizedKey) {
      return null;
    }
    const apiKey = await vaultClient.resolveApiKey(hashPublicApiKey(normalizedKey));
    if (!apiKey) {
      return null;
    }
    return {
      id: normalizeString(apiKey.id),
      name: normalizeString(apiKey.name, "API key"),
      kind: normalizeString(apiKey.kind, "system"),
      ownerDiscordUserId: normalizeString(apiKey.ownerDiscordUserId),
      keyPrefix: normalizeString(apiKey.keyPrefix)
    };
  };

  const hasValidLegacyPublicApiKey = async (presentedKey) => {
    const storedHash = normalizeString(await readSecret(vaultClient, MOON_PUBLIC_API_HASH_SECRET));
    const normalizedKey = normalizeString(presentedKey);
    if (!storedHash || !normalizedKey) {
      return null;
    }
    const presentedHash = hashPublicApiKey(normalizedKey);
    const storedBuffer = Buffer.from(storedHash, "utf8");
    const presentedBuffer = Buffer.from(presentedHash, "utf8");
    if (storedBuffer.length !== presentedBuffer.length || !timingSafeEqual(storedBuffer, presentedBuffer)) {
      return null;
    }
    return {
      id: "legacy-public-api",
      name: "Legacy public API key",
      kind: "legacy",
      ownerDiscordUserId: "",
      keyPrefix: ""
    };
  };

  const resolvePublicApiKey = async (presentedKey) => {
    const settings = await readMoonPublicApiSettings(vaultClient);
    if (!settings.enabled) {
      return {disabled: true, apiKey: null};
    }
    return {
      disabled: false,
      apiKey: await resolveStoredApiKey(presentedKey) || await hasValidLegacyPublicApiKey(presentedKey)
    };
  };

  const requirePublicApiKey = async (req, res, next) => {
    const resolved = await resolvePublicApiKey(req.get("X-Scriptarr-Api-Key"));
    if (resolved.disabled) {
      res.status(503).json({error: "The public Moon API is disabled."});
      return;
    }

    if (!resolved.apiKey) {
      res.status(401).json({error: "A valid X-Scriptarr-Api-Key header is required."});
      return;
    }

    req.publicApiKey = resolved.apiKey;
    await next();
  };

  const publicOpenApiDocument = () => ({
    openapi: "3.1.0",
    info: {
      title: "Scriptarr Public API",
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
      },
      "/api/moon-v3/user/profile": {
        get: {
          summary: "Read the authenticated user's profile summary",
          description: "Requires a user-level API key or browser session. User-level keys are scoped to their owner.",
          security: [{ScriptarrApiKey: []}],
          responses: {"200": {description: "Profile summary"}}
        }
      },
      "/api/moon-v3/user/api-keys": {
        get: {
          summary: "List personal API keys",
          description: "Requires a browser session with manage_personal_api_keys. API keys cannot manage other API keys.",
          responses: {"200": {description: "Personal API keys"}}
        },
        post: {
          summary: "Create a personal user-level API key",
          description: "Requires a browser session with manage_personal_api_keys. The secret is returned once.",
          responses: {"201": {description: "Created personal API key"}}
        }
      },
      "/api/moon-v3/user/api-keys/{apiKeyId}": {
        patch: {
          summary: "Rename or enable a personal API key",
          description: "Requires a browser session with manage_personal_api_keys.",
          parameters: [{name: "apiKeyId", in: "path", required: true, schema: {type: "string"}}],
          responses: {"200": {description: "Updated personal API key"}}
        },
        delete: {
          summary: "Revoke a personal API key",
          description: "Requires a browser session with manage_personal_api_keys.",
          parameters: [{name: "apiKeyId", in: "path", required: true, schema: {type: "string"}}],
          responses: {"200": {description: "Revoked personal API key"}}
        }
      },
      "/api/moon-v3/user/library": {
        get: {
          summary: "Read library metadata for reader clients",
          description: "Requires a user-level API key or browser session.",
          security: [{ScriptarrApiKey: []}],
          responses: {"200": {description: "Library titles"}}
        }
      },
      "/api/moon-v3/user/reader/progress": {
        get: {
          summary: "List the authenticated user's reader progress",
          security: [{ScriptarrApiKey: []}],
          responses: {"200": {description: "Reader progress"}}
        },
        put: {
          summary: "Update the authenticated user's reader progress",
          security: [{ScriptarrApiKey: []}],
          responses: {"200": {description: "Updated progress"}}
        }
      },
      "/api/moon-v3/user/following": {
        get: {
          summary: "List the authenticated user's followed titles",
          security: [{ScriptarrApiKey: []}],
          responses: {"200": {description: "Followed titles"}}
        },
        post: {
          summary: "Follow a title as the authenticated user",
          security: [{ScriptarrApiKey: []}],
          responses: {"201": {description: "Follow saved"}}
        }
      },
      "/api/moon-v3/user/reader/bookmarks": {
        get: {
          summary: "List the authenticated user's reader bookmarks",
          security: [{ScriptarrApiKey: []}],
          responses: {"200": {description: "Bookmarks"}}
        },
        post: {
          summary: "Create or replace one of the authenticated user's bookmarks",
          security: [{ScriptarrApiKey: []}],
          responses: {"201": {description: "Bookmark saved"}}
        }
      },
      "/api/moon-v3/admin/system/api": {
        get: {
          summary: "Read API key administration state",
          description: "Requires a system-level API key or browser session with publicapi.read.",
          security: [{ScriptarrApiKey: []}],
          responses: {"200": {description: "API administration state"}}
        }
      },
      "/api/moon-v3/admin/system/api/keys": {
        post: {
          summary: "Create a system-level API key",
          description: "Requires publicapi.root. The secret is returned once.",
          security: [{ScriptarrApiKey: []}],
          responses: {"201": {description: "Created API key"}}
        }
      },
      "/api/moon-v3/admin/system/api/keys/{apiKeyId}": {
        patch: {
          summary: "Update a system-level API key",
          description: "Requires publicapi.root.",
          security: [{ScriptarrApiKey: []}],
          parameters: [{name: "apiKeyId", in: "path", required: true, schema: {type: "string"}}],
          responses: {"200": {description: "Updated API key"}}
        },
        delete: {
          summary: "Revoke a system-level API key",
          description: "Requires publicapi.root.",
          security: [{ScriptarrApiKey: []}],
          parameters: [{name: "apiKeyId", in: "path", required: true, schema: {type: "string"}}],
          responses: {"200": {description: "Revoked API key"}}
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

  app.get("/api/auth/discord/url", (req, res) => {
    const returnTo = sanitizeReturnToPath(req.query?.returnTo, "/");
    res.json({
      callbackUrl: buildCallbackUrl(config),
      oauthUrl: buildDiscordOauthUrl(config, {returnTo}),
      returnTo
    });
  });

  app.get("/api/auth/discord/callback", async (req, res) => {
    try {
      const code = String(req.query.code || "").trim();
      if (!code) {
        res.status(400).json({error: "Discord OAuth code is required."});
        return;
      }
      const bootstrapBefore = await vaultClient.getBootstrapStatus();
      const authState = parseDiscordOauthState(req.query?.state);
      const identity = await exchangeDiscordCode(config, code);
      const user = await upsertUserFromDiscord({vaultClient, config, identity});
      const session = await vaultClient.createSession(user.discordUserId);
      await appendUserEvent(vaultClient, {
        domain: "auth",
        eventType: bootstrapBefore.ownerClaimed ? "login" : "bootstrap-owner",
        user,
        targetType: "session",
        targetId: session.token,
        message: bootstrapBefore.ownerClaimed
          ? `${user.username} signed in through Discord.`
          : `${user.username} claimed the protected bootstrap owner session.`,
        metadata: {
          discordUserId: user.discordUserId,
          role: user.role
        }
      }, logger);
      res.json({token: session.token, user, returnTo: authState.returnTo});
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

  app.post("/api/auth/logout", requireUser, async (req, res) => {
    await vaultClient.clearSession(req.sessionToken);
    await appendUserEvent(vaultClient, {
      domain: "auth",
      eventType: "logout",
      user: req.user,
      targetType: "session",
      targetId: req.sessionToken,
      message: `${req.user.username} signed out of Moon.`,
      metadata: {
        discordUserId: req.user.discordUserId
      }
    }, logger);
    res.json({ok: true});
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
    const canCreate = hasPermission(req.user, "create_requests");
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

    let request;
    try {
      request = await vaultClient.createRequest({
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
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }
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

  app.get("/api/admin/metadata/providers", requireAdminGrant(vaultClient, "settings", "read"), async (_req, res) => {
    res.json(await readMetadataProviderSettings(vaultClient));
  });

  app.get("/api/admin/settings/raven/vpn", requireAdminGrant(vaultClient, "settings", "read"), async (_req, res) => {
    res.json(await readRavenVpnSettings(vaultClient));
  });

  app.put("/api/admin/settings/raven/vpn", requireAdminGrant(vaultClient, "settings", "write"), async (req, res) => {
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
    await appendAdminUserEvent(req.user, {
      domain: "settings",
      eventType: "raven-vpn-updated",
      targetType: "setting",
      targetId: RAVEN_VPN_KEY,
      message: `${req.user.username} updated Raven VPN settings.`,
      metadata: {
        enabled: nextSettings.enabled,
        region: nextSettings.region
      }
    });
    res.json(await readRavenVpnSettings(vaultClient));
  });

  app.get("/api/admin/settings/raven/naming", requireAdminGrant(vaultClient, "mediamanagement", "read"), async (_req, res) => {
    res.json(await readRavenNamingSettings(vaultClient));
  });

  app.put("/api/admin/settings/raven/naming", requireAdminGrant(vaultClient, "mediamanagement", "write"), async (req, res) => {
    const nextSettings = normalizeRavenNamingSettings(req.body);
    await vaultClient.setSetting(RAVEN_NAMING_KEY, nextSettings);
    await appendAdminUserEvent(req.user, {
      domain: "mediamanagement",
      eventType: "naming-updated",
      targetType: "setting",
      targetId: RAVEN_NAMING_KEY,
      message: `${req.user.username} updated Raven naming profiles.`,
      metadata: {
        profileCount: Object.keys(nextSettings.profiles || {}).length
      }
    });
    res.json(await readRavenNamingSettings(vaultClient));
  });

  app.get("/api/admin/settings/raven/metadata", requireAdminGrant(vaultClient, "settings", "read"), async (_req, res) => {
    res.json(await readMetadataProviderSettings(vaultClient));
  });

  app.put("/api/admin/settings/raven/metadata", requireAdminGrant(vaultClient, "settings", "write"), async (req, res) => {
    const nextSettings = normalizeMetadataProviderSettings(req.body);
    await vaultClient.setSetting(RAVEN_METADATA_KEY, nextSettings);
    await appendAdminUserEvent(req.user, {
      domain: "settings",
      eventType: "metadata-providers-updated",
      targetType: "setting",
      targetId: RAVEN_METADATA_KEY,
      message: `${req.user.username} updated the metadata provider stack.`,
      metadata: {
        providers: normalizeArray(nextSettings.providers).map((provider) => ({
          id: provider.id,
          enabled: provider.enabled,
          priority: provider.priority
        }))
      }
    });
    res.json(await readMetadataProviderSettings(vaultClient));
  });

  app.get("/api/admin/settings/raven/download-providers", requireAdminGrant(vaultClient, "settings", "read"), async (_req, res) => {
    res.json(await readDownloadProviderSettings(vaultClient));
  });

  app.put("/api/admin/settings/raven/download-providers", requireAdminGrant(vaultClient, "settings", "write"), async (req, res) => {
    const nextSettings = normalizeDownloadProviderSettings(req.body);
    await vaultClient.setSetting(RAVEN_DOWNLOAD_PROVIDERS_KEY, nextSettings);
    await appendAdminUserEvent(req.user, {
      domain: "settings",
      eventType: "download-providers-updated",
      targetType: "setting",
      targetId: RAVEN_DOWNLOAD_PROVIDERS_KEY,
      message: `${req.user.username} updated the download provider stack.`,
      metadata: {
        providers: normalizeArray(nextSettings.providers).map((provider) => ({
          id: provider.id,
          enabled: provider.enabled,
          priority: provider.priority
        }))
      }
    });
    res.json(await readDownloadProviderSettings(vaultClient));
  });

  app.get("/api/admin/settings/sage/requests", requireAdminGrant(vaultClient, "settings", "read"), async (_req, res) => {
    res.json(await readRequestWorkflowSettings(vaultClient));
  });

  app.put("/api/admin/settings/sage/requests", requireAdminGrant(vaultClient, "settings", "write"), async (req, res) => {
    const nextSettings = normalizeRequestWorkflowSettings(req.body);
    await vaultClient.setSetting(SAGE_REQUESTS_KEY, nextSettings);
    await appendAdminUserEvent(req.user, {
      domain: "settings",
      eventType: "request-workflow-updated",
      targetType: "setting",
      targetId: SAGE_REQUESTS_KEY,
      message: `${req.user.username} updated request workflow automation.`,
      metadata: {
        autoApproveAndDownload: nextSettings.autoApproveAndDownload
      }
    });
    res.json(await readRequestWorkflowSettings(vaultClient));
  });

  app.get("/api/admin/settings/oracle", requireAdminGrant(vaultClient, "settings", "read"), async (_req, res) => {
    res.json(await readOracleSettings(vaultClient));
  });

  app.put("/api/admin/settings/oracle", requireAdminGrant(vaultClient, "settings", "write"), async (req, res) => {
    res.json(await persistOracleSettings({
      config,
      vaultClient,
      user: req.user,
      body: req.body,
      appendAdminUserEvent
    }));
  });

  app.get("/api/admin/settings/moon/branding", requireAdminGrant(vaultClient, "settings", "read"), async (_req, res) => {
    res.json(await readMoonBrandingSettings(vaultClient));
  });

  app.put("/api/admin/settings/moon/branding", requireAdminGrant(vaultClient, "settings", "write"), async (req, res) => {
    const existing = await readMoonBrandingSettings(vaultClient);
    const nextSettings = normalizeMoonBrandingSettings({
      ...existing,
      ...req.body,
      logo: req.body?.logo === undefined ? existing.logo : req.body.logo
    });
    await vaultClient.setSetting(MOON_BRANDING_KEY, nextSettings);
    await appendAdminUserEvent(req.user, {
      domain: "settings",
      eventType: "branding-updated",
      targetType: "setting",
      targetId: MOON_BRANDING_KEY,
      message: `${req.user.username} updated Moon branding.`,
      metadata: {
        siteName: nextSettings.siteName
      }
    });
    res.json(await readMoonBrandingSettings(vaultClient));
  });

  app.get("/api/admin/settings/moon/public-api", requireAdminGrant(vaultClient, "publicapi", "read"), async (_req, res) => {
    res.json(await readMoonPublicApiSettings(vaultClient));
  });

  app.put("/api/admin/settings/moon/public-api", requireAdminGrant(vaultClient, "publicapi", "root"), async (req, res) => {
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
    await appendAdminUserEvent(req.user, {
      domain: "publicapi",
      eventType: "public-api-updated",
      targetType: "setting",
      targetId: MOON_PUBLIC_API_KEY,
      message: `${req.user.username} updated public API access.`,
      metadata: {
        enabled: nextSettings.enabled
      }
    });
    res.json(await readMoonPublicApiSettings(vaultClient));
  });

  app.post("/api/admin/settings/moon/public-api/key", requireAdminGrant(vaultClient, "publicapi", "root"), async (req, res) => {
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
    await appendAdminUserEvent(req.user, {
      domain: "publicapi",
      eventType: "public-api-key-rotated",
      targetType: "setting",
      targetId: MOON_PUBLIC_API_KEY,
      message: `${req.user.username} rotated the Moon public API key.`,
      metadata: {
        lastRotatedAt: nextSettings.lastRotatedAt
      }
    });
    res.json({
      ...(await readMoonPublicApiSettings(vaultClient)),
      apiKey: nextApiKey
    });
  });

  app.get("/api/admin/settings/portal/discord", requireAdminGrant(vaultClient, "discord", "read"), async (_req, res) => {
    const settings = await readPortalDiscordSettings(vaultClient);
    const runtime = await loadPortalDiscordRuntime(config, settings);
    res.json({
      ...settings,
      runtime
    });
  });

  app.put("/api/admin/settings/portal/discord", requireAdminGrant(vaultClient, "discord", "write"), async (req, res) => {
    const nextSettings = normalizePortalDiscordSettings(req.body);
    await vaultClient.setSetting(PORTAL_DISCORD_KEY, nextSettings);
    const reload = await reloadPortalDiscordRuntime(config);
    const settings = await readPortalDiscordSettings(vaultClient);
    const runtime = await loadPortalDiscordRuntime(config, settings);
    await appendAdminUserEvent(req.user, {
      domain: "discord",
      eventType: "discord-settings-updated",
      targetType: "setting",
      targetId: PORTAL_DISCORD_KEY,
      message: `${req.user.username} updated Discord integration settings.`,
      metadata: {
        guildId: settings.guildId,
        superuserId: settings.superuserId
      }
    });
    res.json({
      ...settings,
      runtime: {
        ...runtime,
        reload: reload.payload || reload
      }
    });
  });

  app.post("/api/admin/settings/portal/discord/onboarding/test", requireAdminGrant(vaultClient, "discord", "write"), async (req, res) => {
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
      guildName: normalizeString(req.body?.guildName, "Scriptarr Admin Preview"),
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

    const apiActor = req.publicApiKey || {};
    const requesterId = apiActor.kind === "user" && apiActor.ownerDiscordUserId
      ? apiActor.ownerDiscordUserId
      : "external-api";
    let request;
    try {
      request = await vaultClient.createRequest({
        source: "external_api",
        title: selection.canonicalTitle,
        requestType: selection.requestType,
        notes: normalizeString(req.body?.notes),
        requestedBy: requesterId,
        status: "pending",
        details: {
          query: selection.query,
          selectedMetadata: selection.selectedMetadata,
          selectedDownload: selection.selectedDownload,
          availability: "available",
          coverUrl: selection.coverUrl,
          apiKeyId: normalizeString(apiActor.id),
          apiKeyKind: normalizeString(apiActor.kind)
        }
      });
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }

    const queued = await serviceJson(config.ravenBaseUrl, "/v1/downloads/queue", {
      method: "POST",
      body: {
        titleName: normalizeString(selection.selectedDownload?.titleName, selection.canonicalTitle),
        titleUrl: normalizeString(selection.selectedDownload?.titleUrl),
        requestType: selection.requestType,
        providerId: normalizeString(selection.selectedDownload?.providerId),
        requestId: String(request.id),
        requestedBy: requesterId,
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
        taskId: normalizeString(queued.payload?.taskId),
        apiKeyId: normalizeString(apiActor.id),
        apiKeyKind: normalizeString(apiActor.kind)
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
    if (req.publicApiKey?.kind === "user" && normalizeString(request.requestedBy) !== normalizeString(req.publicApiKey.ownerDiscordUserId)) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    res.json({request: normalizePublicRequestSummary(request)});
  });

  app.get("/api/admin/warden/localai", requireAdminGrant(vaultClient, "system", "read"), async (_req, res) => {
    const [oracleSettings, localAiStatus] = await Promise.all([
      readOracleSettings(vaultClient),
      safeJson(serviceJson(config.oracleBaseUrl, "/api/localai/status"))
    ]);
    res.json({
      oracle: oracleSettings,
      warden: localAiStatus.payload || localAiStatus
    });
  });

  app.post("/api/admin/warden/localai/install", requireAdminGrant(vaultClient, "system", "root"), async (req, res) => {
    const oracleSettings = await readOracleSettings(vaultClient);
    const result = await safeJson(serviceJson(config.oracleBaseUrl, "/api/localai/actions/install", {
      method: "POST",
      body: {
        model: oracleSettings.model,
        requestedBy: {
          discordUserId: normalizeString(req.user?.discordUserId),
          username: normalizeString(req.user?.username, "Admin")
        }
      },
      timeoutMs: 10000
    }));
    await appendAdminUserEvent(req.user, {
      domain: "system",
      eventType: "localai-install-started",
      targetType: "service",
      targetId: "scriptarr-oracle",
      message: `${req.user.username} started the embedded LocalAI install flow.`,
      metadata: {
        result: result.payload || result
      }
    });
    res.status(result.status || 200).json(result.payload || result);
  });

  app.post("/api/admin/warden/localai/start", requireAdminGrant(vaultClient, "system", "root"), async (req, res) => {
    const oracleSettings = await readOracleSettings(vaultClient);
    const result = await safeJson(serviceJson(config.oracleBaseUrl, "/api/localai/actions/start", {
      method: "POST",
      body: {
        model: oracleSettings.model,
        requestedBy: {
          discordUserId: normalizeString(req.user?.discordUserId),
          username: normalizeString(req.user?.username, "Admin")
        }
      },
      timeoutMs: 10000
    }));
    await appendAdminUserEvent(req.user, {
      domain: "system",
      eventType: "localai-started",
      targetType: "service",
      targetId: "scriptarr-oracle",
      message: `${req.user.username} started embedded LocalAI.`,
      metadata: {
        result: result.payload || result
      }
    });
    res.status(result.status || 200).json(result.payload || result);
  });

  app.post("/api/admin/warden/localai/remove", requireAdminGrant(vaultClient, "system", "root"), async (req, res) => {
    const result = await safeJson(serviceJson(config.oracleBaseUrl, "/api/localai/actions/remove", {
      method: "POST",
      body: {
        requestedBy: {
          discordUserId: normalizeString(req.user?.discordUserId),
          username: normalizeString(req.user?.username, "Admin")
        }
      },
      timeoutMs: 10000
    }));
    await appendAdminUserEvent(req.user, {
      domain: "system",
      eventType: "localai-remove-requested",
      targetType: "service",
      targetId: "scriptarr-oracle",
      message: `${req.user.username} requested embedded LocalAI removal.`,
      metadata: {
        result: result.payload || result
      }
    });
    res.status(result.status || 200).json(result.payload || result);
  });

  app.get("/api/updates", requireAdminGrant(vaultClient, "system", "read"), async (_req, res) => {
    const result = await serviceJson(config.wardenBaseUrl, "/api/updates");
    res.status(result.status).json(result.payload);
  });

  app.post("/api/updates/check", requireAdminGrant(vaultClient, "system", "root"), async (req, res) => {
    const result = await serviceJson(config.wardenBaseUrl, "/api/updates/check", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    });
    await appendAdminUserEvent(req.user, {
      domain: "system",
      eventType: "updates-check-started",
      targetType: "service",
      targetId: "scriptarr-warden",
      message: `${req.user.username} started an update check.`,
      metadata: {
        services: normalizeArray(req.body?.services)
      }
    });
    res.status(result.status).json(result.payload);
  });

  app.post("/api/updates/install", requireAdminGrant(vaultClient, "system", "root"), async (req, res) => {
    const result = await serviceJson(config.wardenBaseUrl, "/api/updates/install", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    });
    await appendAdminUserEvent(req.user, {
      domain: "system",
      eventType: "updates-install-started",
      targetType: "service",
      targetId: "scriptarr-warden",
      message: `${req.user.username} started a managed service update job.`,
      metadata: {
        services: normalizeArray(req.body?.services)
      }
    });
    res.status(result.status).json(result.payload);
  });

  registerInternalBrokerRoutes(app, {
    config,
    vaultClient,
    requireService,
    serviceJson,
    readRequestWorkflowSettings: () => readRequestWorkflowSettings(vaultClient)
  });

  const systemTaskRuntime = createSystemTaskRuntime({
    config,
    vaultClient,
    serviceJson,
    logger,
    readRequestWorkflowSettings: () => readRequestWorkflowSettings(vaultClient)
  });

  registerMoonV3Routes(app, {
    config,
    logger,
    vaultClient,
    requireUser,
    requirePermission: (permission) => requirePermission(vaultClient, permission),
    requireAdminGrant: (domain, level = "read") => requireAdminGrant(vaultClient, domain, level),
    readRavenVpnSettings: () => readRavenVpnSettings(vaultClient),
    readRavenNamingSettings: () => readRavenNamingSettings(vaultClient),
    readMetadataProviderSettings: () => readMetadataProviderSettings(vaultClient),
    readDownloadProviderSettings: () => readDownloadProviderSettings(vaultClient),
    readRavenDownloadRuntimeSettings: () => readRavenDownloadRuntimeSettings(vaultClient),
    readRequestWorkflowSettings: () => readRequestWorkflowSettings(vaultClient),
    readOracleSettings: () => readOracleSettings(vaultClient),
    readMoonBrandingSettings: () => readMoonBrandingSettings(vaultClient),
    readAdminToastSettings: (user) => readAdminToastSettings(vaultClient, user),
    readMoonPublicApiSettings: () => readMoonPublicApiSettings(vaultClient),
    readPortalDiscordSettings: async () => {
      const settings = await readPortalDiscordSettings(vaultClient);
      return {
        ...settings,
        runtime: await loadPortalDiscordRuntime(config, settings)
      };
    },
    serviceJson,
    safeJson,
    systemTaskRuntime,
    persistOracleSettings: (user, body) => persistOracleSettings({
      config,
      vaultClient,
      user,
      body,
      appendAdminUserEvent
    })
  });

  app.use((error, _req, res, _next) => {
    logger.error("Sage request failed.", {
      error
    });
    if (res.headersSent) {
      return;
    }
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
    res.status(status).json({
      error: error?.message || "Sage request failed."
    });
  });

  systemTaskRuntime.start();
  app.locals.systemTaskRuntime = systemTaskRuntime;

  logger.info("Sage app initialized.", {
    publicBaseUrl: config.publicBaseUrl
  });

  return {app, config};
};

