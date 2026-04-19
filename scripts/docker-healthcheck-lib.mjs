import {buildTestStackEnvironment, createTestStackManager} from "../services/warden/core/testStackManager.mjs";
import {resolveServicePlan} from "../services/warden/config/servicePlan.mjs";
import {
  DEFAULT_NAMESPACE,
  DEFAULT_PROGRESS,
  DEFAULT_TAG,
  SCRIPTARR_DOCKER_SERVICES,
  ensureLocalImages,
  parseCliArgs
} from "./docker-services.mjs";

const normalizePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const allServicesHealthy = (services = []) =>
  services.length > 0
  && services.every((service) => service.running === true && ["healthy", "running"].includes(String(service.health || "").toLowerCase()));

/**
 * Convert CLI args into docker healthcheck options.
 *
 * @param {Record<string, string | boolean | string[]>} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   stackId: string,
 *   moonPort?: number,
 *   wardenPort?: number,
 *   dataRoot?: string,
 *   mysqlUrl?: string,
 *   namespace: string,
 *   tag: string,
 *   progress: string,
 *   skipBuild: boolean,
 *   noCache: boolean,
 *   keepRunning: boolean,
 *   timeoutMinutes: number,
 *   helperEnv: NodeJS.ProcessEnv
 * }}
 */
export const resolveDockerHealthcheckOptions = (args, env = process.env) => {
  const namespace = String(args.namespace || DEFAULT_NAMESPACE).trim().replace(/\/+$/, "");
  const tag = String(args.tag || DEFAULT_TAG).trim();
  const progress = String(args.progress || DEFAULT_PROGRESS).trim();

  return {
    stackId: String(args["stack-id"] || "healthcheck").trim() || "healthcheck",
    moonPort: args["moon-port"] ? normalizePositiveInteger(args["moon-port"], undefined) : undefined,
    wardenPort: args["warden-port"] ? normalizePositiveInteger(args["warden-port"], undefined) : undefined,
    dataRoot: typeof args["data-root"] === "string" ? String(args["data-root"]) : undefined,
    mysqlUrl: typeof args["mysql-url"] === "string" ? String(args["mysql-url"]) : undefined,
    namespace,
    tag,
    progress,
    skipBuild: args["skip-build"] === true,
    noCache: args["no-cache"] === true || String(args["no-cache"] || "").toLowerCase() === "true",
    keepRunning: args["keep-running"] === true,
    timeoutMinutes: normalizePositiveInteger(args["timeout-minutes"], 12),
    helperEnv: {
      ...env,
      SCRIPTARR_IMAGE_NAMESPACE: namespace,
      SCRIPTARR_IMAGE_TAG: tag
    }
  };
};

/**
 * Wait for all Warden-managed services in the test stack to report healthy.
 *
 * @param {{
 *   statusManager: ReturnType<typeof createTestStackManager>,
 *   stackId: string,
 *   timeoutMinutes?: number
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export const waitForHealthyStack = async ({
  statusManager,
  stackId,
  timeoutMinutes = 12
}) => {
  const timeoutMs = timeoutMinutes * 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    lastStatus = await statusManager.status({stackId});
    if (lastStatus.exists && lastStatus.health?.warden && lastStatus.health?.moon && allServicesHealthy(lastStatus.services)) {
      return lastStatus;
    }
    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for the Scriptarr Docker healthcheck stack to become healthy after ${timeoutMinutes} minute(s). Last status: ${JSON.stringify(lastStatus, null, 2)}`);
};

/**
 * Run the Scriptarr Docker healthcheck flow end to end.
 *
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv
 * }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export const runDockerHealthcheck = async ({
  argv = process.argv.slice(2),
  env = process.env
} = {}) => {
  const args = parseCliArgs(argv);
  const options = resolveDockerHealthcheckOptions(args, env);
  const built = buildTestStackEnvironment({
    env: options.helperEnv,
    stackId: options.stackId,
    moonPort: options.moonPort,
    wardenPort: options.wardenPort,
    dataRoot: options.dataRoot,
    mysqlUrl: options.mysqlUrl
  });
  const statusManager = createTestStackManager({env: options.helperEnv});

  if (!options.skipBuild) {
    const runtimePlan = resolveServicePlan({
      env: built.env,
      containerNamePrefix: `scriptarr-test-${built.stackId}`
    });
    const selected = SCRIPTARR_DOCKER_SERVICES.filter((entry) =>
      entry.name === "scriptarr-warden" || runtimePlan.services.some((service) => service.name === entry.name)
    );

    await ensureLocalImages(selected, {
      namespace: options.namespace,
      tag: options.tag,
      progress: options.progress,
      forceBuild: true,
      noCache: options.noCache
    });
  }

  const started = await statusManager.start({
    stackId: built.stackId,
    moonPort: built.moonPort,
    wardenPort: built.wardenPort,
    dataRoot: built.dataRoot,
    mysqlUrl: options.mysqlUrl,
    removeDataRootOnStop: options.keepRunning ? false : undefined
  });

  try {
    const healthy = await waitForHealthyStack({
      statusManager,
      stackId: built.stackId,
      timeoutMinutes: options.timeoutMinutes
    });

    return {
      ok: true,
      started,
      healthy
    };
  } finally {
    if (!options.keepRunning) {
      await statusManager.stop({
        stackId: built.stackId,
        tolerateMissing: true
      });
    }
  }
};

