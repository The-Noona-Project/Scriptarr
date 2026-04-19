import {
  DEFAULT_LOCALAI_PORT,
  DEFAULT_MOON_PORT,
  DEFAULT_MOON_PUBLIC_PORT,
  DEFAULT_NETWORK_NAME,
  DEFAULT_NOONA_PERSONA_NAME,
  DEFAULT_ORACLE_PORT,
  DEFAULT_PORTAL_PORT,
  DEFAULT_PUBLIC_BASE_URL,
  DEFAULT_RAVEN_PORT,
  DEFAULT_SAGE_PORT,
  DEFAULT_STACK_MODE,
  DEFAULT_VAULT_PORT,
  DEFAULT_WARDEN_PORT,
  DEFAULT_WARDEN_SERVICE_BASE_URL
} from "./constants.mjs";
import {resolveServiceImage} from "./images.mjs";
import {resolveMysqlConfig, toInternalMysqlEnv} from "./mysqlConfig.mjs";
import {buildScriptarrStorageLayout, resolveScriptarrDataRoot} from "../filesystem/storageLayout.mjs";

const normalizeString = (value) => String(value ?? "").trim();

const resolvePort = (value, fallback) => {
  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const defaultTokenMap = (env = process.env) => ({
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

const resolveFolderMounts = (layout, serviceName, keys) =>
  keys
    .map((key) => layout.services?.[serviceName]?.[key] || null)
    .filter(Boolean);

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
 *     publishedPorts: Array<{hostPort: number, containerPort: number}>,
 *     containerPort: number
 *   }>,
 *   storageLayout: ReturnType<typeof buildScriptarrStorageLayout>
 * }}
 */
