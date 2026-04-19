/**
 * @file Scriptarr Warden module: services/warden/core/managedStackRuntime.mjs.
 */
import {
  DEFAULT_DOCKER_SOCKET_PATH,
  DEFAULT_STACK_ID,
  DEFAULT_WARDEN_CONTAINER_NAME,
  DEFAULT_WARDEN_NETWORK_ALIAS
} from "../config/constants.mjs";
import {resolveManagedNetworkName, resolveServicePlan, resolveStackMode} from "../config/servicePlan.mjs";
import {ensureScriptarrStorageFolders} from "../filesystem/storageLayout.mjs";
import {
  connectContainerToNetwork,
  disconnectContainerFromNetwork,
  dockerSocketAvailable,
  ensureDockerNetwork,
  inspectDockerContainer,
  listContainersByLabel,
  removeDockerContainer,
  runDetachedContainer,
  startDockerContainer,
  waitForContainerHealthy,
  waitForMySqlReady
} from "../docker/dockerCli.mjs";
import {toDockerDesktopHostPath} from "../filesystem/storageLayout.mjs";

const normalizeString = (value) => String(value ?? "").trim();

const DURATION_UNITS_IN_NANOSECONDS = Object.freeze({
  ns: 1n,
  us: 1000n,
  ms: 1000000n,
  s: 1000000000n,
  m: 60000000000n,
  h: 3600000000000n
});

const normalizeMapEntries = (entries) =>
  Object.entries(entries || {})
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right));

const mapFromEnvList = (envList = []) =>
  Object.fromEntries(envList.map((entry) => {
    const [key, ...value] = String(entry).split("=");
    return [key, value.join("=")];
  }));

const desiredMountsFor = (mounts) =>
  (mounts || [])
    .filter((mount) => mount?.hostPath && mount?.containerPath)
    .map((mount) => `${toDockerDesktopHostPath(mount.hostPath)}=>${mount.containerPath}`)
    .sort();

const actualMountsFor = (inspect) =>
  (inspect?.Mounts || [])
    .filter((mount) => mount.Type === "bind" && mount.Source && mount.Destination)
    .map((mount) => `${mount.Source}=>${mount.Destination}`)
    .sort();

const desiredPortsFor = (ports) =>
  (ports || [])
    .map((entry) => `${entry.hostPort}:${entry.containerPort}`)
    .sort();

const actualPortsFor = (inspect) => {
  const bindings = inspect?.HostConfig?.PortBindings || {};
  return Object.entries(bindings)
    .flatMap(([containerPort, hostBindings]) =>
      (hostBindings || []).map((binding) => `${binding.HostPort}:${containerPort.replace(/\/tcp$/, "")}`)
    )
    .sort();
};

const desiredAliasesFor = (descriptor) =>
  (descriptor.networkAliases || []).slice().sort();

const actualAliasesFor = (inspect, networkName) =>
  ((inspect?.NetworkSettings?.Networks || {})[networkName]?.Aliases || [])
    .filter(Boolean)
    .sort();

const sameList = (left, right) =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const includesAll = (actual, desired) => desired.every((entry) => actual.includes(entry));

const resolveRestartPolicy = (descriptor) => descriptor.restartPolicy || "no";

const toNanoseconds = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(\d+)(ns|us|ms|s|m|h)$/);
  if (!match) {
    return null;
  }

  const [, amount, unit] = match;
  return BigInt(amount) * DURATION_UNITS_IN_NANOSECONDS[unit];
};

const desiredHealthCheckFor = (descriptor) => {
  if (!descriptor?.healthCheck?.command) {
    return null;
  }

  return {
    command: normalizeString(descriptor.healthCheck.command),
    interval: toNanoseconds(descriptor.healthCheck.interval),
    timeout: toNanoseconds(descriptor.healthCheck.timeout),
    startPeriod: toNanoseconds(descriptor.healthCheck.startPeriod),
    retries: Number.isInteger(descriptor.healthCheck.retries) ? descriptor.healthCheck.retries : null
  };
};

