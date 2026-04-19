/**
 * @file Scriptarr Warden module: services/warden/core/updateRuntime.mjs.
 */
import {resolveServicePlan} from "../config/servicePlan.mjs";
import {inspectDockerContainer, inspectDockerImage, pullDockerImage} from "../docker/dockerCli.mjs";
import {createSageBrokerClient} from "./createSageBrokerClient.mjs";

const normalizeString = (value) => String(value ?? "").trim();

const UPDATABLE_SERVICE_ORDER = Object.freeze([
  "scriptarr-vault",
  "scriptarr-sage",
  "scriptarr-raven",
  "scriptarr-portal",
  "scriptarr-oracle",
  "scriptarr-moon"
]);

const toShortId = (value) => normalizeString(value).replace(/^sha256:/, "").slice(0, 12) || "unknown";
const nowIso = () => new Date().toISOString();

const toServiceRow = ({descriptor, containerInspect, imageInspect}) => {
  const runningImageId = normalizeString(containerInspect?.Image);
  const localImageId = normalizeString(imageInspect?.Id);

  return {
    name: descriptor.name,
    image: descriptor.image,
    containerName: descriptor.containerName,
    runningImageId,
    runningImageLabel: toShortId(runningImageId),
    localImageId,
    localImageLabel: toShortId(localImageId),
    updateAvailable: Boolean(runningImageId && localImageId && runningImageId !== localImageId),
    running: Boolean(containerInspect?.State?.Running),
    health: containerInspect?.State?.Health?.Status || (containerInspect?.State?.Running ? "running" : "missing")
  };
};

const normalizeRequestedServices = (requestedServices) => {
  const requested = Array.isArray(requestedServices)
    ? requestedServices.map((entry) => normalizeString(entry)).filter(Boolean)
    : [];

  if (!requested.length) {
    return [...UPDATABLE_SERVICE_ORDER];
  }

  return UPDATABLE_SERVICE_ORDER.filter((serviceName) => requested.includes(serviceName));
};

/**
 * Create Warden's in-memory service update runtime.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   logger: {info: Function, warn: Function, error: Function},
 *   managedStack: {refreshStatus: () => Promise<unknown>, reconcileSelectedServices: (serviceNames: string[], options?: {forceRecreate?: boolean}) => Promise<Array<Record<string, unknown>>>},
 *   resolvePlan?: typeof resolveServicePlan,
 *   brokerClient?: ReturnType<typeof createSageBrokerClient>,
 *   dockerOps?: {
 *     inspectDockerContainer: typeof inspectDockerContainer,
 *     inspectDockerImage: typeof inspectDockerImage,
 *     pullDockerImage: typeof pullDockerImage
 *   }
 * }} options
 * @returns {{
 *   getStatus: () => Promise<{services: Array<Record<string, unknown>>, job: Record<string, unknown> | null, checkedAt: string | null}>,
 *   checkForUpdates: (requestedServices?: string[]) => Promise<{services: Array<Record<string, unknown>>, job: Record<string, unknown> | null, checkedAt: string}>,
 *   installUpdates: (requestedServices?: string[]) => Promise<{job: Record<string, unknown>, services: Array<Record<string, unknown>>, checkedAt: string | null}>
 * }}
 */
