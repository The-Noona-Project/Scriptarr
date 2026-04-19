import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

import {
  DEFAULT_TEST_MOON_PORT,
  DEFAULT_TEST_STACK_ID,
  DEFAULT_TEST_WARDEN_PORT,
  DEFAULT_WARDEN_HOST_ALIAS
} from "../config/constants.mjs";
import {resolveServicePlan} from "../config/servicePlan.mjs";
import {ensureScriptarrStorageFolders, resolveEphemeralTestDataRoot, resolveTestStateDirectory} from "../filesystem/storageLayout.mjs";
import {containerExists, ensureDockerNetwork, removeDockerContainer, removeDockerNetwork, runDetachedContainer, waitForHttp, waitForMySqlReady} from "../docker/dockerCli.mjs";
import {createLogger} from "../logging/createLogger.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIRECTORY, "../../..");

const normalizeString = (value) => String(value ?? "").trim();

const resolvePort = (value, fallback) => {
  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Normalize a test stack id into a Docker-safe suffix.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export const normalizeTestStackId = (value) => {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || DEFAULT_TEST_STACK_ID;
};

const resolveStateFilePath = (stackId) =>
  path.join(resolveTestStateDirectory({tmpDir: os.tmpdir()}), `${normalizeTestStackId(stackId)}.json`);

const ensureStateDirectory = async () => {
  await fsPromises.mkdir(resolveTestStateDirectory({tmpDir: os.tmpdir()}), {
    recursive: true
  });
};

const readStateFile = async (stackId) => {
  const statePath = resolveStateFilePath(stackId);
  const raw = await fsPromises.readFile(statePath, "utf8");
  return {
    statePath,
    payload: JSON.parse(raw)
  };
};

const writeStateFile = async (stackId, payload) => {
  const statePath = resolveStateFilePath(stackId);
  await ensureStateDirectory();
  await fsPromises.writeFile(statePath, JSON.stringify(payload, null, 2), "utf8");
  return statePath;
};

const removeStateFile = async (stackId) => {
  try {
    await fsPromises.unlink(resolveStateFilePath(stackId));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
};

/**
 * Build the environment Warden uses for an ephemeral Docker-backed stack.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   stackId?: string,
 *   dataRoot?: string,
 *   moonPort?: number,
 *   wardenPort?: number,
 *   mysqlUrl?: string
 * }} [options]
 * @returns {{
 *   stackId: string,
 *   moonPort: number,
 *   wardenPort: number,
 *   dataRoot: string,
 *   env: NodeJS.ProcessEnv
 * }}
 */
export const buildTestStackEnvironment = ({
  env = process.env,
  stackId = DEFAULT_TEST_STACK_ID,
  dataRoot,
  moonPort = DEFAULT_TEST_MOON_PORT,
  wardenPort = DEFAULT_TEST_WARDEN_PORT,
  mysqlUrl = "SELFHOST"
} = {}) => {
  const normalizedStackId = normalizeTestStackId(stackId);
  const resolvedMoonPort = resolvePort(moonPort, DEFAULT_TEST_MOON_PORT);
  const resolvedWardenPort = resolvePort(wardenPort, DEFAULT_TEST_WARDEN_PORT);
  const resolvedDataRoot = dataRoot || resolveEphemeralTestDataRoot({stackId: normalizedStackId});
  const managedNetworkName = `scriptarr-network-test-${normalizedStackId}`;
  const publicBaseUrl = `http://127.0.0.1:${resolvedMoonPort}`;

  return {
    stackId: normalizedStackId,
    moonPort: resolvedMoonPort,
    wardenPort: resolvedWardenPort,
    dataRoot: resolvedDataRoot,
    env: {
      ...env,
      NODE_ENV: env.NODE_ENV || "development",
      SCRIPTARR_STACK_MODE: "test",
      SCRIPTARR_DATA_ROOT: resolvedDataRoot,
      SCRIPTARR_NETWORK_NAME: managedNetworkName,
      SCRIPTARR_MOON_PUBLIC_PORT: String(resolvedMoonPort),
      SCRIPTARR_PUBLIC_BASE_URL: publicBaseUrl,
      SCRIPTARR_WARDEN_PORT: String(resolvedWardenPort),
      SCRIPTARR_WARDEN_BASE_URL: `http://${DEFAULT_WARDEN_HOST_ALIAS}:${resolvedWardenPort}`,
      SCRIPTARR_MYSQL_URL: normalizeString(mysqlUrl) || "SELFHOST",
      SCRIPTARR_MYSQL_USER: normalizeString(env.SCRIPTARR_MYSQL_USER) || "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: normalizeString(env.SCRIPTARR_MYSQL_PASSWORD) || "scriptarr-dev-password",
      SUPERUSER_ID: normalizeString(env.SUPERUSER_ID) || "test-superuser",
      DISCORD_TOKEN: normalizeString(env.DISCORD_TOKEN) || "test-discord-token"
    }
  };
};

const spawnDetachedWarden = async ({env, dataRoot, logger}) => {
  const logDirectory = path.join(dataRoot, "warden", "logs");
  const logFile = path.join(logDirectory, "test-stack.log");

  await fsPromises.mkdir(logDirectory, {recursive: true});
  const outputHandle = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, ["services/warden/server.mjs"], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ["ignore", outputHandle, outputHandle]
  });
  fs.closeSync(outputHandle);

  child.unref();
  logger.info("Spawned detached Warden test server.", {
    pid: child.pid,
    logFile
  });

  return {
    pid: child.pid,
    logFile
  };
};

