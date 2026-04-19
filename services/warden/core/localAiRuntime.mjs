/**
 * @file Scriptarr Warden module: services/warden/core/localAiRuntime.mjs.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_LOCALAI_CONTAINER_NAME,
  DEFAULT_LOCALAI_PORT,
  DEFAULT_WARDEN_RUNTIME_DIR,
  DEFAULT_STACK_MODE
} from "../config/constants.mjs";
import {localAiProfiles, resolveLocalAiProfile} from "../config/localAiProfiles.mjs";
import {resolveScriptarrDataRoot, buildScriptarrStorageLayout} from "../filesystem/storageLayout.mjs";
import {createSageBrokerClient} from "./createSageBrokerClient.mjs";
import {
  ensureDockerNetwork,
  imageExists,
  pullDockerImage,
  removeDockerContainer,
  runDetachedContainer,
  containerExists
} from "../docker/dockerCli.mjs";

const normalizeString = (value) => String(value ?? "").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ORACLE_SETTINGS_KEY = "oracle.settings";
const LOCALAI_CONFIG_CACHE_FILE = "localai-config.json";

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const resolveAioProfileDirectory = (profileKey) => {
  if (profileKey === "intel") {
    return "intel";
  }

  if (profileKey === "nvidia" || profileKey === "amd") {
    return "gpu-8g";
  }

  return "cpu";
};

const resolveAioModelList = (profileKey) => [
  `/aio/${resolveAioProfileDirectory(profileKey)}/text-to-text.yaml`
].join(",");

const normalizeSelection = (payload = {}, fallbackProfileKey) => {
  const profileKey = localAiProfiles[payload?.profileKey] ? payload.profileKey : fallbackProfileKey;
  const imageMode = normalizeString(payload?.imageMode) === "custom" ? "custom" : "preset";
  const customImage = imageMode === "custom" ? normalizeString(payload?.customImage) : "";

  return {
    profileKey,
    imageMode,
    customImage
  };
};

const toSelectionPayload = (value) => {
  const settings = value?.value ?? value;
  if (!settings || typeof settings !== "object") {
    return null;
  }

  return {
    profileKey: settings.localAiProfileKey,
    imageMode: settings.localAiImageMode,
    customImage: settings.localAiCustomImage
  };
};

const probeHttpOk = async (fetchImpl, url) => {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(1000)
    });
    return {
      ok: response.ok,
      detail: `${url} -> HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      detail: `${url} -> ${error instanceof Error ? error.message : String(error)}`
    };
  }
};

const waitForLocalAiReady = async ({
  fetchImpl,
  baseUrl,
  timeoutMs,
  intervalMs
}) => {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "";

  while (Date.now() < deadline) {
    const readyz = await probeHttpOk(fetchImpl, `${baseUrl}/readyz`);
    if (readyz.ok) {
      return;
    }

    const models = await probeHttpOk(fetchImpl, `${baseUrl}/v1/models`);
    if (models.ok) {
      return;
    }

    lastDetail = `${readyz.detail}; ${models.detail}`;
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for LocalAI readiness. Last probes: ${lastDetail || "no successful readiness checks."}`);
};

const probeLocalAiReady = async ({fetchImpl, baseUrl}) => {
  const readyz = await probeHttpOk(fetchImpl, `${baseUrl}/readyz`);
  if (readyz.ok) {
    return true;
  }

  const models = await probeHttpOk(fetchImpl, `${baseUrl}/v1/models`);
  return models.ok;
};

/**
 * Create the mutable LocalAI runtime used by Warden's API routes.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   logger: {info: Function, warn: Function, error: Function},
 *   brokerClient?: {getSetting?: (key: string) => Promise<Record<string, unknown> | null>},
 *   dockerOps?: {
 *     ensureDockerNetwork: typeof ensureDockerNetwork,
 *     imageExists: typeof imageExists,
 *     pullDockerImage: typeof pullDockerImage,
 *     removeDockerContainer: typeof removeDockerContainer,
 *     runDetachedContainer: typeof runDetachedContainer,
 *     containerExists: typeof containerExists
 *   },
 *   fsModule?: Pick<typeof fs, "mkdir" | "readFile" | "writeFile">,
 *   fetchImpl?: typeof fetch,
 *   runtimeDir?: string,
 *   readinessTimeoutMs?: number,
 *   readinessIntervalMs?: number
 * }} options
 * @returns {{
 *   initialize: () => Promise<Record<string, unknown>>,
 *   configure: (payload?: {profileKey?: string, imageMode?: string, customImage?: string}) => Promise<Record<string, unknown>>,
 *   getStatus: () => Record<string, unknown>,
 *   refreshStatus: () => Promise<Record<string, unknown>>,
 *   install: () => Promise<Record<string, unknown>>,
 *   start: () => Promise<Record<string, unknown>>
 * }}
 */
