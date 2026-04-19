import {
  DEFAULT_STACK_MODE,
  DEFAULT_WARDEN_PORT
} from "./constants.mjs";
import {resolveLocalAiProfile} from "./localAiProfiles.mjs";
import {resolveServicePlan} from "./servicePlan.mjs";
import {describeScriptarrStorageLayout, resolveScriptarrDataRoot} from "../filesystem/storageLayout.mjs";

const normalizeString = (value) => String(value ?? "").trim();

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
 * @param {{env?: NodeJS.ProcessEnv, localAiStatus?: Record<string, unknown> | null}} [options]
 * @returns {ReturnType<typeof resolveServicePlan> & {
 *   localAi: Record<string, unknown>,
 *   storage: ReturnType<typeof describeScriptarrStorageLayout>
 * }}
 */
export const resolveWardenRuntimeSnapshot = ({env = process.env, localAiStatus = null} = {}) => {
  const plan = resolveServicePlan({env});

  return {
    ...plan,
    localAi: localAiStatus || {
      ...resolveLocalAiProfile({env}),
      installOnFirstBoot: false,
      lifecycle: "manual"
    },
    storage: describeScriptarrStorageLayout(resolveScriptarrDataRoot({env}))
  };
};