export const resolveServicePlan = ({env = process.env, containerNamePrefix = ""} = {}) => {
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
  const wardenBaseUrlForServices = normalizeString(env.SCRIPTARR_WARDEN_BASE_URL) || DEFAULT_WARDEN_SERVICE_BASE_URL;
  const localAiBaseUrl = normalizeString(env.SCRIPTARR_LOCALAI_BASE_URL) || `http://scriptarr-localai:${DEFAULT_LOCALAI_PORT}/v1`;

  /** @type {ReturnType<typeof resolveServicePlan>["services"]} */
  const services = [];

  if (mysql.mode === "selfhost") {
    services.push({
      name: "scriptarr-mysql",
      containerName: resolveContainerName("scriptarr-mysql", containerNamePrefix),
      image: "mysql:8.4",
      env: {
        MYSQL_ROOT_PASSWORD: mysql.password,
        MYSQL_DATABASE: mysql.database,
        MYSQL_USER: mysql.user,
        MYSQL_PASSWORD: mysql.password
      },
      mounts: resolveFolderMounts(storageLayout, "scriptarr-mysql", ["data"]),
      networkAliases: ["scriptarr-mysql"],
      publishedPorts: [],
      containerPort: mysql.port
    });
  }

  services.push({
    name: "scriptarr-vault",
    containerName: resolveContainerName("scriptarr-vault", containerNamePrefix),
    image: resolveServiceImage("scriptarr-vault", {env}),
    env: {
      SCRIPTARR_VAULT_DRIVER: env.SCRIPTARR_VAULT_DRIVER || "mysql",
      ...mysqlEnv,
      SCRIPTARR_SERVICE_TOKENS: JSON.stringify(serviceTokens),
      SCRIPTARR_VAULT_PORT: String(vaultPort)
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-vault", ["logs"]),
    networkAliases: ["scriptarr-vault"],
    publishedPorts: [],
    containerPort: vaultPort
  });

  services.push({
    name: "scriptarr-sage",
    containerName: resolveContainerName("scriptarr-sage", containerNamePrefix),
    image: resolveServiceImage("scriptarr-sage", {env}),
    env: {
      SCRIPTARR_VAULT_BASE_URL: `http://scriptarr-vault:${vaultPort}`,
      SCRIPTARR_WARDEN_BASE_URL: wardenBaseUrlForServices,
      SCRIPTARR_PORTAL_BASE_URL: `http://scriptarr-portal:${portalPort}`,
      SCRIPTARR_ORACLE_BASE_URL: `http://scriptarr-oracle:${oraclePort}`,
      SCRIPTARR_RAVEN_BASE_URL: `http://scriptarr-raven:${ravenPort}`,
      SCRIPTARR_PUBLIC_BASE_URL: publicBaseUrl,
      SCRIPTARR_SERVICE_TOKEN: serviceTokens["scriptarr-sage"],
      SCRIPTARR_DISCORD_CALLBACK_URL: callbackUrl,
      SCRIPTARR_SAGE_PORT: String(sagePort),
      SUPERUSER_ID: env.SUPERUSER_ID || "",
      SCRIPTARR_DISCORD_TOKEN: env.DISCORD_TOKEN || "",
      DISCORD_TOKEN: env.DISCORD_TOKEN || "",
      SCRIPTARR_DISCORD_CLIENT_ID: env.SCRIPTARR_DISCORD_CLIENT_ID || "",
      SCRIPTARR_DISCORD_CLIENT_SECRET: env.SCRIPTARR_DISCORD_CLIENT_SECRET || "",
      SCRIPTARR_AUTO_PROVISION_DISCORD_USERS: env.SCRIPTARR_AUTO_PROVISION_DISCORD_USERS || "true"
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-sage", ["logs"]),
    networkAliases: ["scriptarr-sage"],
    publishedPorts: [],
    containerPort: sagePort
  });

  services.push({
    name: "scriptarr-moon",
    containerName: resolveContainerName("scriptarr-moon", containerNamePrefix),
    image: resolveServiceImage("scriptarr-moon", {env}),
    env: {
      SCRIPTARR_SAGE_BASE_URL: `http://scriptarr-sage:${sagePort}`,
      SCRIPTARR_MOON_PORT: String(moonPort)
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-moon", ["logs"]),
    networkAliases: ["scriptarr-moon"],
    publishedPorts: [{hostPort: moonPublicPort, containerPort: moonPort}],
    containerPort: moonPort
  });

  services.push({
    name: "scriptarr-raven",
    containerName: resolveContainerName("scriptarr-raven", containerNamePrefix),
    image: resolveServiceImage("scriptarr-raven", {env}),
    env: {
      SCRIPTARR_VAULT_BASE_URL: `http://scriptarr-vault:${vaultPort}`,
      SCRIPTARR_SERVICE_TOKEN: serviceTokens["scriptarr-raven"],
      SCRIPTARR_RAVEN_DATA_ROOT: "/downloads"
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-raven", ["downloads", "logs"]),
    networkAliases: ["scriptarr-raven"],
    publishedPorts: [],
    containerPort: ravenPort
  });

  services.push({
    name: "scriptarr-portal",
    containerName: resolveContainerName("scriptarr-portal", containerNamePrefix),
    image: resolveServiceImage("scriptarr-portal", {env}),
    env: {
      SCRIPTARR_VAULT_BASE_URL: `http://scriptarr-vault:${vaultPort}`,
      SCRIPTARR_ORACLE_BASE_URL: `http://scriptarr-oracle:${oraclePort}`,
      SCRIPTARR_PORTAL_PORT: String(portalPort),
      DISCORD_TOKEN: env.DISCORD_TOKEN || ""
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-portal", ["logs"]),
    networkAliases: ["scriptarr-portal"],
    publishedPorts: [],
    containerPort: portalPort
  });

  services.push({
    name: "scriptarr-oracle",
    containerName: resolveContainerName("scriptarr-oracle", containerNamePrefix),
    image: resolveServiceImage("scriptarr-oracle", {env}),
    env: {
      SCRIPTARR_VAULT_BASE_URL: `http://scriptarr-vault:${vaultPort}`,
      SCRIPTARR_SERVICE_TOKEN: serviceTokens["scriptarr-oracle"],
      SCRIPTARR_LOCALAI_BASE_URL: localAiBaseUrl,
      SCRIPTARR_WARDEN_BASE_URL: wardenBaseUrlForServices,
      SCRIPTARR_ORACLE_PORT: String(oraclePort),
      SCRIPTARR_NOONA_PERSONA_NAME: env.SCRIPTARR_NOONA_PERSONA_NAME || DEFAULT_NOONA_PERSONA_NAME
    },
    mounts: resolveFolderMounts(storageLayout, "scriptarr-oracle", ["logs"]),
    networkAliases: ["scriptarr-oracle"],
    publishedPorts: [],
    containerPort: oraclePort
  });

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
    services,
    storageLayout
  };
};
