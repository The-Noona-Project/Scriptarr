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
  waitForMySqlReady
} from "../docker/dockerCli.mjs";
import {toDockerDesktopHostPath} from "../filesystem/storageLayout.mjs";

const normalizeString = (value) => String(value ?? "").trim();

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
    networkAliases: descriptor.networkAliases
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
      await connectContainerToNetwork({
        containerName: inspect.Name?.replace(/^\//, "") || selfContainerName,
        networkName: managedNetworkName,
        aliases: [DEFAULT_WARDEN_NETWORK_ALIAS]
      });
      return;
    }

    if (!aliases.includes(DEFAULT_WARDEN_NETWORK_ALIAS)) {
      const resolvedName = inspect.Name?.replace(/^\//, "") || selfContainerName;
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
      await runDetachedContainer({
        name: descriptor.containerName,
        image: descriptor.image,
        env: descriptor.env,
        networkName: managedNetworkName,
        networkAliases: descriptor.networkAliases,
        mounts: descriptor.mounts,
        publishedPorts: descriptor.publishedPorts,
        labels: descriptor.labels,
        restartPolicy: descriptor.restartPolicy
      });
      return buildServiceStatus({
        descriptor,
        inspect: await inspectDockerContainer(descriptor.containerName)
      });
    }

    const labels = inspect?.Config?.Labels || {};
    if (labels["scriptarr.managed-by"] !== DEFAULT_WARDEN_NETWORK_ALIAS) {
      return buildServiceStatus({
        descriptor,
        inspect,
        conflict: "A container with the managed service name already exists but is not Warden-managed."
      });
    }

    const driftReasons = compareDescriptor(inspect, descriptor);
    if (driftReasons.length > 0) {
      await removeDockerContainer(descriptor.containerName, {ignoreMissing: false});
      await runDetachedContainer({
        name: descriptor.containerName,
        image: descriptor.image,
        env: descriptor.env,
        networkName: managedNetworkName,
        networkAliases: descriptor.networkAliases,
        mounts: descriptor.mounts,
        publishedPorts: descriptor.publishedPorts,
        labels: descriptor.labels,
        restartPolicy: descriptor.restartPolicy
      });
      return buildServiceStatus({
        descriptor,
        inspect: await inspectDockerContainer(descriptor.containerName)
      });
    }

    if (!inspect?.State?.Running) {
      await startDockerContainer(descriptor.containerName);
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
        await removeDockerContainer(container.name, {ignoreMissing: true});
      }
    }
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
      await refreshStatus();
      return;
    }

    const plan = resolveServicePlan({env});
    const descriptors = plan.services.map(desiredDescriptorFor);

    try {
      await ensureDockerNetwork(managedNetworkName);
      await ensureSelfNetworkAttachment();

      const statuses = [];
      for (const descriptor of descriptors) {
        statuses.push(await reconcileDescriptor(descriptor));
        if (descriptor.name === "scriptarr-mysql" && plan.mysql.mode === "selfhost") {
          await waitForMySqlReady({
            containerName: descriptor.containerName,
            password: plan.mysql.password
          });
        }
      }

      await removeStaleManagedContainers(new Set(descriptors.map((descriptor) => descriptor.containerName)));

      state.managedServices = statuses;
      state.lastReconciledAt = new Date().toISOString();
      state.lastError = statuses.find((entry) => entry.conflict)?.conflict || null;
      state.initialized = true;
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

