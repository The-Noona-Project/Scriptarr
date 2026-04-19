/**
 * @file Scriptarr Warden module: services/warden/config/runtimeConfig.mjs.
 */
import {
  DEFAULT_DOCKER_SOCKET_PATH,
  DEFAULT_NETWORK_NAME,
  DEFAULT_STACK_MODE,
  DEFAULT_WARDEN_CONTAINER_NAME,
  DEFAULT_WARDEN_PORT
} from "./constants.mjs";
import {resolveLocalAiProfile} from "./localAiProfiles.mjs";
import {resolveServicePlan} from "./servicePlan.mjs";
import {describeScriptarrStorageLayout, resolveScriptarrDataRoot} from "../filesystem/storageLayout.mjs";

const normalizeString = (value) => String(value ?? "").trim();

const defaultWardenRuntimeStatus = ({env = process.env} = {}) => ({
  containerName: normalizeString(env.SCRIPTARR_WARDEN_CONTAINER_NAME) || DEFAULT_WARDEN_CONTAINER_NAME,
  containerRef: normalizeString(env.HOSTNAME) || normalizeString(env.SCRIPTARR_WARDEN_CONTAINER_NAME) || DEFAULT_WARDEN_CONTAINER_NAME,
  dockerSocketAvailable: false,
  dockerSocketPath: DEFAULT_DOCKER_SOCKET_PATH,
  runningInsideDocker: false,
  attachedNetworks: [],
  managedNetworkName: normalizeString(env.SCRIPTARR_NETWORK_NAME) || DEFAULT_NETWORK_NAME,
  attachedToManagedNetwork: false,
  health: "unknown",
  lastReconciledAt: null,
  lastError: null
});

/**
 * Resolve the HTTP bind configuration for the Warden API server.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{port: number, host: string | undefined, stackMode: string}}
 */
export const resolveWardenServerConfig = ({env = process.env} = {}) => {
  const parsedPort = Number.parseInt(normalizeString(env.SCRIPTARR_WARDEN_PORT), 10);

  return {
    port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_WARDEN_PORT,
    host: normalizeString(env.SCRIPTARR_WARDEN_HOST) || undefined,
    stackMode: normalizeString(env.SCRIPTARR_STACK_MODE) || DEFAULT_STACK_MODE
  };
};

/**
 * Resolve the Warden runtime snapshot returned by `/api/runtime`.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   localAiStatus?: Record<string, unknown> | null,
 *   runtimeStatus?: {
 *     warden?: Record<string, unknown>,
 *     managedServices?: Array<Record<string, unknown>>
 *   } | null
 * }} [options]
 * @returns {ReturnType<typeof resolveServicePlan> & {
 *   localAi: Record<string, unknown>,
 *   storage: ReturnType<typeof describeScriptarrStorageLayout>,
 *   warden: Record<string, unknown>,
 *   managedServices: Array<Record<string, unknown>>
 * }}
 */
export const resolveWardenRuntimeSnapshot = ({env = process.env, localAiStatus = null, runtimeStatus = null} = {}) => {
  const plan = resolveServicePlan({env});

  return {
    ...plan,
    localAi: localAiStatus || {
      ...resolveLocalAiProfile({env}),
      installOnFirstBoot: false,
      lifecycle: "manual"
    },
    storage: describeScriptarrStorageLayout(resolveScriptarrDataRoot({env})),
    warden: runtimeStatus?.warden || defaultWardenRuntimeStatus({env}),
    managedServices: runtimeStatus?.managedServices || []
  };
};

