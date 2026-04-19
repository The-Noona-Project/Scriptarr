import {resolveDiscordCallbackUrl} from "../config/servicePlan.mjs";
import {resolveWardenRuntimeSnapshot, resolveWardenServerConfig} from "../config/runtimeConfig.mjs";
import {createLogger} from "../logging/createLogger.mjs";
import {createLocalAiRuntime} from "./localAiRuntime.mjs";

/**
 * Assemble the Warden runtime object shared by the API routes and the repo
 * helper scripts.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{
 *   config: {port: number, host: string | undefined, stackMode: string},
 *   logger: ReturnType<typeof createLogger>,
 *   getRuntime: () => ReturnType<typeof resolveWardenRuntimeSnapshot>,
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
 *   getLocalAiStatus: () => Record<string, unknown>,
 *   refreshLocalAiStatus: () => Promise<Record<string, unknown>>,
 *   configureLocalAi: (payload?: {profileKey?: string, imageMode?: string, customImage?: string}) => Promise<Record<string, unknown>>,
 *   installLocalAi: () => Promise<Record<string, unknown>>,
 *   startLocalAi: () => Promise<Record<string, unknown>>,
 *   getDiscordCallbackUrl: () => string
 * }}
 */
export const createWardenRuntime = ({env = process.env} = {}) => {
  const config = resolveWardenServerConfig({env});
  const logger = createLogger("WARDEN", {env});
  const localAi = createLocalAiRuntime({
    env,
    logger: createLogger("WARDEN_LOCALAI", {env})
  });

  const getRuntime = () =>
    resolveWardenRuntimeSnapshot({
      env,
      localAiStatus: localAi.getStatus()
    });

  return {
    config,
    logger,
    getRuntime,
    getBootstrap: () => {
      const runtime = getRuntime();
      return {
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
      };
    },
    getStorageLayout: () => getRuntime().storage,
    getLocalAiStatus: () => localAi.getStatus(),
    refreshLocalAiStatus: () => localAi.refreshStatus(),
    configureLocalAi: (payload) => localAi.configure(payload),
    installLocalAi: () => localAi.install(),
    startLocalAi: () => localAi.start(),
    getDiscordCallbackUrl: () => resolveDiscordCallbackUrl({env})
  };
};