const actualHealthCheckFor = (inspect) => {
  const healthCheck = inspect?.Config?.Healthcheck;
  if (!healthCheck || !Array.isArray(healthCheck.Test) || healthCheck.Test[0] === "NONE") {
    return null;
  }

  const command = healthCheck.Test[0] === "CMD-SHELL"
    ? normalizeString(healthCheck.Test.slice(1).join(" "))
    : normalizeString(healthCheck.Test.join(" "));

  return {
    command,
    interval: typeof healthCheck.Interval === "bigint"
      ? healthCheck.Interval
      : BigInt(Number(healthCheck.Interval || 0)),
    timeout: typeof healthCheck.Timeout === "bigint"
      ? healthCheck.Timeout
      : BigInt(Number(healthCheck.Timeout || 0)),
    startPeriod: typeof healthCheck.StartPeriod === "bigint"
      ? healthCheck.StartPeriod
      : BigInt(Number(healthCheck.StartPeriod || 0)),
    retries: Number.isInteger(healthCheck.Retries) ? healthCheck.Retries : Number(healthCheck.Retries || 0)
  };
};

const sameHealthCheck = (actual, desired) => {
  if (!desired) {
    return true;
  }

  if (!actual) {
    return false;
  }

  if (actual.command !== desired.command) {
    return false;
  }

  if (desired.interval != null && actual.interval !== desired.interval) {
    return false;
  }

  if (desired.timeout != null && actual.timeout !== desired.timeout) {
    return false;
  }

  if (desired.startPeriod != null && actual.startPeriod !== desired.startPeriod) {
    return false;
  }

  if (desired.retries != null && actual.retries !== desired.retries) {
    return false;
  }

  return true;
};

const managedLabelsFor = ({serviceName, stackMode, stackId}) => ({
  "scriptarr.managed-by": DEFAULT_WARDEN_NETWORK_ALIAS,
  "scriptarr.service": serviceName,
  "scriptarr.stack-mode": stackMode,
  "scriptarr.stack-id": stackId
});

/**
 * Build a normalized runtime status object from Docker inspect data.
 *
 * @param {{
 *   descriptor: Record<string, unknown>,
 *   inspect: Record<string, any> | null,
 *   driftReasons?: string[],
 *   conflict?: string | null
 * }} options
 * @returns {Record<string, unknown>}
 */
const buildServiceStatus = ({
  descriptor,
  inspect,
  driftReasons = [],
  conflict = null
}) => {
  const state = inspect?.State || {};
  const health = state?.Health?.Status || (state?.Running ? "running" : (inspect ? "stopped" : "missing"));

  return {
    name: descriptor.name,
    containerName: descriptor.containerName,
    image: descriptor.image,
    running: Boolean(state?.Running),
    status: state?.Status || "missing",
    health,
    conflict,
    managed: inspect?.Config?.Labels?.["scriptarr.managed-by"] === DEFAULT_WARDEN_NETWORK_ALIAS,
    driftReasons,
    publishedPorts: descriptor.publishedPorts,
    networkAliases: descriptor.networkAliases,
    containerImageId: normalizeString(inspect?.Image)
  };
};

/**
 * Create the mutable managed-stack runtime that lets Warden reconcile sibling
 * Scriptarr containers and report their current state through the API.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   logger: {info: Function, warn: Function, error: Function}
 * }} options
 * @returns {{
 *   initialize: () => Promise<void>,
 *   refreshStatus: () => Promise<{warden: Record<string, unknown>, managedServices: Array<Record<string, unknown>>}>,
 *   getStatusSnapshot: () => {warden: Record<string, unknown>, managedServices: Array<Record<string, unknown>>}
 * }}
 */