export const createLocalAiRuntime = ({
  env = process.env,
  logger,
  brokerClient = createSageBrokerClient({env}),
  dockerOps = {
    ensureDockerNetwork,
    imageExists,
    pullDockerImage,
    removeDockerContainer,
    runDetachedContainer,
    containerExists
  },
  fsModule = fs,
  fetchImpl = fetch,
  runtimeDir = normalizeString(env.SCRIPTARR_WARDEN_RUNTIME_DIR) || DEFAULT_WARDEN_RUNTIME_DIR,
  readinessTimeoutMs = parsePositiveInteger(env.SCRIPTARR_LOCALAI_READY_TIMEOUT_MS, 20 * 60 * 1000),
  readinessIntervalMs = parsePositiveInteger(env.SCRIPTARR_LOCALAI_READY_INTERVAL_MS, 2000)
}) => {
  const containerName = env.SCRIPTARR_LOCALAI_CONTAINER_NAME || DEFAULT_LOCALAI_CONTAINER_NAME;
  const publishedPort = Number.parseInt(env.SCRIPTARR_LOCALAI_PORT || String(DEFAULT_LOCALAI_PORT), 10) || DEFAULT_LOCALAI_PORT;
  const managedNetworkName = env.SCRIPTARR_NETWORK_NAME || "scriptarr-network";
  const stackMode = normalizeString(env.SCRIPTARR_STACK_MODE) || DEFAULT_STACK_MODE;
  const stackId = normalizeString(env.SCRIPTARR_STACK_ID);
  const detectedProfile = resolveLocalAiProfile({env});
  const storageLayout = buildScriptarrStorageLayout(resolveScriptarrDataRoot({env}));
  const localAiMounts = [
    storageLayout.services["scriptarr-localai"]?.models,
    storageLayout.services["scriptarr-localai"]?.data
  ].filter(Boolean);
  const configCachePath = path.join(runtimeDir, LOCALAI_CONFIG_CACHE_FILE);
  let lastSyncWarning = "";

  const state = {
    configuredProfileKey: detectedProfile.key,
    configuredImageMode: "preset",
    configuredCustomImage: "",
    installOnFirstBoot: false,
    installed: false,
    running: false,
    ready: false,
    phase: "idle",
    message: "LocalAI is optional and not installed on first boot.",
    lastError: null,
    updatedAt: new Date().toISOString()
  };

  const mark = (updates) => {
    Object.assign(state, updates, {updatedAt: new Date().toISOString()});
  };

  const configuredProfile = () => localAiProfiles[state.configuredProfileKey] || detectedProfile;

  const currentImage = () =>
    state.configuredImageMode === "custom" && state.configuredCustomImage
      ? state.configuredCustomImage
      : configuredProfile().image;

  const persistConfiguredSelection = async () => {
    await fsModule.mkdir(runtimeDir, {recursive: true});
    await fsModule.writeFile(configCachePath, JSON.stringify({
      profileKey: state.configuredProfileKey,
      imageMode: state.configuredImageMode,
      customImage: state.configuredCustomImage
    }, null, 2));
  };

  const applyConfiguredSelection = (selection) => {
    mark({
      configuredProfileKey: selection.profileKey,
      configuredImageMode: selection.imageMode,
      configuredCustomImage: selection.customImage
    });
  };

  const logSyncWarning = (message, error) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === lastSyncWarning) {
      return;
    }
    lastSyncWarning = detail;
    logger.warn(message, {error: detail});
  };

  const syncConfiguredSelection = async () => {
    try {
      const setting = await brokerClient.getSetting?.(ORACLE_SETTINGS_KEY);
      const fromSage = toSelectionPayload(setting);
      if (fromSage) {
        applyConfiguredSelection(normalizeSelection(fromSage, detectedProfile.key));
        await persistConfiguredSelection();
        lastSyncWarning = "";
        return "sage";
      }
    } catch (error) {
      logSyncWarning("Failed to reload LocalAI selection through Sage. Falling back to the last Sage-synced runtime copy.", error);
    }

    try {
      const cached = JSON.parse(await fsModule.readFile(configCachePath, "utf8"));
      applyConfiguredSelection(normalizeSelection(cached, detectedProfile.key));
      return "runtime-cache";
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logSyncWarning("Failed to reload the cached LocalAI selection from Warden runtime storage.", error);
      }
    }

    return "default";
  };

  const getStatus = () => ({
    ...state,
    detectedProfile,
    configuredProfile: configuredProfile(),
    configuredImage: currentImage(),
    profiles: Object.values(localAiProfiles),
    containerName,
    managedNetworkName,
    publishedPort
  });

  const refreshStatus = async () => {
    await syncConfiguredSelection();
    const running = await dockerOps.containerExists(containerName);
    mark({
      running,
      installed: await dockerOps.imageExists(currentImage()),
      ready: running
        ? await probeLocalAiReady({
          fetchImpl,
          baseUrl: `http://scriptarr-localai:${DEFAULT_LOCALAI_PORT}`
        })
        : false
    });
    return getStatus();
  };

  const configure = async ({profileKey, imageMode, customImage} = {}) => {
    applyConfiguredSelection(normalizeSelection({
      profileKey,
      imageMode,
      customImage
    }, state.configuredProfileKey));

    mark({
      message: "LocalAI selection updated. Install and start remain manual.",
      lastError: null
    });

    try {
      await persistConfiguredSelection();
    } catch (error) {
      logSyncWarning("Failed to persist the LocalAI selection to Warden runtime storage.", error);
    }

    logger.info("Updated LocalAI selection.", {
      profile: state.configuredProfileKey,
      mode: state.configuredImageMode,
      image: currentImage()
    });

    return getStatus();
  };

  const install = async () => {
    if (state.phase !== "idle") {
      return getStatus();
    }

    await syncConfiguredSelection();

    const image = currentImage();
    mark({
      phase: "installing",
      message: "Pulling the selected LocalAI image. This can take a long time.",
      lastError: null
    });

    try {
      await dockerOps.pullDockerImage(image, {logger});
      mark({
        installed: true,
        ready: false,
        phase: "idle",
        message: "LocalAI image pulled successfully."
      });
      logger.info("Installed LocalAI image.", {image});
    } catch (error) {
      mark({
        installed: await dockerOps.imageExists(image),
        ready: false,
        phase: "idle",
        lastError: error instanceof Error ? error.message : String(error),
        message: "LocalAI image pull failed."
      });
      logger.error("LocalAI image pull failed.", {image, error: state.lastError});
    }

    return getStatus();
  };

  const start = async () => {
    if (state.phase !== "idle") {
      return getStatus();
    }

    await syncConfiguredSelection();

    const image = currentImage();
    const runtimeArgs = configuredProfile().runtimeArgs || [];
    const profileKey = configuredProfile().key;
    const runtimeEnv = {
      PROFILE: resolveAioProfileDirectory(profileKey),
      MODELS: resolveAioModelList(profileKey)
    };
    mark({
      phase: "starting",
      message: "Starting LocalAI. Initial startup can take 5 to 20 minutes depending on the host.",
      lastError: null
    });

    try {
      await dockerOps.ensureDockerNetwork(managedNetworkName);
      await dockerOps.removeDockerContainer(containerName);
      await dockerOps.runDetachedContainer({
        name: containerName,
        image,
        env: runtimeEnv,
        networkName: managedNetworkName,
        networkAliases: ["scriptarr-localai"],
        mounts: localAiMounts,
        publishedPorts: [{hostPort: publishedPort, containerPort: DEFAULT_LOCALAI_PORT}],
        extraArgs: runtimeArgs,
        labels: {
          "scriptarr.service": "scriptarr-localai",
          ...(stackMode === "test" && stackId
            ? {
              "scriptarr.stack-id": stackId,
              "scriptarr.stack-mode": "test"
            }
            : {})
        },
        logger
      });
      await waitForLocalAiReady({
        fetchImpl,
        baseUrl: `http://scriptarr-localai:${DEFAULT_LOCALAI_PORT}`,
        timeoutMs: readinessTimeoutMs,
        intervalMs: readinessIntervalMs
      });
      mark({
        installed: true,
        running: true,
        ready: true,
        phase: "idle",
        message: "LocalAI container started and is ready."
      });
      logger.info("Started LocalAI container.", {
        image,
        env: runtimeEnv,
        network: managedNetworkName,
        publishedPort,
        runtimeArgs
      });
    } catch (error) {
      mark({
        installed: await dockerOps.imageExists(image),
        running: await dockerOps.containerExists(containerName),
        ready: false,
        phase: "idle",
        lastError: error instanceof Error ? error.message : String(error),
        message: "LocalAI container failed to become ready."
      });
      logger.error("LocalAI container failed to start cleanly.", {
        image,
        env: runtimeEnv,
        runtimeArgs,
        error: state.lastError
      });
    }

    return getStatus();
  };

  const initialize = async () => {
    return refreshStatus();
  };

  return {
    initialize,
    configure,
    getStatus,
    refreshStatus,
    install,
    start
  };
};
