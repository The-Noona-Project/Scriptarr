/**
 * @file Scriptarr Warden module: services/warden/config/servicePlan.mjs.
 */
import {
  DEFAULT_MOON_PORT,
  DEFAULT_MOON_PUBLIC_PORT,
  DEFAULT_NETWORK_NAME,
  DEFAULT_NOONA_PERSONA_NAME,
  DEFAULT_ORACLE_PORT,
  DEFAULT_PORTAL_PORT,
  DEFAULT_PUBLIC_BASE_URL,
  DEFAULT_RAVEN_PORT,
  DEFAULT_SAGE_PORT,
  DEFAULT_STACK_ID,
  DEFAULT_STACK_MODE,
  DEFAULT_VAULT_PORT,
  DEFAULT_WARDEN_PORT,
  DEFAULT_WARDEN_SERVICE_BASE_URL
} from "./constants.mjs";
import {resolveServiceImage} from "./images.mjs";
import {resolveServiceDnsServers} from "./containerDns.mjs";
import {resolveLocalAiProfile} from "./localAiProfiles.mjs";
import {resolveMysqlConfig, toInternalMysqlEnv} from "./mysqlConfig.mjs";
import {resolveClusterServiceUrl, resolveClusterTopology} from "./clusterTopology.mjs";
import {buildScriptarrStorageLayout, resolveScriptarrDataRoot} from "../filesystem/storageLayout.mjs";

const normalizeString = (value) => String(value ?? "").trim();

/**
 * Ensure an NVIDIA driver capability list includes the capabilities a service
 * needs in addition to any operator-provided defaults.
 *
 * @param {string} value
 * @param {string[]} required
 * @returns {string}
 */
const withRequiredNvidiaCapabilities = (value, required = []) => {
  const seen = new Set();
  return [...String(value || "").split(","), ...required]
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    })
    .join(",");
};

const DEFAULT_HTTP_HEALTH_CHECK = Object.freeze({
  interval: "15s",
  timeout: "5s",
  startPeriod: "15s",
  retries: 5
});

const DEFAULT_MYSQL_HEALTH_CHECK = Object.freeze({
  interval: "10s",
  timeout: "5s",
  startPeriod: "30s",
  retries: 10
});

