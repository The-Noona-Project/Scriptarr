/**
 * @file Scriptarr Warden module: services/warden/core/testStackManager.mjs.
 */
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TEST_MOON_PORT,
  DEFAULT_TEST_STACK_ID,
  DEFAULT_TEST_WARDEN_PORT,
  DEFAULT_WARDEN_PORT
} from "../config/constants.mjs";
import {resolveServiceImage} from "../config/images.mjs";
import {resolveServicePlan} from "../config/servicePlan.mjs";
import {ensureScriptarrStorageFolders, resolveEphemeralTestDataRoot, resolveTestStateDirectory} from "../filesystem/storageLayout.mjs";
import {
  containerExists,
  listContainersByLabel,
  removeDockerContainer,
  removeDockerNetwork,
  runDetachedContainer,
  waitForHttp
} from "../docker/dockerCli.mjs";
import {createLogger} from "../logging/createLogger.mjs";

const normalizeString = (value) => String(value ?? "").trim();

const resolvePort = (value, fallback) => {
  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Normalize a test stack id into a Docker-safe identifier.
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

const resolveStateFilePath = (stackId, stateDirectory = resolveTestStateDirectory({tmpDir: os.tmpdir()})) =>
  path.join(stateDirectory, `${normalizeTestStackId(stackId)}.json`);

const ensureStateDirectory = async (fsModule = fsPromises, stateDirectory = resolveTestStateDirectory({tmpDir: os.tmpdir()})) => {
  await fsModule.mkdir(stateDirectory, {
    recursive: true
  });
};

const readStateFile = async (stackId, fsModule = fsPromises, stateDirectory = resolveTestStateDirectory({tmpDir: os.tmpdir()})) => {
  const statePath = resolveStateFilePath(stackId, stateDirectory);
  const raw = await fsModule.readFile(statePath, "utf8");
  return {
    statePath,
    payload: JSON.parse(raw)
  };
};

const writeStateFile = async (stackId, payload, fsModule = fsPromises, stateDirectory = resolveTestStateDirectory({tmpDir: os.tmpdir()})) => {
  const statePath = resolveStateFilePath(stackId, stateDirectory);
  await ensureStateDirectory(fsModule, stateDirectory);
  await fsModule.writeFile(statePath, JSON.stringify(payload, null, 2), "utf8");
  return statePath;
};

const removeStateFile = async (stackId, fsModule = fsPromises, stateDirectory = resolveTestStateDirectory({tmpDir: os.tmpdir()})) => {
  try {
    await fsModule.unlink(resolveStateFilePath(stackId, stateDirectory));
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
 *   wardenContainerName: string,
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
  const wardenContainerName = `scriptarr-test-${normalizedStackId}-warden`;

  return {
    stackId: normalizedStackId,
    moonPort: resolvedMoonPort,
    wardenPort: resolvedWardenPort,
    wardenContainerName,
    dataRoot: resolvedDataRoot,
    env: {
      ...env,
      NODE_ENV: env.NODE_ENV || "development",
      SCRIPTARR_STACK_MODE: "test",
      SCRIPTARR_STACK_ID: normalizedStackId,
      SCRIPTARR_DATA_ROOT: resolvedDataRoot,
      SCRIPTARR_NETWORK_NAME: managedNetworkName,
      SCRIPTARR_MOON_PUBLIC_PORT: String(resolvedMoonPort),
      SCRIPTARR_PUBLIC_BASE_URL: publicBaseUrl,
      SCRIPTARR_WARDEN_PORT: String(DEFAULT_WARDEN_PORT),
      SCRIPTARR_WARDEN_CONTAINER_NAME: wardenContainerName,
      SCRIPTARR_WARDEN_BASE_URL: "http://scriptarr-warden:4001",
      SCRIPTARR_MYSQL_URL: normalizeString(mysqlUrl) || "SELFHOST",
      SCRIPTARR_MYSQL_USER: normalizeString(env.SCRIPTARR_MYSQL_USER) || "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: normalizeString(env.SCRIPTARR_MYSQL_PASSWORD) || "scriptarr-dev-password",
      SUPERUSER_ID: normalizeString(env.SUPERUSER_ID) || "test-superuser",
      DISCORD_TOKEN: normalizeString(env.DISCORD_TOKEN) || "test-discord-token"
    }
  };
};

/**
 * Create the Warden-managed Docker test stack helper.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   logger?: ReturnType<typeof createLogger>,
 *   fsModule?: Pick<typeof fsPromises, "mkdir" | "readFile" | "writeFile" | "unlink" | "rm">,
 *   stateDirectory?: string,
 *   ensureStorageFolders?: typeof ensureScriptarrStorageFolders,
 *   resolvePlan?: typeof resolveServicePlan,
 *   resolveImage?: typeof resolveServiceImage,
 *   dockerOps?: {
 *     containerExists: typeof containerExists,
 *     listContainersByLabel: typeof listContainersByLabel,
 *     removeDockerContainer: typeof removeDockerContainer,
 *     removeDockerNetwork: typeof removeDockerNetwork,
 *     runDetachedContainer: typeof runDetachedContainer,
 *     waitForHttp: typeof waitForHttp
 *   },
 *   fetchImpl?: typeof fetch
 * }} [options]
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
export const createTestStackManager = ({
  env = process.env,
  logger = createLogger("WARDEN_TEST_STACK", {env}),
  fsModule = fsPromises,
  stateDirectory = resolveTestStateDirectory({tmpDir: os.tmpdir()}),
  ensureStorageFolders = ensureScriptarrStorageFolders,
  resolvePlan = resolveServicePlan,
  resolveImage = resolveServiceImage,
  dockerOps = {
    containerExists,
    listContainersByLabel,
    removeDockerContainer,
    removeDockerNetwork,
    runDetachedContainer,
    waitForHttp
  },
  fetchImpl = fetch
} = {}) => {
  const cleanupOrphanedStackContainers = async (stackId) => {
    const built = buildTestStackEnvironment({env, stackId});
    const runtimePlan = resolvePlan({
      env: built.env,
      containerNamePrefix: `scriptarr-test-${built.stackId}`
    });
    const discovered = await dockerOps.listContainersByLabel("scriptarr.stack-id", built.stackId);
    const fallbackNames = [
      ...runtimePlan.services.map((service) => service.containerName),
      built.wardenContainerName
    ];
    const names = [...new Set([
      ...discovered.map((container) => container.name),
      ...fallbackNames
    ])];
    const removedContainers = [];

    for (const containerName of names) {
      await dockerOps.removeDockerContainer(containerName, {ignoreMissing: true});
      removedContainers.push(containerName);
    }

    await dockerOps.removeDockerNetwork(runtimePlan.managedNetworkName, {ignoreMissing: true});

    return {
      stackId: built.stackId,
      managedNetworkName: runtimePlan.managedNetworkName,
      removedContainers
    };
  };

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

    await ensureStorageFolders(built.dataRoot);

    const runtimePlan = resolvePlan({
      env: built.env,
      containerNamePrefix: `scriptarr-test-${built.stackId}`
    });
    const wardenImage = resolveImage("scriptarr-warden", {env: built.env});
    const wardenFolders = runtimePlan.storageLayout.services["scriptarr-warden"];

    logger.info("Starting containerized Warden test server.", {
      container: built.wardenContainerName,
      image: wardenImage
    });
    await dockerOps.runDetachedContainer({
      name: built.wardenContainerName,
      image: wardenImage,
      env: built.env,
      mounts: [
        wardenFolders.logs,
        wardenFolders.runtime,
        {
          hostPath: "/var/run/docker.sock",
          containerPath: "/var/run/docker.sock"
        }
      ],
      publishedPorts: [{hostPort: built.wardenPort, containerPort: DEFAULT_WARDEN_PORT}],
      labels: {
        "scriptarr.stack-id": built.stackId,
        "scriptarr.stack-mode": "test",
        "scriptarr.service": "scriptarr-warden"
      }
    });

    await dockerOps.waitForHttp(`http://127.0.0.1:${built.wardenPort}/health`, {
      timeoutMs: 120000,
      intervalMs: 1500
    });
    await dockerOps.waitForHttp(`http://127.0.0.1:${built.moonPort}/health`, {
      timeoutMs: 120000,
      intervalMs: 1500
    });
    await dockerOps.waitForHttp(`http://127.0.0.1:${built.moonPort}/api/moon/auth/bootstrap-status`, {
      timeoutMs: 120000,
      intervalMs: 1500
    });

    const payload = {
      version: 2,
      stackId: built.stackId,
      stackMode: "test",
      managedNetworkName: runtimePlan.managedNetworkName,
      dataRoot: built.dataRoot,
      removeDataRootOnStop: removeDataRootOnStop ?? !dataRoot,
      warden: {
        containerName: built.wardenContainerName,
        image: wardenImage,
        port: built.wardenPort,
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

    const statePath = await writeStateFile(built.stackId, payload, fsModule, stateDirectory);

    return {
      started: true,
      statePath,
      ...payload
    };
  };

  const stop = async ({stackId = DEFAULT_TEST_STACK_ID, tolerateMissing = false} = {}) => {
    let state;
    try {
      const loaded = await readStateFile(stackId, fsModule, stateDirectory);
      state = loaded.payload;
    } catch (error) {
      if (tolerateMissing && error?.code === "ENOENT") {
        const orphaned = await cleanupOrphanedStackContainers(stackId);
        return {
          stopped: false,
          reason: "No saved test stack state was found.",
          cleanedOrphans: true,
          ...orphaned
        };
      }
      throw error;
    }

    for (const service of state.services || []) {
      await dockerOps.removeDockerContainer(service.containerName, {ignoreMissing: true});
    }

    if (state.warden?.containerName) {
      await dockerOps.removeDockerContainer(state.warden.containerName, {ignoreMissing: true});
    }

    await dockerOps.removeDockerNetwork(state.managedNetworkName, {ignoreMissing: true});

    if (state.removeDataRootOnStop && state.dataRoot) {
      await fsModule.rm(state.dataRoot, {
        recursive: true,
        force: true
      });
    }

    await removeStateFile(state.stackId, fsModule, stateDirectory);

    return {
      stopped: true,
      stackId: state.stackId,
      managedNetworkName: state.managedNetworkName,
      removedContainers: [
        ...(state.services || []).map((service) => service.containerName),
        state.warden?.containerName
      ].filter(Boolean),
      removedDataRoot: Boolean(state.removeDataRootOnStop && state.dataRoot)
    };
  };

  const status = async ({stackId = DEFAULT_TEST_STACK_ID} = {}) => {
    try {
      const {payload, statePath} = await readStateFile(stackId, fsModule, stateDirectory);
      const services = await Promise.all((payload.services || []).map(async (service) => ({
        ...service,
        running: await dockerOps.containerExists(service.containerName)
      })));

      const [wardenHealth, wardenRunning, moonHealthy, runtime] = await Promise.all([
        fetchImpl(payload.warden.healthUrl).then(async (response) => ({
          ok: response.ok,
          payload: response.ok && typeof response.json === "function" ? await response.json().catch(() => null) : null
        })).catch(() => ({ok: false, payload: null})),
        payload.warden?.containerName ? dockerOps.containerExists(payload.warden.containerName) : Promise.resolve(false),
        fetchImpl(payload.moon.healthUrl).then((response) => response.ok).catch(() => false),
        fetchImpl(`http://127.0.0.1:${payload.warden.port}/api/runtime`).then(async (response) =>
          response.ok && typeof response.json === "function" ? response.json() : null
        ).catch(() => null)
      ]);
      const runtimeServices = new Map((runtime?.services || []).map((service) => [service.containerName, service]));
      const enrichedServices = services.map((service) => {
        const runtimeService = runtimeServices.get(service.containerName) || null;
        return {
          ...service,
          health: runtimeService?.health || (service.running ? "running" : "missing"),
          status: runtimeService?.status || (service.running ? "running" : "missing"),
          conflict: runtimeService?.conflict || null
        };
      });
      const allServicesHealthy = enrichedServices.length > 0
        && enrichedServices.every((service) => service.running === true && ["healthy", "running"].includes(String(service.health || "").toLowerCase()));

      return {
        exists: true,
        statePath,
        ...payload,
        services: enrichedServices,
        health: {
          warden: wardenHealth.ok,
          wardenContainer: wardenRunning,
          moon: moonHealthy,
          allServicesHealthy
        },
        runtime
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

