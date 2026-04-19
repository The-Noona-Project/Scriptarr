/**
 * @file Scriptarr Warden module: services/warden/core/createWardenRuntime.mjs.
 */
import {resolveDiscordCallbackUrl} from "../config/servicePlan.mjs";
import {resolveWardenRuntimeSnapshot, resolveWardenServerConfig, sanitizeWardenRuntimeSnapshot} from "../config/runtimeConfig.mjs";
import {createLogger} from "../logging/createLogger.mjs";
import {createLocalAiRuntime} from "./localAiRuntime.mjs";
import {createManagedStackRuntime} from "./managedStackRuntime.mjs";
import {createUpdateRuntime} from "./updateRuntime.mjs";

/**
 * Assemble the Warden runtime object shared by the API routes and the repo
 * helper scripts.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{
 *   config: {port: number, host: string | undefined, stackMode: string},
 *   logger: ReturnType<typeof createLogger>,
 *   initialize: () => Promise<void>,
 *   getRuntime: () => Promise<ReturnType<typeof resolveWardenRuntimeSnapshot>>,
 *   getBootstrap: () => {
 *     installMode: string,
 *     stackMode: string,
 *     managedNetworkName: string,
 *     callbackUrl: string,
 *     superuserRequired: boolean,
 *     discordTokenConfigured: boolean,
 *     mysql: ReturnType<typeof resolveWardenRuntimeSnapshot>["mysql"],
 *     localAi: Record<string, unknown>,
 *     services: Array<{name: string, image: string, containerName: string}>
 *   },
 *   getStorageLayout: () => ReturnType<typeof resolveWardenRuntimeSnapshot>["storage"],
 *   getHealth: () => Promise<Record<string, unknown>>,
 *   getLocalAiStatus: () => Record<string, unknown>,
 *   refreshLocalAiStatus: () => Promise<Record<string, unknown>>,
 *   configureLocalAi: (payload?: {profileKey?: string, imageMode?: string, customImage?: string}) => Promise<Record<string, unknown>>,
 *   installLocalAi: () => Promise<Record<string, unknown>>,
 *   startLocalAi: () => Promise<Record<string, unknown>>,
 *   getUpdates: () => Promise<Record<string, unknown>>,
 *   checkUpdates: (requestedServices?: string[]) => Promise<Record<string, unknown>>,
 *   installUpdates: (requestedServices?: string[]) => Promise<Record<string, unknown>>,
 *   getDiscordCallbackUrl: () => string
 * }}
 */
export const createWardenRuntime = ({
  env = process.env,
  loggerFactory = createLogger,
  localAiRuntimeFactory = createLocalAiRuntime,
  managedStackRuntimeFactory = createManagedStackRuntime,
  updateRuntimeFactory = createUpdateRuntime
} = {}) => {
  const config = resolveWardenServerConfig({env});
  const logger = loggerFactory("WARDEN", {env});
  const localAi = localAiRuntimeFactory({
    env,
    logger: loggerFactory("WARDEN_LOCALAI", {env})
  });
  const managedStack = managedStackRuntimeFactory({
    env,
    logger: loggerFactory("WARDEN_STACK", {env})
  });
  const updates = updateRuntimeFactory({
    env,
    logger: loggerFactory("WARDEN_UPDATES", {env}),
    managedStack
  });

  const buildRuntimeSnapshot = async () =>
    resolveWardenRuntimeSnapshot({
      env,
      localAiStatus: localAi.getStatus(),
      runtimeStatus: await managedStack.refreshStatus()
    });

  const getRuntime = async () => sanitizeWardenRuntimeSnapshot(await buildRuntimeSnapshot());

  return {
    config,
    logger,
    initialize: async () => {
      await managedStack.initialize();
      try {
        await localAi.initialize();
      } catch (error) {
        logger.warn("LocalAI runtime refresh failed during Warden initialization.", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    },
    getRuntime,
    getBootstrap: () => {
      const runtime = resolveWardenRuntimeSnapshot({
        env,
        localAiStatus: localAi.getStatus(),
        runtimeStatus: managedStack.getStatusSnapshot()
      });
      return sanitizeWardenRuntimeSnapshot({
        installMode: runtime.installMode,
        stackMode: runtime.stackMode,
        managedNetworkName: runtime.managedNetworkName,
        callbackUrl: runtime.callbackUrl,
        superuserRequired: Boolean(runtime.superuserId),
        discordTokenConfigured: runtime.discordTokenConfigured,
        mysql: runtime.mysql,
        localAi: runtime.localAi,
        services: runtime.services.map((service) => ({
          name: service.name,
          image: service.image,
          containerName: service.containerName
        }))
      });
    },
    getStorageLayout: () => resolveWardenRuntimeSnapshot({
      env,
      localAiStatus: localAi.getStatus(),
      runtimeStatus: managedStack.getStatusSnapshot()
    }).storage,
    getHealth: async () => {
      const runtime = await getRuntime();
      return {
        ok: Boolean(runtime.warden.dockerSocketAvailable) && !runtime.warden.lastError,
        service: "scriptarr-warden",
        stackMode: runtime.stackMode,
        dockerSocketAvailable: runtime.warden.dockerSocketAvailable,
        attachedToManagedNetwork: runtime.warden.attachedToManagedNetwork,
        lastReconciledAt: runtime.warden.lastReconciledAt,
        error: runtime.warden.lastError
      };
    },
    getLocalAiStatus: () => localAi.getStatus(),
    refreshLocalAiStatus: () => localAi.refreshStatus(),
    configureLocalAi: (payload) => localAi.configure(payload),
    installLocalAi: () => localAi.install(),
    startLocalAi: () => localAi.start(),
    getUpdates: () => updates.getStatus(),
    checkUpdates: (requestedServices) => updates.checkForUpdates(requestedServices),
    installUpdates: (requestedServices) => updates.installUpdates(requestedServices),
    getDiscordCallbackUrl: () => resolveDiscordCallbackUrl({env})
  };
};