const resolvePort = (value, fallback) => {
  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const defaultTokenMap = (env = process.env) => ({
  "scriptarr-warden": env.SCRIPTARR_WARDEN_SERVICE_TOKEN || "warden-dev-token",
  "scriptarr-vault": env.SCRIPTARR_VAULT_SERVICE_TOKEN || "vault-dev-token",
  "scriptarr-sage": env.SCRIPTARR_SAGE_SERVICE_TOKEN || "sage-dev-token",
  "scriptarr-moon": env.SCRIPTARR_MOON_SERVICE_TOKEN || "moon-dev-token",
  "scriptarr-raven": env.SCRIPTARR_RAVEN_SERVICE_TOKEN || "raven-dev-token",
  "scriptarr-portal": env.SCRIPTARR_PORTAL_SERVICE_TOKEN || "portal-dev-token",
  "scriptarr-oracle": env.SCRIPTARR_ORACLE_SERVICE_TOKEN || "oracle-dev-token"
});

const resolveContainerName = (serviceName, prefix) => {
  const normalizedPrefix = normalizeString(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalizedPrefix) {
    return serviceName;
  }

  return `${normalizedPrefix}-${serviceName.replace(/^scriptarr-/, "")}`;
};

/**
 * Resolve the container-name prefix Warden should apply for the current stack.
 *
 * @param {{env?: NodeJS.ProcessEnv, containerNamePrefix?: string}} [options]
 * @returns {string}
 */
export const resolveContainerNamePrefix = ({env = process.env, containerNamePrefix = ""} = {}) => {
  const explicit = normalizeString(containerNamePrefix || env.SCRIPTARR_CONTAINER_NAME_PREFIX);
  if (explicit) {
    return explicit;
  }

  if (resolveStackMode({env}) !== "test") {
    return "";
  }

  const normalizedStackId = normalizeString(env.SCRIPTARR_STACK_ID || DEFAULT_STACK_ID)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalizedStackId ? `scriptarr-test-${normalizedStackId}` : "";
};

const resolveFolderMounts = (layout, serviceName, keys) =>
  keys
    .map((key) => layout.services?.[serviceName]?.[key] || null)
    .filter(Boolean);

const buildNodeHttpHealthCheck = (port) => ({
  command: `node -e "fetch('http://127.0.0.1:${port}/health',{signal:AbortSignal.timeout(4000)}).then((response)=>{if(!response.ok){process.exit(1);}}).catch(()=>process.exit(1));"`,
  ...DEFAULT_HTTP_HEALTH_CHECK
});

const buildCurlHttpHealthCheck = (port, {startPeriod = "25s"} = {}) => ({
  command: `curl -fsS http://127.0.0.1:${port}/health > /dev/null || exit 1`,
  ...DEFAULT_HTTP_HEALTH_CHECK,
  startPeriod
});

const buildPythonHttpHealthCheck = (port) => ({
  command: `python -c "import sys,urllib.request; response=urllib.request.urlopen('http://127.0.0.1:${port}/health', timeout=4); sys.exit(0 if response.status < 400 else 1)"`,
  ...DEFAULT_HTTP_HEALTH_CHECK
});

const buildMysqlHealthCheck = () => ({
  command: "mysqladmin ping -h 127.0.0.1 -u\"$MYSQL_USER\" -p\"$MYSQL_PASSWORD\" --silent || exit 1",
  ...DEFAULT_MYSQL_HEALTH_CHECK
});

/**
 * Resolve Moon's public-facing base URL.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export const resolvePublicBaseUrl = ({env = process.env} = {}) =>
  normalizeString(env.SCRIPTARR_PUBLIC_BASE_URL)
  || `http://localhost:${resolvePort(env.SCRIPTARR_MOON_PUBLIC_PORT || env.SCRIPTARR_MOON_PORT, DEFAULT_MOON_PUBLIC_PORT)}`;

/**
 * Resolve the Discord callback URL surfaced by Warden and Sage.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export const resolveDiscordCallbackUrl = ({env = process.env} = {}) =>
  `${resolvePublicBaseUrl({env}).replace(/\/+$/, "")}/api/moon/auth/discord/callback`;

/**
 * Resolve the shared Docker network that Warden manages for Scriptarr.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export const resolveManagedNetworkName = ({env = process.env} = {}) =>
  normalizeString(env.SCRIPTARR_NETWORK_NAME) || DEFAULT_NETWORK_NAME;

/**
 * Resolve the current Warden stack mode.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export const resolveStackMode = ({env = process.env} = {}) =>
  normalizeString(env.SCRIPTARR_STACK_MODE) || DEFAULT_STACK_MODE;

/**
 * Build the managed service descriptors that Warden exposes at runtime and that
 * the Docker-backed stack test helper uses to start containers.
 *
 * @param {{env?: NodeJS.ProcessEnv, containerNamePrefix?: string}} [options]
 * @returns {{
 *   installMode: string,
 *   stackMode: string,
 *   managedNetworkName: string,
 *   publicBaseUrl: string,
 *   callbackUrl: string,
 *   superuserId: string,
 *   discordTokenConfigured: boolean,
 *   noonaPersonaName: string,
 *   imageNamespace: string,
 *   imageTag: string,
 *   mysql: {
 *     mode: "selfhost" | "external",
 *     host: string,
 *     port: number,
 *     database: string,
 *     user: string,
 *     passwordConfigured: boolean,
 *     managedServiceName: string | null
 *   },
 *   serviceTokens: Record<string, string>,
 *   services: Array<{
 *     name: string,
 *     containerName: string,
 *     image: string,
 *     env: Record<string, string>,
 *     mounts: Array<{hostPath: string, containerPath: string | null}>,
 *     networkAliases: string[],
 *     dnsServers?: string[],
 *     publishedPorts: Array<{hostPort: number, containerPort: number}>,
 *     healthCheck?: {
 *       command: string,
 *       interval?: string,
 *       timeout?: string,
 *       startPeriod?: string,
 *       retries?: number
 *     },
 *     containerPort: number
 *   }>,
 *   storageLayout: ReturnType<typeof buildScriptarrStorageLayout>
 * }}
 */
export const resolveServicePlan = ({env = process.env, containerNamePrefix = ""} = {}) => {
  const topology = resolveClusterTopology({env});
  if (topology.enabled) {
    const missing = ["WARDEN", "VAULT", "SAGE", "MOON", "RAVEN", "PORTAL", "ORACLE"].filter((name) => {
      const token = normalizeString(env[`SCRIPTARR_${name}_SERVICE_TOKEN`]);
      return !token || /-dev-token$/i.test(token);
    });
    if (missing.length) throw new Error(`Multi-host mode requires explicit non-development service tokens for: ${missing.join(", ")}.`);
  }
  const mysql = resolveMysqlConfig({env});
  const stackMode = resolveStackMode({env});
  const managedNetworkName = resolveManagedNetworkName({env});
  const publicBaseUrl = resolvePublicBaseUrl({env});
  const callbackUrl = resolveDiscordCallbackUrl({env});
  const serviceTokens = defaultTokenMap(env);
  const dataRoot = resolveScriptarrDataRoot({env});
  const storageLayout = buildScriptarrStorageLayout(dataRoot);
  const mysqlEnv = toInternalMysqlEnv(mysql);
  const moonPort = resolvePort(env.SCRIPTARR_MOON_PORT, DEFAULT_MOON_PORT);
  const moonPublicPort = resolvePort(env.SCRIPTARR_MOON_PUBLIC_PORT || env.SCRIPTARR_MOON_PORT, DEFAULT_MOON_PUBLIC_PORT);
  const vaultPort = resolvePort(env.SCRIPTARR_VAULT_PORT, DEFAULT_VAULT_PORT);
  const sagePort = resolvePort(env.SCRIPTARR_SAGE_PORT, DEFAULT_SAGE_PORT);
  const portalPort = resolvePort(env.SCRIPTARR_PORTAL_PORT, DEFAULT_PORTAL_PORT);
  const oraclePort = resolvePort(env.SCRIPTARR_ORACLE_PORT, DEFAULT_ORACLE_PORT);
  const ravenPort = resolvePort(env.SCRIPTARR_RAVEN_PORT, DEFAULT_RAVEN_PORT);
  const serviceUrl = (name, port) => resolveClusterServiceUrl(topology, name, port);
  const wardenBaseUrlForServices = normalizeString(env.SCRIPTARR_WARDEN_BASE_URL) || DEFAULT_WARDEN_SERVICE_BASE_URL;
  const oracleEmbeddedLocalAi = normalizeString(env.SCRIPTARR_LOCALAI_EMBEDDED) || "true";
  const oracleLocalAiBaseUrl = normalizeString(env.SCRIPTARR_ORACLE_LOCALAI_BASE_URL)
    || (oracleEmbeddedLocalAi === "false"
      ? normalizeString(env.SCRIPTARR_LOCALAI_BASE_URL) || "http://scriptarr-localai:8080/v1"
      : "http://127.0.0.1:8080/v1");
  const oracleLocalAiProfile = resolveLocalAiProfile({
    env: {
      ...env,
      SCRIPTARR_GPU_HINT: normalizeString(env.SCRIPTARR_ORACLE_LOCALAI_GPU_PROFILE || env.SCRIPTARR_GPU_HINT)
    }
  });
  const oracleGpuEnv = oracleLocalAiProfile.key === "nvidia"
    ? {
      NVIDIA_VISIBLE_DEVICES: env.NVIDIA_VISIBLE_DEVICES || "all",
      NVIDIA_DRIVER_CAPABILITIES: env.NVIDIA_DRIVER_CAPABILITIES || "compute,utility"
    }
    : {};
  const ravenEncoderPolicy = normalizeString(env.SCRIPTARR_RAVEN_AVIF_ENCODER).toLowerCase() || "auto";
  if (!["auto", "nvenc", "cpu"].includes(ravenEncoderPolicy)) {
    throw new Error("SCRIPTARR_RAVEN_AVIF_ENCODER must be auto, nvenc or cpu.");
  }
  const explicitRavenGpuProfile = normalizeString(env.SCRIPTARR_RAVEN_INGEST_GPU_PROFILE).toLowerCase();
  if (ravenEncoderPolicy === "nvenc" && explicitRavenGpuProfile && explicitRavenGpuProfile !== "nvidia") {
    throw new Error("Strict NVENC encoding requires the NVIDIA Raven ingest profile.");
  }
  const ravenIngestGpuProfile = resolveLocalAiProfile({
    env: {
      ...env,
      SCRIPTARR_GPU_HINT: ravenEncoderPolicy === "cpu" ? "cpu" : ravenEncoderPolicy === "nvenc" ? "nvidia"
        : normalizeString(env.SCRIPTARR_RAVEN_INGEST_GPU_PROFILE || env.SCRIPTARR_GPU_HINT)
    }
  });
  const ravenGpuEnv = ravenIngestGpuProfile.key === "nvidia"
    ? {
      SCRIPTARR_RAVEN_INGEST_GPU_PROFILE: "nvidia",
      SCRIPTARR_RAVEN_INGEST_REQUIRE_NVIDIA: ravenEncoderPolicy === "nvenc" ? "true" : "false",
      NVIDIA_VISIBLE_DEVICES: env.NVIDIA_VISIBLE_DEVICES || "all",
      NVIDIA_DRIVER_CAPABILITIES: withRequiredNvidiaCapabilities(
        env.SCRIPTARR_RAVEN_NVIDIA_DRIVER_CAPABILITIES || env.NVIDIA_DRIVER_CAPABILITIES || "compute,utility",
        ["compute", "utility", "video"]
      )
    }
    : {
      SCRIPTARR_RAVEN_INGEST_GPU_PROFILE: ravenIngestGpuProfile.key
    };
  const ravenVpnExtraArgs = normalizeString(env.SCRIPTARR_RAVEN_VPN_RUNTIME_DISABLED).toLowerCase() === "true"
    ? []
    : ["--cap-add", "NET_ADMIN", "--device", normalizeString(env.SCRIPTARR_RAVEN_TUN_DEVICE) || "/dev/net/tun"];
  const ravenIngestExtraArgs = ravenIngestGpuProfile.key === "nvidia" ? ravenIngestGpuProfile.runtimeArgs || [] : [];
  const resolvedContainerNamePrefix = resolveContainerNamePrefix({env, containerNamePrefix});

  /** @type {ReturnType<typeof resolveServicePlan>["services"]} */
  const services = [];

  if (mysql.mode === "selfhost") {
    services.push({
      name: "scriptarr-mysql",
      containerName: resolveContainerName("scriptarr-mysql", resolvedContainerNamePrefix),
      image: normalizeString(env.SCRIPTARR_MYSQL_IMAGE) || "mysql:8.4",
      env: {
        MYSQL_ROOT_PASSWORD: mysql.password,
        MYSQL_DATABASE: mysql.database,
        MYSQL_USER: mysql.user,
        MYSQL_PASSWORD: mysql.password
      },
      mounts: resolveFolderMounts(storageLayout, "scriptarr-mysql", ["data"]),
      networkAliases: ["scriptarr-mysql"],
      publishedPorts: [],
      healthCheck: buildMysqlHealthCheck(),
      containerPort: mysql.port
    });
  }

  services.push({
    name: "scriptarr-vault",
    containerName: resolveContainerName("scriptarr-vault", resolvedContainerNamePrefix),
    image: resolveServiceImage("scriptarr-vault", {env}),
    env: {
      SCRIPTARR_VAULT_DRIVER: env.SCRIPTARR_VAULT_DRIVER || "mysql",
      ...mysqlEnv,
      SCRIPTARR_SERVICE_TOKENS: JSON.stringify(serviceTokens),
      SCRIPTARR_VAULT_PORT: String(vaultPort),
      SUPERUSER_ID: env.SUPERUSER_ID || ""
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-vault", ["logs"]),
    networkAliases: ["scriptarr-vault"],
    publishedPorts: [],
    healthCheck: buildNodeHttpHealthCheck(vaultPort),
    containerPort: vaultPort
  });

  services.push({
    name: "scriptarr-sage",
    containerName: resolveContainerName("scriptarr-sage", resolvedContainerNamePrefix),
    image: resolveServiceImage("scriptarr-sage", {env}),
    env: {
      SCRIPTARR_VAULT_BASE_URL: serviceUrl("scriptarr-vault", vaultPort),
      SCRIPTARR_WARDEN_BASE_URL: wardenBaseUrlForServices,
      SCRIPTARR_WARDEN_SERVICE_TOKEN: serviceTokens["scriptarr-warden"],
      SCRIPTARR_PORTAL_BASE_URL: serviceUrl("scriptarr-portal", portalPort),
      SCRIPTARR_ORACLE_BASE_URL: serviceUrl("scriptarr-oracle", oraclePort),
      SCRIPTARR_RAVEN_BASE_URL: serviceUrl("scriptarr-raven", ravenPort),
      SCRIPTARR_PUBLIC_BASE_URL: publicBaseUrl,
      SCRIPTARR_SERVICE_TOKEN: serviceTokens["scriptarr-sage"],
      SCRIPTARR_SERVICE_TOKENS: JSON.stringify(serviceTokens),
      SCRIPTARR_DISCORD_CALLBACK_URL: callbackUrl,
      SCRIPTARR_SAGE_PORT: String(sagePort),
      SUPERUSER_ID: env.SUPERUSER_ID || "",
      SCRIPTARR_DISCORD_TOKEN: env.DISCORD_TOKEN || "",
      DISCORD_TOKEN: env.DISCORD_TOKEN || "",
      SCRIPTARR_DISCORD_CLIENT_ID: env.SCRIPTARR_DISCORD_CLIENT_ID || "",
      SCRIPTARR_DISCORD_CLIENT_SECRET: env.SCRIPTARR_DISCORD_CLIENT_SECRET || "",
      SCRIPTARR_VAULT_AUTH_TIMEOUT_MS: env.SCRIPTARR_VAULT_AUTH_TIMEOUT_MS || env.SCRIPTARR_AUTH_VAULT_TIMEOUT_MS || "8000",
      SCRIPTARR_APPA_DISCORD_TOKEN: env.SCRIPTARR_APPA_DISCORD_TOKEN || "",
      SCRIPTARR_APPA_DISCORD_CLIENT_ID: env.SCRIPTARR_APPA_DISCORD_CLIENT_ID || "",
      SCRIPTARR_AUTO_PROVISION_DISCORD_USERS: env.SCRIPTARR_AUTO_PROVISION_DISCORD_USERS || "true"
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-sage", ["logs"]),
    networkAliases: ["scriptarr-sage"],
    publishedPorts: [],
    healthCheck: buildNodeHttpHealthCheck(sagePort),
    containerPort: sagePort
  });

  services.push({
    name: "scriptarr-moon",
    containerName: resolveContainerName("scriptarr-moon", resolvedContainerNamePrefix),
    image: resolveServiceImage("scriptarr-moon", {env}),
    env: {
      SCRIPTARR_SAGE_BASE_URL: serviceUrl("scriptarr-sage", sagePort),
      SCRIPTARR_SERVICE_TOKEN: serviceTokens["scriptarr-moon"],
      SCRIPTARR_PUBLIC_BASE_URL: publicBaseUrl,
      SCRIPTARR_MOON_PORT: String(moonPort),
      SCRIPTARR_MOON_COVER_CACHE_DIR: "/app/cover-cache",
      SCRIPTARR_MOON_READER_PAGE_CACHE_DIR: "/app/reader-page-cache"
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-moon", ["coverCache", "readerPageCache", "logs"]),
    networkAliases: ["scriptarr-moon"],
    publishedPorts: [{hostPort: moonPublicPort, containerPort: moonPort}],
    healthCheck: buildNodeHttpHealthCheck(moonPort),
    containerPort: moonPort
  });

  services.push({
    name: "scriptarr-raven",
    containerName: resolveContainerName("scriptarr-raven", resolvedContainerNamePrefix),
    image: resolveServiceImage("scriptarr-raven", {env}),
    env: {
      SCRIPTARR_SAGE_BASE_URL: serviceUrl("scriptarr-sage", sagePort),
      SCRIPTARR_SERVICE_TOKEN: serviceTokens["scriptarr-raven"],
      SCRIPTARR_RAVEN_DATA_ROOT: "/downloads",
      SCRIPTARR_RAVEN_LOG_DIR: "/app/logs",
      SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT: "avif",
      SCRIPTARR_RAVEN_AVIF_ENCODER: ravenEncoderPolicy,
      SCRIPTARR_RAVEN_AVIF_REQUIRE_NVIDIA: ravenEncoderPolicy === "nvenc" ? "true" : "false",
      SCRIPTARR_RAVEN_INGEST_REQUIRE_NVIDIA: ravenEncoderPolicy === "nvenc" ? "true" : "false",
      SCRIPTARR_RAVEN_AVIF_THREADS: normalizeString(env.SCRIPTARR_RAVEN_AVIF_THREADS) || "2",
      SCRIPTARR_RAVEN_AVIF_ENCODER_SLOTS: normalizeString(env.SCRIPTARR_RAVEN_AVIF_ENCODER_SLOTS) || (ravenIngestGpuProfile.key === "nvidia" ? "6" : "1"),
      SCRIPTARR_RAVEN_AVIF_PAGE_CONCURRENCY: normalizeString(env.SCRIPTARR_RAVEN_AVIF_PAGE_CONCURRENCY) || (ravenIngestGpuProfile.key === "nvidia" ? "4" : "1"),
      ...ravenGpuEnv
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-raven", ["downloads", "logs"]),
    networkAliases: ["scriptarr-raven"],
    publishedPorts: [],
    extraArgs: [...ravenVpnExtraArgs, ...ravenIngestExtraArgs],
    healthCheck: buildCurlHttpHealthCheck(ravenPort, {startPeriod: "25s"}),
    containerPort: ravenPort
  });

  services.push({
    name: "scriptarr-portal",
    containerName: resolveContainerName("scriptarr-portal", resolvedContainerNamePrefix),
    image: resolveServiceImage("scriptarr-portal", {env}),
    env: {
      SCRIPTARR_SAGE_BASE_URL: serviceUrl("scriptarr-sage", sagePort),
      SCRIPTARR_SERVICE_TOKEN: serviceTokens["scriptarr-portal"],
      SCRIPTARR_SERVICE_TOKENS: JSON.stringify(serviceTokens),
      SCRIPTARR_PUBLIC_BASE_URL: publicBaseUrl,
      SCRIPTARR_PORTAL_PORT: String(portalPort),
      ...(topology.enabled ? {SCRIPTARR_REQUIRE_SERVICE_AUTH: "true"} : {}),
      SCRIPTARR_DISCORD_CLIENT_ID: env.SCRIPTARR_DISCORD_CLIENT_ID || "",
      SCRIPTARR_DISCORD_TOKEN: env.DISCORD_TOKEN || "",
      SCRIPTARR_APPA_DISCORD_TOKEN: env.SCRIPTARR_APPA_DISCORD_TOKEN || "",
      SCRIPTARR_APPA_DISCORD_CLIENT_ID: env.SCRIPTARR_APPA_DISCORD_CLIENT_ID || "",
      SCRIPTARR_DISCORD_BOT_PERSONA: env.SCRIPTARR_DISCORD_BOT_PERSONA || "",
      SCRIPTARR_DISCORD_AVATAR_MODE: env.SCRIPTARR_DISCORD_AVATAR_MODE || "",
      DISCORD_TOKEN: env.DISCORD_TOKEN || ""
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-portal", ["logs"]),
    networkAliases: ["scriptarr-portal"],
    publishedPorts: [],
    healthCheck: buildNodeHttpHealthCheck(portalPort),
    containerPort: portalPort
  });

  services.push({
    name: "scriptarr-oracle",
    containerName: resolveContainerName("scriptarr-oracle", resolvedContainerNamePrefix),
    image: resolveServiceImage("scriptarr-oracle", {env}),
    env: {
      SCRIPTARR_SAGE_BASE_URL: serviceUrl("scriptarr-sage", sagePort),
      SCRIPTARR_SERVICE_TOKEN: serviceTokens["scriptarr-oracle"],
      SCRIPTARR_LOCALAI_BASE_URL: oracleLocalAiBaseUrl,
      SCRIPTARR_LOCALAI_EMBEDDED: oracleEmbeddedLocalAi,
      SCRIPTARR_LOCALAI_MODELS_DIR: "/models",
      SCRIPTARR_LOCALAI_DATA_DIR: "/data",
      SCRIPTARR_LOCALAI_BACKENDS_PATH: "/data/backends",
      LOCALAI_BACKENDS_SYSTEM_PATH: "/data/backends",
      BACKEND_SYSTEM_PATH: "/data/backends",
      SCRIPTARR_LOCALAI_TMP_DIR: "/data/tmp",
      SCRIPTARR_LOCALAI_BACKEND_ASSETS_PATH: "/data/backend_data",
      SCRIPTARR_LOCALAI_GENERATED_CONTENT_PATH: "/data/generated",
      SCRIPTARR_LOCALAI_UPLOAD_PATH: "/data/upload",
      SCRIPTARR_ORACLE_LOCALAI_GPU_PROFILE: oracleLocalAiProfile.key,
      SCRIPTARR_LOCALAI_GPU_LAYERS: env.SCRIPTARR_LOCALAI_GPU_LAYERS || "auto",
      SCRIPTARR_LOCALAI_CONTEXT_SIZE: env.SCRIPTARR_LOCALAI_CONTEXT_SIZE || "4096",
      SCRIPTARR_LOCALAI_BACKEND: env.SCRIPTARR_LOCALAI_BACKEND || "llama-cpp",
      SCRIPTARR_ORACLE_MAX_CONCURRENT_GENERATIONS: env.SCRIPTARR_ORACLE_MAX_CONCURRENT_GENERATIONS || "1",
      SCRIPTARR_LOCALAI_DEFAULT_MODEL: env.SCRIPTARR_LOCALAI_DEFAULT_MODEL
        || "huggingface://bartowski/Hermes-3-Llama-3.1-8B-GGUF/Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
      SCRIPTARR_LOCALAI_ALTERNATE_MODELS: env.SCRIPTARR_LOCALAI_ALTERNATE_MODELS
        || "huggingface://bartowski/Hermes-3-Llama-3.1-8B-GGUF/Hermes-3-Llama-3.1-8B-Q4_K_M.gguf,huggingface://Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf",
      SCRIPTARR_ORACLE_PORT: String(oraclePort),
      ...(topology.enabled ? {SCRIPTARR_REQUIRE_SERVICE_AUTH: "true"} : {}),
      SCRIPTARR_NOONA_PERSONA_NAME: env.SCRIPTARR_NOONA_PERSONA_NAME || DEFAULT_NOONA_PERSONA_NAME,
      ...oracleGpuEnv
    },
    mounts: [
      ...resolveFolderMounts(storageLayout, "scriptarr-oracle", ["logs"]),
      ...resolveFolderMounts(storageLayout, "scriptarr-localai", ["models", "data"])
    ],
    networkAliases: ["scriptarr-oracle"],
    publishedPorts: [],
    extraArgs: [...(oracleLocalAiProfile.runtimeArgs || []),
      ...(env.SCRIPTARR_ORACLE_CPUS ? ["--cpus", String(env.SCRIPTARR_ORACLE_CPUS)] : []),
      ...(env.SCRIPTARR_ORACLE_MEMORY ? ["--memory", String(env.SCRIPTARR_ORACLE_MEMORY)] : [])],
    healthCheck: buildPythonHttpHealthCheck(oraclePort),
    containerPort: oraclePort
  });

  for (const service of services) {
    const dnsServers = resolveServiceDnsServers(service.name, env);
    if (dnsServers !== undefined) service.dnsServers = dnsServers;
    service.hostId = topology.enabled ? topology.owners[service.name] : "local";
    if (topology.enabled && !service.hostId) {
      throw new Error(`The topology does not assign ${service.name}.`);
    }
    if (topology.enabled && ["scriptarr-sage", "scriptarr-portal", "scriptarr-oracle"].includes(service.name)) {
      const owner = topology.hosts.find((host) => host.id === service.hostId);
      service.publishedPorts = [{hostIp: owner.address, hostPort: service.containerPort, containerPort: service.containerPort}];
    }
    if (service.name === "scriptarr-moon" && normalizeString(env.SCRIPTARR_PUBLISH_HOST)) {
      service.publishedPorts = service.publishedPorts.map((port) => ({...port, hostIp: normalizeString(env.SCRIPTARR_PUBLISH_HOST)}));
    }
  }

  return {
    installMode: "default-bootstrap",
    stackMode,
    managedNetworkName,
    publicBaseUrl,
    callbackUrl,
    superuserId: env.SUPERUSER_ID || "",
    discordTokenConfigured: Boolean(env.DISCORD_TOKEN),
    noonaPersonaName: env.SCRIPTARR_NOONA_PERSONA_NAME || DEFAULT_NOONA_PERSONA_NAME,
    imageNamespace: normalizeString(env.SCRIPTARR_IMAGE_NAMESPACE) || undefined,
    imageTag: normalizeString(env.SCRIPTARR_IMAGE_TAG) || undefined,
    mysql: {
      mode: mysql.mode,
      host: mysql.host,
      port: mysql.port,
      database: mysql.database,
      user: mysql.user,
      passwordConfigured: mysql.passwordConfigured,
      managedServiceName: mysql.managedServiceName
    },
    serviceTokens,
    topology,
    allServices: services,
    services: topology.enabled ? services.filter((service) => service.hostId === topology.hostId) : services,
    storageLayout
  };
};

