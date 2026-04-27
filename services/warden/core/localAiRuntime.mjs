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
  removeDockerImage,
  removeDockerContainer,
  runDetachedContainer,
  containerExists
} from "../docker/dockerCli.mjs";

const normalizeString = (value, fallback = "") => {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || fallback;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized || fallback;
  }
  return fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ORACLE_SETTINGS_KEY = "oracle.settings";
const LOCALAI_CONFIG_CACHE_FILE = "localai-config.json";
const LOCALAI_JOB_KIND = "localai-lifecycle";
const nowIso = () => new Date().toISOString();
const clampPercent = (value) => Math.min(100, Math.max(0, Number.parseInt(String(value), 10) || 0));

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

const normalizeActor = (value = {}) => ({
  discordUserId: normalizeString(value.discordUserId || value.requestedBy || value.id),
  username: normalizeString(value.username || value.name, "Moon admin")
});

const actionLabel = (action) => {
  switch (action) {
    case "install":
      return "Install LocalAI";
    case "start":
      return "Start LocalAI";
    case "remove":
      return "Remove LocalAI";
    default:
      return "Manage LocalAI";
  }
};

const estimatePullPercent = (line, currentPercent = 0) => {
  const text = normalizeString(line).toLowerCase();
  const match = text.match(/(\d{1,3})%/);
  if (match) {
    return Math.max(currentPercent, Math.min(90, Number.parseInt(match[1], 10) || currentPercent));
  }
  if (/already exists|image is up to date|downloaded newer image|status: downloaded/i.test(line)) {
    return 100;
  }
  if (/pulling from|waiting/i.test(text)) {
    return Math.max(currentPercent, 12);
  }
  if (/downloading|pulling fs layer/i.test(text)) {
    return Math.max(currentPercent, 35);
  }
  if (/extracting|verifying checksum/i.test(text)) {
    return Math.max(currentPercent, 70);
  }
  if (/pull complete|complete/i.test(text)) {
    return Math.max(currentPercent, 90);
  }
  return Math.min(95, Math.max(currentPercent, currentPercent + 4));
};

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
  intervalMs,
  onProgress
}) => {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastDetail = "";
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const readyz = await probeHttpOk(fetchImpl, `${baseUrl}/readyz`);
    if (readyz.ok) {
      await onProgress?.({
        attempt,
        elapsedMs: Date.now() - startedAt,
        percent: 100,
        detail: readyz.detail
      });
      return;
    }

    const models = await probeHttpOk(fetchImpl, `${baseUrl}/v1/models`);
    if (models.ok) {
      await onProgress?.({
        attempt,
        elapsedMs: Date.now() - startedAt,
        percent: 100,
        detail: models.detail
      });
      return;
    }

    lastDetail = `${readyz.detail}; ${models.detail}`;
    await onProgress?.({
      attempt,
      elapsedMs: Date.now() - startedAt,
      percent: Math.min(95, Math.max(30, Math.round(((Date.now() - startedAt) / timeoutMs) * 90))),
      detail: lastDetail
    });
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
 *     removeDockerImage: typeof removeDockerImage,
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
 *   install: (actor?: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   start: (actor?: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   remove: (actor?: Record<string, unknown>) => Promise<Record<string, unknown>>
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
    removeDockerImage,
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
    job: null,
    updatedAt: new Date().toISOString()
  };

  const mark = (updates) => {
    Object.assign(state, updates, {updatedAt: new Date().toISOString()});
  };

  const syncJob = async (job) => {
    if (!job || typeof brokerClient.upsertJob !== "function") {
      return null;
    }
    try {
      return await brokerClient.upsertJob(job.jobId, {
        ...job,
        kind: LOCALAI_JOB_KIND,
        ownerService: "scriptarr-warden"
      });
    } catch (error) {
      logger.warn("Failed to persist LocalAI lifecycle job through Sage.", {
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const syncTask = async (jobId, task) => {
    if (typeof brokerClient.upsertJobTask !== "function") {
      return null;
    }
    try {
      return await brokerClient.upsertJobTask(jobId, task.taskId, task);
    } catch (error) {
      logger.warn("Failed to persist LocalAI lifecycle task through Sage.", {
        jobId,
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const buildTask = (jobId, taskKey, label, sortOrder) => ({
    taskId: `${jobId}_${taskKey.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`,
    jobId,
    taskKey,
    label,
    status: "queued",
    message: "",
    percent: 0,
    sortOrder,
    payload: {},
    result: {},
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    updatedAt: nowIso()
  });

  const summarizeJobPercent = (tasks) => {
    const activeTasks = tasks.length ? tasks : [{percent: 0}];
    return clampPercent(Math.round(activeTasks.reduce((sum, task) => sum + clampPercent(task.percent), 0) / activeTasks.length));
  };

  const createLifecycleJob = (action, actor) => {
    const normalizedActor = normalizeActor(actor);
    const image = currentImage();
    const profile = configuredProfile();
    const createdAt = nowIso();
    return {
      jobId: `localai_${Date.now().toString(36)}`,
      kind: LOCALAI_JOB_KIND,
      ownerService: "scriptarr-warden",
      status: "running",
      label: actionLabel(action),
      requestedBy: normalizedActor.discordUserId || "moon-admin",
      requestedServices: ["scriptarr-localai"],
      tasks: [],
      progressPercent: 0,
      payload: {
        action,
        requestedByDiscordId: normalizedActor.discordUserId,
        requestedByUsername: normalizedActor.username,
        image,
        profileKey: profile.key,
        imageMode: state.configuredImageMode
      },
      result: {},
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      updatedAt: createdAt,
      error: null
    };
  };

  const runLifecycleJob = (job, action, worker) => {
    const taskIndex = new Map();
    state.job = job;

    const saveJob = async () => {
      job.progressPercent = summarizeJobPercent(job.tasks);
      job.updatedAt = nowIso();
      state.job = job;
      mark({job});
      await syncJob(job);
    };

    const ensureTask = async (taskKey, label, sortOrder) => {
      if (!taskIndex.has(taskKey)) {
        const created = buildTask(job.jobId, taskKey, label, sortOrder);
        taskIndex.set(taskKey, created);
        job.tasks.push(created);
        await syncTask(job.jobId, created);
      }
      return taskIndex.get(taskKey);
    };

    const updateTask = async (taskKey, next) => {
      const task = await ensureTask(taskKey, next.label || taskKey, next.sortOrder || 0);
      Object.assign(task, next, {
        percent: clampPercent(next.percent ?? task.percent),
        updatedAt: nowIso()
      });
      await syncTask(job.jobId, task);
      await saveJob();
      return task;
    };

    void (async () => {
      try {
        await saveJob();
        await worker({job, updateTask});
        job.status = "completed";
        job.finishedAt = nowIso();
        await saveJob();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job.status = "failed";
        job.error = message;
        job.result = {
          ...job.result,
          error: message
        };
        job.finishedAt = nowIso();
        const runningTask = [...taskIndex.values()].reverse().find((task) => task.status === "running");
        if (runningTask) {
          await updateTask(runningTask.taskKey, {
            ...runningTask,
            status: "failed",
            message,
            finishedAt: nowIso(),
            result: {
              error: message
            }
          });
        }
        mark({
          phase: "idle",
          lastError: message,
          message: `LocalAI ${action} failed.`,
          installed: await dockerOps.imageExists(currentImage()),
          running: await dockerOps.containerExists(containerName),
          ready: false
        });
        await saveJob();
        logger.error("LocalAI lifecycle job failed.", {
          jobId: job.jobId,
          action,
          error: message
        });
      }
    })();
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

  const install = async (actor = {}) => {
    if (state.phase !== "idle") {
      return getStatus();
    }

    await syncConfiguredSelection();

    const image = currentImage();
    const job = createLifecycleJob("install", actor);
    mark({
      phase: "installing",
      message: "Pulling the selected LocalAI image. This can take a long time.",
      lastError: null,
      job
    });

    runLifecycleJob(job, "install", async ({updateTask}) => {
      let pullPercent = 10;
      let progressChain = Promise.resolve();
      await updateTask("docker-image", {
        label: "Download LocalAI image",
        sortOrder: 0,
        status: "running",
        percent: pullPercent,
        message: `Pulling ${image}.`,
        payload: {image},
        startedAt: nowIso()
      });
      await dockerOps.pullDockerImage(image, {
        logger,
        onProgress: (line) => {
          pullPercent = estimatePullPercent(line, pullPercent);
          progressChain = progressChain.then(() => updateTask("docker-image", {
            label: "Download LocalAI image",
            sortOrder: 0,
            status: "running",
            percent: pullPercent,
            message: normalizeString(line, `Pulling ${image}.`),
            payload: {image}
          })).catch((error) => logger.warn("Failed to publish LocalAI pull progress.", {error}));
        }
      });
      await progressChain;
      await updateTask("docker-image", {
        label: "Download LocalAI image",
        sortOrder: 0,
        status: "completed",
        percent: 100,
        message: "LocalAI image pulled successfully.",
        finishedAt: nowIso(),
        result: {image}
      });
      mark({
        installed: true,
        ready: false,
        phase: "idle",
        message: "LocalAI image pulled successfully.",
        lastError: null
      });
      job.result = {
        image,
        installed: true
      };
      logger.info("Installed LocalAI image.", {image});
    });

    return getStatus();
  };

  const start = async (actor = {}) => {
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
    const job = createLifecycleJob("start", actor);
    mark({
      phase: "starting",
      message: "Starting LocalAI. Initial startup can take 5 to 20 minutes depending on the host.",
      lastError: null,
      job
    });

    runLifecycleJob(job, "start", async ({updateTask}) => {
      if (!(await dockerOps.imageExists(image))) {
        let pullPercent = 8;
        let progressChain = Promise.resolve();
        await updateTask("docker-image", {
          label: "Download LocalAI image",
          sortOrder: 0,
          status: "running",
          percent: pullPercent,
          message: `Pulling ${image}.`,
          payload: {image},
          startedAt: nowIso()
        });
        await dockerOps.pullDockerImage(image, {
          logger,
          onProgress: (line) => {
            pullPercent = estimatePullPercent(line, pullPercent);
            progressChain = progressChain.then(() => updateTask("docker-image", {
              label: "Download LocalAI image",
              sortOrder: 0,
              status: "running",
              percent: pullPercent,
              message: normalizeString(line, `Pulling ${image}.`),
              payload: {image}
            })).catch((error) => logger.warn("Failed to publish LocalAI pull progress.", {error}));
          }
        });
        await progressChain;
        await updateTask("docker-image", {
          label: "Download LocalAI image",
          sortOrder: 0,
          status: "completed",
          percent: 100,
          message: "LocalAI image is available.",
          finishedAt: nowIso(),
          result: {image}
        });
      } else {
        await updateTask("docker-image", {
          label: "Download LocalAI image",
          sortOrder: 0,
          status: "completed",
          percent: 100,
          message: "LocalAI image is already available.",
          payload: {image},
          result: {image},
          startedAt: nowIso(),
          finishedAt: nowIso()
        });
      }

      await updateTask("container", {
        label: "Start LocalAI container",
        sortOrder: 1,
        status: "running",
        percent: 15,
        message: "Creating the LocalAI container.",
        payload: {containerName, image},
        startedAt: nowIso()
      });
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
      await updateTask("container", {
        label: "Start LocalAI container",
        sortOrder: 1,
        status: "completed",
        percent: 100,
        message: "LocalAI container is running.",
        finishedAt: nowIso(),
        result: {
          containerName,
          image
        }
      });
      await updateTask("models-ready", {
        label: "Download models and wait for readiness",
        sortOrder: 2,
        status: "running",
        percent: 20,
        message: "Waiting for the LocalAI AIO preload model set to download and become ready.",
        payload: {
          models: runtimeEnv.MODELS
        },
        startedAt: nowIso()
      });
      await waitForLocalAiReady({
        fetchImpl,
        baseUrl: `http://scriptarr-localai:${DEFAULT_LOCALAI_PORT}`,
        timeoutMs: readinessTimeoutMs,
        intervalMs: readinessIntervalMs,
        onProgress: ({percent, detail}) => updateTask("models-ready", {
          label: "Download models and wait for readiness",
          sortOrder: 2,
          status: "running",
          percent,
          message: percent >= 100 ? "LocalAI readiness probe succeeded." : detail,
          payload: {
            models: runtimeEnv.MODELS
          }
        })
      });
      await updateTask("models-ready", {
        label: "Download models and wait for readiness",
        sortOrder: 2,
        status: "completed",
        percent: 100,
        message: "LocalAI models are loaded and the runtime is healthy.",
        finishedAt: nowIso(),
        result: {
          ready: true,
          models: runtimeEnv.MODELS
        }
      });
      mark({
        installed: true,
        running: true,
        ready: true,
        phase: "idle",
        message: "LocalAI container started and is ready.",
        lastError: null
      });
      job.result = {
        image,
        containerName,
        ready: true,
        models: runtimeEnv.MODELS
      };
      logger.info("Started LocalAI container.", {
        image,
        env: runtimeEnv,
        network: managedNetworkName,
        publishedPort,
        runtimeArgs
      });
    });

    return getStatus();
  };

  const remove = async (actor = {}) => {
    if (state.phase !== "idle") {
      return getStatus();
    }

    await syncConfiguredSelection();

    const image = currentImage();
    const job = createLifecycleJob("remove", actor);
    mark({
      phase: "removing",
      message: "Removing the LocalAI container and selected image.",
      lastError: null,
      job
    });

    runLifecycleJob(job, "remove", async ({updateTask}) => {
      await updateTask("container", {
        label: "Remove LocalAI container",
        sortOrder: 0,
        status: "running",
        percent: 35,
        message: `Removing ${containerName}.`,
        payload: {containerName},
        startedAt: nowIso()
      });
      await dockerOps.removeDockerContainer(containerName);
      await updateTask("container", {
        label: "Remove LocalAI container",
        sortOrder: 0,
        status: "completed",
        percent: 100,
        message: "LocalAI container removed.",
        finishedAt: nowIso(),
        result: {containerName}
      });
      await updateTask("docker-image", {
        label: "Remove LocalAI image",
        sortOrder: 1,
        status: "running",
        percent: 35,
        message: `Removing ${image}.`,
        payload: {image},
        startedAt: nowIso()
      });
      await dockerOps.removeDockerImage(image);
      await updateTask("docker-image", {
        label: "Remove LocalAI image",
        sortOrder: 1,
        status: "completed",
        percent: 100,
        message: "LocalAI image removed.",
        finishedAt: nowIso(),
        result: {image}
      });
      mark({
        installed: false,
        running: false,
        ready: false,
        phase: "idle",
        message: "LocalAI container and selected image removed.",
        lastError: null
      });
      job.result = {
        image,
        containerName,
        removed: true
      };
      logger.info("Removed LocalAI container and image.", {image, containerName});
    });

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
    start,
    remove
  };
};