const terminateProcessTree = (pid) => new Promise((resolve, reject) => {
  if (!pid) {
    resolve(false);
    return;
  }

  if (process.platform === "win32") {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || code === 128) {
        resolve(true);
        return;
      }
      reject(new Error(`taskkill failed for PID ${pid} with exit ${code}`));
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    resolve(true);
  } catch (error) {
    if (error?.code === "ESRCH") {
      resolve(false);
      return;
    }
    reject(error);
  }
});

/**
 * Create the Warden-managed Docker test stack helper.
 *
 * @param {{env?: NodeJS.ProcessEnv, logger?: ReturnType<typeof createLogger>}} [options]
 * @returns {{
 *   start: (options?: {
 *     stackId?: string,
 *     dataRoot?: string,
 *     moonPort?: number,
 *     wardenPort?: number,
 *     mysqlUrl?: string,
 *     removeDataRootOnStop?: boolean
 *   }) => Promise<Record<string, unknown>>,
 *   stop: (options?: {stackId?: string, tolerateMissing?: boolean}) => Promise<Record<string, unknown>>,
 *   status: (options?: {stackId?: string}) => Promise<Record<string, unknown>>
 * }}
 */
export const createTestStackManager = ({env = process.env, logger = createLogger("WARDEN_TEST_STACK", {env})} = {}) => {
  const start = async ({
    stackId = DEFAULT_TEST_STACK_ID,
    dataRoot,
    moonPort = DEFAULT_TEST_MOON_PORT,
    wardenPort = DEFAULT_TEST_WARDEN_PORT,
    mysqlUrl = "SELFHOST",
    removeDataRootOnStop
  } = {}) => {
    const built = buildTestStackEnvironment({
      env,
      stackId,
      dataRoot,
      moonPort,
      wardenPort,
      mysqlUrl
    });

    await stop({
      stackId: built.stackId,
      tolerateMissing: true
    });

    await ensureScriptarrStorageFolders(built.dataRoot);

    const runtimePlan = resolveServicePlan({
      env: built.env,
      containerNamePrefix: `scriptarr-test-${built.stackId}`
    });

    await ensureDockerNetwork(runtimePlan.managedNetworkName);
    const wardenProcess = await spawnDetachedWarden({
      env: built.env,
      dataRoot: built.dataRoot,
      logger
    });

    await waitForHttp(`http://127.0.0.1:${built.wardenPort}/health`, {
      timeoutMs: 30000,
      intervalMs: 1000
    });

    const extraHosts = process.platform === "linux"
      ? [`${DEFAULT_WARDEN_HOST_ALIAS}:host-gateway`]
      : [];

    for (const service of runtimePlan.services) {
      await removeDockerContainer(service.containerName);
      logger.info("Starting test stack service.", {
        service: service.name,
        container: service.containerName
      });
      await runDetachedContainer({
        name: service.containerName,
        image: service.image,
        env: service.env,
        networkName: runtimePlan.managedNetworkName,
        networkAliases: service.networkAliases,
        mounts: service.mounts,
        publishedPorts: service.publishedPorts,
        extraHosts,
        labels: {
          "scriptarr.stack-id": built.stackId,
          "scriptarr.stack-mode": "test",
          "scriptarr.service": service.name
        }
      });

      if (service.name === "scriptarr-mysql") {
        await waitForMySqlReady({
          containerName: service.containerName,
          password: runtimePlan.mysql.passwordConfigured
            ? built.env.SCRIPTARR_MYSQL_PASSWORD
            : "scriptarr-dev-password"
        });
      }
    }

    await waitForHttp(`http://127.0.0.1:${built.moonPort}/health`, {
      timeoutMs: 120000,
      intervalMs: 1500
    });
    await waitForHttp(`http://127.0.0.1:${built.moonPort}/api/moon/auth/bootstrap-status`, {
      timeoutMs: 120000,
      intervalMs: 1500
    });

    const payload = {
      version: 1,
      stackId: built.stackId,
      stackMode: "test",
      managedNetworkName: runtimePlan.managedNetworkName,
      dataRoot: built.dataRoot,
      removeDataRootOnStop: removeDataRootOnStop ?? !dataRoot,
      warden: {
        pid: wardenProcess.pid,
        port: built.wardenPort,
        logFile: wardenProcess.logFile,
        healthUrl: `http://127.0.0.1:${built.wardenPort}/health`
      },
      moon: {
        port: built.moonPort,
        publicBaseUrl: built.env.SCRIPTARR_PUBLIC_BASE_URL,
        healthUrl: `http://127.0.0.1:${built.moonPort}/health`
      },
      mysql: runtimePlan.mysql,
      services: runtimePlan.services.map((service) => ({
        name: service.name,
        containerName: service.containerName,
        image: service.image
      })),
      startedAt: new Date().toISOString()
    };

    const statePath = await writeStateFile(built.stackId, payload);

    return {
      started: true,
      statePath,
      ...payload
    };
  };

  const stop = async ({stackId = DEFAULT_TEST_STACK_ID, tolerateMissing = false} = {}) => {
    let state;
    try {
      const loaded = await readStateFile(stackId);
      state = loaded.payload;
    } catch (error) {
      if (tolerateMissing && error?.code === "ENOENT") {
        return {
          stopped: false,
          reason: "No saved test stack state was found."
        };
      }
      throw error;
    }

    for (const service of state.services || []) {
      await removeDockerContainer(service.containerName, {ignoreMissing: true});
    }

    await removeDockerNetwork(state.managedNetworkName, {ignoreMissing: true});

    if (state.warden?.pid) {
      try {
        await terminateProcessTree(state.warden.pid);
      } catch (error) {
        logger.warn("Failed to terminate the detached Warden test server cleanly.", {
          pid: state.warden.pid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (state.removeDataRootOnStop && state.dataRoot) {
      await fsPromises.rm(state.dataRoot, {
        recursive: true,
        force: true
      });
    }

    await removeStateFile(state.stackId);

    return {
      stopped: true,
      stackId: state.stackId,
      managedNetworkName: state.managedNetworkName,
      removedContainers: (state.services || []).map((service) => service.containerName),
      removedDataRoot: Boolean(state.removeDataRootOnStop && state.dataRoot)
    };
  };

  const status = async ({stackId = DEFAULT_TEST_STACK_ID} = {}) => {
    try {
      const {payload, statePath} = await readStateFile(stackId);
      const services = await Promise.all((payload.services || []).map(async (service) => ({
        ...service,
        running: await containerExists(service.containerName)
      })));

      const [wardenHealthy, moonHealthy] = await Promise.all([
        fetch(payload.warden.healthUrl).then((response) => response.ok).catch(() => false),
        fetch(payload.moon.healthUrl).then((response) => response.ok).catch(() => false)
      ]);

      return {
        exists: true,
        statePath,
        ...payload,
        services,
        health: {
          warden: wardenHealthy,
          moon: moonHealthy
        }
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          exists: false,
          stackId: normalizeTestStackId(stackId)
        };
      }

      throw error;
    }
  };

  return {
    start,
    stop,
    status
  };
};