export const createUpdateRuntime = ({
  env = process.env,
  logger,
  managedStack,
  resolvePlan = resolveServicePlan,
  brokerClient = createSageBrokerClient({env}),
  dockerOps = {
    inspectDockerContainer,
    inspectDockerImage,
    pullDockerImage
  }
}) => {
  const state = {
    checkedAt: null,
    job: null
  };

  const syncJob = async (job) => {
    if (!job) {
      return null;
    }
    try {
      return await brokerClient.upsertJob(job.jobId, {
        ...job,
        kind: "service-update",
        ownerService: "scriptarr-warden"
      });
    } catch (error) {
      logger.warn("Failed to persist Warden update job snapshot through Sage.", {
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const syncTask = async (jobId, task) => {
    try {
      return await brokerClient.upsertJobTask(jobId, task.taskId, task);
    } catch (error) {
      logger.warn("Failed to persist Warden update task snapshot through Sage.", {
        jobId,
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const hydrateJob = async (job) => {
    if (!job) {
      return null;
    }
    try {
      const tasks = await brokerClient.listJobTasks(job.jobId);
      return {
        ...job,
        tasks: Array.isArray(tasks) ? tasks : []
      };
    } catch (error) {
      logger.warn("Failed to hydrate Warden update job tasks through Sage.", {
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      return job;
    }
  };

  const loadPersistedLatestJob = async () => {
    try {
      const jobs = await brokerClient.listJobs({
        ownerService: "scriptarr-warden",
        kind: "service-update"
      });
      const latest = Array.isArray(jobs) ? jobs[0] : null;
      return latest ? hydrateJob(latest) : null;
    } catch (error) {
      logger.warn("Failed to load the latest persisted Warden update job.", {
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

  const loadRows = async () => {
    await managedStack.refreshStatus();
    const plan = resolvePlan({env});
    const descriptors = plan.services.filter((service) => UPDATABLE_SERVICE_ORDER.includes(service.name));

    return Promise.all(descriptors.map(async (descriptor) => toServiceRow({
      descriptor,
      containerInspect: await dockerOps.inspectDockerContainer(descriptor.containerName),
      imageInspect: await dockerOps.inspectDockerImage(descriptor.image)
    })));
  };

  const checkForUpdates = async (requestedServices = []) => {
    const selected = new Set(normalizeRequestedServices(requestedServices));
    const plan = resolvePlan({env});
    const descriptors = plan.services.filter((service) => selected.has(service.name));

    for (const descriptor of descriptors) {
      logger.info("Checking for a newer managed service image.", {
        service: descriptor.name,
        image: descriptor.image
      });
      await dockerOps.pullDockerImage(descriptor.image, {logger});
    }

    const services = await loadRows();
    state.checkedAt = new Date().toISOString();

    return {
      services,
      job: state.job,
      checkedAt: state.checkedAt
    };
  };

  const installUpdates = async (requestedServices = []) => {
    if (state.job?.status === "running") {
      return {
        job: state.job,
        services: await loadRows(),
        checkedAt: state.checkedAt
      };
    }

    const selected = normalizeRequestedServices(requestedServices);
    const job = {
      jobId: `update_${Date.now().toString(36)}`,
      kind: "service-update",
      ownerService: "scriptarr-warden",
      status: "running",
      label: "Managed service update",
      requestedBy: "moon-admin",
      requestedServices: selected,
      servicesToRestart: [],
      tasks: [],
      payload: {
        requestedServices: selected
      },
      result: {},
      startedAt: new Date().toISOString(),
      finishedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      error: null
    };
    state.job = job;

    void (async () => {
      const taskIndex = new Map();
      const saveJob = async () => {
        job.updatedAt = nowIso();
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
          updatedAt: nowIso()
        });
        await syncTask(job.jobId, task);
        await saveJob();
      };

      try {
        await saveJob();
        await updateTask("pull-images", {
          label: "Pull candidate images",
          sortOrder: 0,
          status: "running",
          percent: 10,
          message: "Checking managed service images for updates.",
          startedAt: nowIso()
        });
        const checkResult = await checkForUpdates(selected);
        const servicesToRestart = checkResult.services
          .filter((service) => selected.includes(service.name) && service.updateAvailable)
          .map((service) => service.name);

        job.servicesToRestart = servicesToRestart;
        job.result = {
          checkedAt: checkResult.checkedAt,
          servicesToRestart
        };
        await updateTask("pull-images", {
          label: "Pull candidate images",
          sortOrder: 0,
          status: "completed",
          percent: 100,
          message: servicesToRestart.length
            ? `Ready to restart ${servicesToRestart.length} managed service${servicesToRestart.length === 1 ? "" : "s"}.`
            : "All selected managed services are already current.",
          finishedAt: nowIso(),
          result: {
            servicesToRestart
          }
        });

        if (!servicesToRestart.length) {
          job.status = "completed";
          job.finishedAt = nowIso();
          await saveJob();
          return;
        }

        for (const [index, serviceName] of servicesToRestart.entries()) {
          await updateTask(`recreate-${serviceName}`, {
            label: `Restart ${serviceName}`,
            sortOrder: index + 1,
            status: "running",
            percent: 20,
            message: `Recreating ${serviceName} from the updated image.`,
            startedAt: nowIso(),
            payload: {serviceName}
          });
          const reconcileResult = await managedStack.reconcileSelectedServices([serviceName], {
            forceRecreate: true
          });
          const runtimeStatus = Array.isArray(reconcileResult) ? reconcileResult[0] : null;
          await updateTask(`recreate-${serviceName}`, {
            label: `Restart ${serviceName}`,
            sortOrder: index + 1,
            status: "completed",
            percent: 100,
            message: `${serviceName} recreated cleanly.`,
            finishedAt: nowIso(),
            result: runtimeStatus || {serviceName}
          });
        }
        job.status = "completed";
        job.finishedAt = nowIso();
        await saveJob();
      } catch (error) {
        job.status = "failed";
        job.finishedAt = nowIso();
        job.error = error instanceof Error ? error.message : String(error);
        job.result = {
          ...job.result,
          error: job.error
        };
        const runningTask = [...taskIndex.values()].reverse().find((task) => task.status === "running");
        if (runningTask) {
          await updateTask(runningTask.taskKey, {
            ...runningTask,
            status: "failed",
            percent: runningTask.percent || 0,
            message: job.error,
            finishedAt: nowIso(),
            result: {
              error: job.error
            }
          });
        }
        await saveJob();
        logger.error("Managed service update job failed.", {
          jobId: job.jobId,
          error: job.error
        });
      }
    })();

    return {
      job,
      services: await loadRows(),
      checkedAt: state.checkedAt
    };
  };

  return {
    getStatus: async () => ({
      services: await loadRows(),
      job: state.job ? await hydrateJob(state.job) : await loadPersistedLatestJob(),
      checkedAt: state.checkedAt
    }),
    checkForUpdates,
    installUpdates
  };
};

export default createUpdateRuntime;
