/**
 * @file Scriptarr Warden module: services/warden/core/updateRuntime.mjs.
 */
import {resolveServicePlan} from "../config/servicePlan.mjs";
import {inspectDockerContainer, inspectDockerImage, pullDockerImage} from "../docker/dockerCli.mjs";

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
      status: "running",
      requestedServices: selected,
      servicesToRestart: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null
    };
    state.job = job;

    void (async () => {
      try {
        const checkResult = await checkForUpdates(selected);
        const servicesToRestart = checkResult.services
          .filter((service) => selected.includes(service.name) && service.updateAvailable)
          .map((service) => service.name);

        job.servicesToRestart = servicesToRestart;

        if (!servicesToRestart.length) {
          job.status = "completed";
          job.finishedAt = new Date().toISOString();
          return;
        }

        await managedStack.reconcileSelectedServices(servicesToRestart, {
          forceRecreate: true
        });
        job.status = "completed";
        job.finishedAt = new Date().toISOString();
      } catch (error) {
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        job.error = error instanceof Error ? error.message : String(error);
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
      job: state.job,
      checkedAt: state.checkedAt
    }),
    checkForUpdates,
    installUpdates
  };
};

export default createUpdateRuntime;