export const createManagedStackRuntime = ({env = process.env, logger}) => {
  const stackMode = resolveStackMode({env});
  const stackId = normalizeString(env.SCRIPTARR_STACK_ID) || DEFAULT_STACK_ID;
  const managedNetworkName = resolveManagedNetworkName({env});
  const dataRoot = normalizeString(env.SCRIPTARR_DATA_ROOT);
  const selfContainerName = normalizeString(env.SCRIPTARR_WARDEN_CONTAINER_NAME) || DEFAULT_WARDEN_CONTAINER_NAME;
  const selfContainerRef = normalizeString(env.HOSTNAME) || selfContainerName;

  const state = {
    initialized: false,
    socketAvailable: false,
    lastReconciledAt: null,
    lastError: null,
    selfAttachedToManagedNetwork: false,
    selfContainerName,
    selfContainerRef,
    dockerSocketPath: DEFAULT_DOCKER_SOCKET_PATH,
    managedServices: []
  };

  const refreshSelfStatus = async () => {
    if (!state.socketAvailable) {
      return {
        containerName: selfContainerName,
        containerRef: selfContainerRef,
        dockerSocketAvailable: false,
        dockerSocketPath: DEFAULT_DOCKER_SOCKET_PATH,
        runningInsideDocker: false,
        attachedNetworks: [],
        managedNetworkName,
        attachedToManagedNetwork: false,
        health: "unavailable",
        lastReconciledAt: state.lastReconciledAt,
        lastError: state.lastError
      };
    }

    const inspect = await inspectDockerContainer(selfContainerName) || await inspectDockerContainer(selfContainerRef);
    const attachedNetworks = Object.keys(inspect?.NetworkSettings?.Networks || {});
    const health = inspect?.State?.Health?.Status || (inspect?.State?.Running ? "running" : (inspect ? "stopped" : "unknown"));

    state.selfAttachedToManagedNetwork = attachedNetworks.includes(managedNetworkName);

    return {
      containerName: selfContainerName,
      containerRef: selfContainerRef,
      dockerSocketAvailable: state.socketAvailable,
      dockerSocketPath: DEFAULT_DOCKER_SOCKET_PATH,
      runningInsideDocker: Boolean(inspect),
      attachedNetworks,
      managedNetworkName,
      attachedToManagedNetwork: state.selfAttachedToManagedNetwork,
      health,
      lastReconciledAt: state.lastReconciledAt,
      lastError: state.lastError
    };
  };

  const desiredDescriptorFor = (service) => ({
    ...service,
    restartPolicy: stackMode === "test" ? "no" : "unless-stopped",
    labels: {
      ...managedLabelsFor({
        serviceName: service.name,
        stackMode,
        stackId
      })
    }
  });

  const compareDescriptor = (inspect, descriptor) => {
    const reasons = [];
    const envMap = mapFromEnvList(inspect?.Config?.Env || []);
    const desiredLabels = normalizeMapEntries(descriptor.labels);
    const actualLabels = inspect?.Config?.Labels || {};

    if (inspect?.Config?.Image !== descriptor.image) {
      reasons.push("image");
    }

    for (const [key, value] of normalizeMapEntries(descriptor.env)) {
      if (envMap[key] !== value) {
        reasons.push(`env:${key}`);
      }
    }

    for (const [key, value] of desiredLabels) {
      if (String(actualLabels[key] ?? "") !== value) {
        reasons.push(`label:${key}`);
      }
    }

    if (!sameList(actualMountsFor(inspect), desiredMountsFor(descriptor.mounts))) {
      reasons.push("mounts");
    }

    if (!sameList(actualPortsFor(inspect), desiredPortsFor(descriptor.publishedPorts))) {
      reasons.push("ports");
    }

    if (!includesAll(actualAliasesFor(inspect, managedNetworkName), desiredAliasesFor(descriptor))) {
      reasons.push("network");
    }

    if (!sameHealthCheck(actualHealthCheckFor(inspect), desiredHealthCheckFor(descriptor))) {
      reasons.push("healthCheck");
    }

    if (normalizeString(inspect?.HostConfig?.RestartPolicy?.Name || "no") !== resolveRestartPolicy(descriptor)) {
      reasons.push("restartPolicy");
    }

    return [...new Set(reasons)];
  };

  const ensureSelfNetworkAttachment = async () => {
    const inspect = await inspectDockerContainer(selfContainerName) || await inspectDockerContainer(selfContainerRef);
    if (!inspect) {
      logger.warn("Warden container could not be inspected for self-network attachment.", {
        container: selfContainerName,
        ref: selfContainerRef
      });
      return;
    }

    const attachedNetworks = Object.keys(inspect.NetworkSettings?.Networks || {});
    const aliases = actualAliasesFor(inspect, managedNetworkName);

    if (!attachedNetworks.includes(managedNetworkName)) {
      logger.info("Attaching Warden to the managed Docker network.", {
        container: inspect.Name?.replace(/^\//, "") || selfContainerName,
        network: managedNetworkName
      });
      await connectContainerToNetwork({
        containerName: inspect.Name?.replace(/^\//, "") || selfContainerName,
        networkName: managedNetworkName,
        aliases: [DEFAULT_WARDEN_NETWORK_ALIAS]
      });
      return;
    }

    if (!aliases.includes(DEFAULT_WARDEN_NETWORK_ALIAS)) {
      const resolvedName = inspect.Name?.replace(/^\//, "") || selfContainerName;
      logger.info("Reattaching Warden to refresh its managed network alias.", {
        container: resolvedName,
        network: managedNetworkName,
        alias: DEFAULT_WARDEN_NETWORK_ALIAS
      });
      await disconnectContainerFromNetwork({
        containerName: resolvedName,
        networkName: managedNetworkName
      });
      await connectContainerToNetwork({
        containerName: resolvedName,
        networkName: managedNetworkName,
        aliases: [DEFAULT_WARDEN_NETWORK_ALIAS]
      });
    }
  };

  const reconcileDescriptor = async (descriptor) => {
    const inspect = await inspectDockerContainer(descriptor.containerName);
    if (!inspect) {
      logger.info("Creating missing managed container.", {
        service: descriptor.name,
        container: descriptor.containerName,
        image: descriptor.image
      });
      await runDetachedContainer({
        name: descriptor.containerName,
        image: descriptor.image,
        env: descriptor.env,
        networkName: managedNetworkName,
        networkAliases: descriptor.networkAliases,
        mounts: descriptor.mounts,
        publishedPorts: descriptor.publishedPorts,
        healthCheck: descriptor.healthCheck,
        labels: descriptor.labels,
        restartPolicy: descriptor.restartPolicy,
        logger
      });
      await waitForContainerHealthy(descriptor.containerName);
      logger.info("Managed container created.", {
        service: descriptor.name,
        container: descriptor.containerName
      });
      return buildServiceStatus({
        descriptor,
        inspect: await inspectDockerContainer(descriptor.containerName)
      });
    }

    const labels = inspect?.Config?.Labels || {};
    if (labels["scriptarr.managed-by"] !== DEFAULT_WARDEN_NETWORK_ALIAS) {
      logger.warn("Managed service name is already occupied by an unmanaged container.", {
        service: descriptor.name,
        container: descriptor.containerName
      });
      return buildServiceStatus({
        descriptor,
        inspect,
        conflict: "A container with the managed service name already exists but is not Warden-managed."
      });
    }

    const driftReasons = compareDescriptor(inspect, descriptor);
    if (driftReasons.length > 0) {
      logger.warn("Recreating managed container because configuration drift was detected.", {
        service: descriptor.name,
        container: descriptor.containerName,
        driftReasons: driftReasons.join(",")
      });
      await removeDockerContainer(descriptor.containerName, {ignoreMissing: false});
      await runDetachedContainer({
        name: descriptor.containerName,
        image: descriptor.image,
        env: descriptor.env,
        networkName: managedNetworkName,
        networkAliases: descriptor.networkAliases,
        mounts: descriptor.mounts,
        publishedPorts: descriptor.publishedPorts,
        healthCheck: descriptor.healthCheck,
        labels: descriptor.labels,
        restartPolicy: descriptor.restartPolicy,
        logger
      });
      await waitForContainerHealthy(descriptor.containerName);
      logger.info("Managed container recreated.", {
        service: descriptor.name,
        container: descriptor.containerName
      });
      return buildServiceStatus({
        descriptor,
        inspect: await inspectDockerContainer(descriptor.containerName)
      });
    }

    if (!inspect?.State?.Running) {
      logger.info("Starting stopped managed container.", {
        service: descriptor.name,
        container: descriptor.containerName
      });
      await startDockerContainer(descriptor.containerName);
      await waitForContainerHealthy(descriptor.containerName);
    }

    if (inspect?.State?.Running && driftReasons.length === 0) {
      logger.debug("Managed container already matches the desired state.", {
        service: descriptor.name,
        container: descriptor.containerName
      });
    }

    return buildServiceStatus({
      descriptor,
      inspect: await inspectDockerContainer(descriptor.containerName)
    });
  };

  const removeStaleManagedContainers = async (plannedNames) => {
    const managed = await listContainersByLabel("scriptarr.managed-by", DEFAULT_WARDEN_NETWORK_ALIAS);
    for (const container of managed) {
      if (container.labels["scriptarr.stack-id"] !== stackId) {
        continue;
      }
      if (!plannedNames.has(container.name)) {
        logger.info("Removing stale managed container.", {
          container: container.name,
          image: container.image
        });
        await removeDockerContainer(container.name, {ignoreMissing: true});
      }
    }
  };

  const recreateDescriptor = async (descriptor) => {
    logger.info("Recreating managed container to apply an updated image.", {
      service: descriptor.name,
      container: descriptor.containerName,
      image: descriptor.image
    });
    await removeDockerContainer(descriptor.containerName, {ignoreMissing: true});
    await runDetachedContainer({
      name: descriptor.containerName,
      image: descriptor.image,
      env: descriptor.env,
      networkName: managedNetworkName,
      networkAliases: descriptor.networkAliases,
      mounts: descriptor.mounts,
      publishedPorts: descriptor.publishedPorts,
      healthCheck: descriptor.healthCheck,
      labels: descriptor.labels,
      restartPolicy: descriptor.restartPolicy,
      logger
    });
    await waitForContainerHealthy(descriptor.containerName);
    return buildServiceStatus({
      descriptor,
      inspect: await inspectDockerContainer(descriptor.containerName)
    });
  };

  const reconcileSelectedServices = async (serviceNames = [], {forceRecreate = false} = {}) => {
    const plan = resolveServicePlan({env});
    const requested = new Set((serviceNames || []).map((entry) => normalizeString(entry)).filter(Boolean));
    const descriptors = plan.services
      .filter((service) => requested.has(service.name))
      .map(desiredDescriptorFor);
    const statuses = [];

    for (const descriptor of descriptors) {
      const status = forceRecreate ? await recreateDescriptor(descriptor) : await reconcileDescriptor(descriptor);
      statuses.push(status);
      if (descriptor.name === "scriptarr-mysql" && plan.mysql.mode === "selfhost") {
        await waitForMySqlReady({
          containerName: descriptor.containerName,
          password: plan.mysql.password
        });
      }
    }

    await refreshStatus();
    return statuses;
  };

  const refreshStatus = async () => {
    state.socketAvailable = await dockerSocketAvailable();
    if (!state.socketAvailable) {
      state.managedServices = [];
      return {
        warden: await refreshSelfStatus(),
        managedServices: []
      };
    }

    const plan = resolveServicePlan({env});
    const descriptors = plan.services.map(desiredDescriptorFor);
    const managedServices = await Promise.all(descriptors.map(async (descriptor) => {
      const inspect = await inspectDockerContainer(descriptor.containerName);
      return buildServiceStatus({
        descriptor,
        inspect,
        driftReasons: inspect ? compareDescriptor(inspect, descriptor) : []
      });
    }));

    state.managedServices = managedServices;

    return {
      warden: await refreshSelfStatus(),
      managedServices
    };
  };

  const initialize = async () => {
    if (dataRoot) {
      await ensureScriptarrStorageFolders(dataRoot);
    }

    state.socketAvailable = await dockerSocketAvailable();
    if (!state.socketAvailable) {
      state.lastError = "Docker socket is unavailable.";
      logger.warn("Docker socket is unavailable. Warden cannot reconcile the managed stack.");
      await refreshStatus();
      return;
    }

    const plan = resolveServicePlan({env});
    const descriptors = plan.services.map(desiredDescriptorFor);

    try {
      logger.info("Reconciling managed Scriptarr stack.", {
        stackMode,
        network: managedNetworkName,
        serviceCount: descriptors.length
      });
      const networkResult = await ensureDockerNetwork(managedNetworkName);
      logger.info("Managed Docker network is ready.", {
        network: managedNetworkName,
        created: networkResult.created
      });
      await ensureSelfNetworkAttachment();

      const statuses = [];
      for (const descriptor of descriptors) {
        statuses.push(await reconcileDescriptor(descriptor));
        if (descriptor.name === "scriptarr-mysql" && plan.mysql.mode === "selfhost") {
          await waitForMySqlReady({
            containerName: descriptor.containerName,
            password: plan.mysql.password
          });
          logger.info("Managed MySQL is ready.", {
            container: descriptor.containerName
          });
        }
      }

      await removeStaleManagedContainers(new Set(descriptors.map((descriptor) => descriptor.containerName)));

      state.managedServices = statuses;
      state.lastReconciledAt = new Date().toISOString();
      state.lastError = statuses.find((entry) => entry.conflict)?.conflict || null;
      state.initialized = true;
      logger.info("Managed Scriptarr stack reconciliation completed.", {
        managedServices: statuses.length,
        lastError: state.lastError || ""
      });
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      logger.error("Failed to reconcile the managed Scriptarr stack.", {
        error: state.lastError
      });
    }

    await refreshStatus();
  };

  return {
    initialize,
    refreshStatus,
    reconcileSelectedServices,
    getStatusSnapshot: () => ({
      warden: {
        containerName: state.selfContainerName,
        containerRef: state.selfContainerRef,
        dockerSocketAvailable: state.socketAvailable,
        dockerSocketPath: DEFAULT_DOCKER_SOCKET_PATH,
        managedNetworkName,
        attachedToManagedNetwork: state.selfAttachedToManagedNetwork,
        lastReconciledAt: state.lastReconciledAt,
        lastError: state.lastError
      },
      managedServices: state.managedServices
    })
  };
};

