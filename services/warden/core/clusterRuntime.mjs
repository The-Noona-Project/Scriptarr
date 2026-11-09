/**
 * @file Aggregate host state and route operations to the service's local Docker steward.
 */
import {resolveClusterTopology} from "../config/clusterTopology.mjs";
import {createClusterAgentClient} from "./clusterAgentClient.mjs";

const UPDATABLE = new Set(["scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven", "scriptarr-portal", "scriptarr-oracle", "scriptarr-raven-worker"]);
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

/**
 * Add multi-host routing around an unchanged local runtime.
 *
 * @param {{env?: NodeJS.ProcessEnv, local: object, client?: object}} options local runtime and transport
 * @returns {object} compatible runtime with cluster host state and owner-routed operations
 */
export const createClusterRuntime = ({env = process.env, local, client = createClusterAgentClient({env})}) => {
  const topology = resolveClusterTopology({env});
  if (!topology.enabled) return local;
  const remoteHosts = topology.isPrimary ? topology.hosts.filter((host) => host.id !== topology.hostId) : [];
  let cachedHosts = [];
  let cacheAt = 0;
  let pending;
  const localStorage = (value) => ({
    ...value,
    hostId: topology.hostId,
    services: (value.services || []).filter((entry) => entry.service === "scriptarr-warden"
      || topology.owners[entry.service] === topology.hostId
      || (entry.service === "scriptarr-localai" && topology.owners["scriptarr-oracle"] === topology.hostId))
  });
  const remoteStates = async () => {
    if (pending) return pending;
    if (Date.now() - cacheAt < 3000) return cachedHosts;
    pending = Promise.all(remoteHosts.map(async (host) => {
      try {
        const runtime = await client.request(host, "/api/runtime");
        return {hostId: host.id, available: true, healthy: Boolean(runtime.warden?.dockerSocketAvailable) && !runtime.warden?.lastError, runtime};
      } catch (error) {
        return {hostId: host.id, available: false, error: errorMessage(error)};
      }
    })).then((hosts) => {
      cachedHosts = hosts;
      cacheAt = Date.now();
      return hosts;
    }).finally(() => { pending = null; });
    return pending;
  };
  const bootstrap = () => {
    const value = local.getBootstrap();
    const localRows = value.services || [];
    const byName = new Map(localRows.map((row) => [row.name, row]));
    return {
      ...value,
      topology,
      services: Object.entries(topology.owners).map(([name, hostId]) => ({
        ...(byName.get(name) || {name, containerName: name}), hostId
      })),
      hosts: topology.hosts.map(({id, address, services}) => ({id, address, services}))
    };
  };
  const updates = async (operation, requested) => {
    const selected = requested?.length ? [...new Set(requested)] : [...UPDATABLE].filter(service => topology.owners[service]);
    if (selected.some((service) => !UPDATABLE.has(service) || !topology.owners[service])) {
      const error = new Error("Only assigned first-party managed services can be updated.");
      error.status = 400;
      throw error;
    }
    if (!topology.isPrimary && selected.some((service) => topology.owners[service] !== topology.hostId) && requested?.length) {
      const error = new Error("This Warden agent only accepts updates for services assigned to its host.");
      error.status = 400;
      throw error;
    }
    const targets = topology.isPrimary ? topology.hosts : topology.hosts.filter((host) => host.id === topology.hostId);
    const results = await Promise.all(targets.map(async (host) => {
      const services = selected.filter((service) => topology.owners[service] === host.id);
      if (!services.length) return null;
      try {
        const result = host.id === topology.hostId
          ? await local[operation](services)
          : await client.request(host, operation === "getUpdates" ? "/api/updates" : `/api/updates/${operation === "checkUpdates" ? "check" : "install"}`, {
            method: operation === "getUpdates" ? "GET" : "POST", body: operation === "getUpdates" ? undefined : {services}
          });
        return {hostId: host.id, available: true, ...result};
      } catch (error) {
        if (error.status >= 400 && error.status < 500) {
          return {hostId: host.id, available: true, rejected: true, status: error.status, error: errorMessage(error), services: []};
        }
        return {hostId: host.id, available: false, error: errorMessage(error), services: services.map((name) => ({name, hostId: host.id, health: "unavailable", running: false}))};
      }
    }));
    const rows = results.filter(Boolean);
    const jobs = rows.filter((host) => host.job).map((host) => ({hostId: host.hostId, ...host.job}));
    const failedHost = rows.find((host) => !host.available);
    const rejectedHost = rows.find((host) => host.rejected);
    return {
      ok: !failedHost && !rejectedHost,
      ...(failedHost ? {error: `Warden host ${failedHost.hostId} is unavailable; some requested operations may not have run.`} : {}),
      ...(!failedHost && rejectedHost ? {status: rejectedHost.status, error: `Warden host ${rejectedHost.hostId} rejected the update operation: ${rejectedHost.error}`} : {}),
      services: rows.flatMap((host) => (host.services || []).map((service) => ({...service, hostId: host.hostId}))),
      hosts: rows.map(({hostId, available, error}) => ({hostId, available, ...(error ? {error} : {})})),
      jobs,
      job: jobs.find((job) => job.status === "running") || jobs.find((job) => job.status === "failed") || jobs[0] || null,
      checkedAt: rows.map((host) => host.checkedAt).filter(Boolean).sort().at(-1) || null
    };
  };
  const getRuntime = async () => {
    const runtime = await local.getRuntime();
    const remotes = await remoteStates();
    const remoteServices = remotes.flatMap((host) => host.available
      ? (host.runtime.managedServices || []).filter((service) => topology.owners[service.name] === host.hostId).map((service) => ({...service, hostId: host.hostId}))
      : topology.hosts.find((entry) => entry.id === host.hostId).services.map((name) => ({name, hostId: host.hostId, status: "unavailable", health: "unavailable", running: false, error: host.error})));
    return {
      ...runtime,
      ingestDegraded: ![...(runtime.managedServices || []), ...remoteServices].some(service =>
        service.name === "scriptarr-raven-worker" && service.running && service.health === "healthy" && service.managed
        && !service.conflict && !(service.driftReasons || []).length),
      ...bootstrap(),
      storage: localStorage(runtime.storage || {}),
      managedServices: [...(runtime.managedServices || []).map((service) => ({...service, hostId: topology.hostId})), ...remoteServices],
      hosts: [
        {hostId: topology.hostId, available: Boolean(runtime.warden?.dockerSocketAvailable), warden: runtime.warden},
        ...remotes.map(({hostId, available, healthy, runtime: remote, error}) => ({hostId, available, healthy: Boolean(healthy), ...(remote ? {warden: remote.warden} : {error})}))
      ],
      degraded: remotes.some((host) => !host.available || !host.healthy)
    };
  };
  const rejectStandaloneLocalAiMutation = async () => {
    const error = new Error("Standalone LocalAI controls are unavailable in multi-host mode. Manage Oracle's embedded backend through Oracle.");
    error.status = 409;
    throw error;
  };
  return {
    ...local,
    configureLocalAi: rejectStandaloneLocalAiMutation,
    installLocalAi: rejectStandaloneLocalAiMutation,
    startLocalAi: rejectStandaloneLocalAiMutation,
    removeLocalAi: rejectStandaloneLocalAiMutation,
    getBootstrap: bootstrap,
    getRuntime,
    getStorageLayout: () => localStorage(local.getStorageLayout()),
    async getHealth() {
      const health = await local.getHealth();
      void remoteStates();
      const hosts = remoteHosts.map((host) => cachedHosts.find((entry) => entry.hostId === host.id)
        || {hostId: host.id, available: false, healthy: false, error: "Agent state has not yet been refreshed."});
      const ingestDegraded = !topology.owners["scriptarr-raven-worker"] || hosts.some(host =>
        host.hostId === topology.owners["scriptarr-raven-worker"] && (!host.available
          || !(host.runtime?.managedServices || []).some(service => service.name === "scriptarr-raven-worker" && service.running && service.health === "healthy"
            && service.managed && !service.conflict && !(service.driftReasons || []).length)));
      return {...health, hostId: topology.hostId, ingestDegraded: Boolean(health.ingestDegraded || ingestDegraded), degraded: hosts.some((host) => !host.available || !host.healthy), hosts: hosts.map(({hostId, available, healthy, error}) => ({hostId, available, healthy: Boolean(healthy), ...(error ? {error} : {})}))};
    },
    getUpdates: () => updates("getUpdates"),
    checkUpdates: (services) => updates("checkUpdates", services),
    installUpdates: (services) => updates("installUpdates", services),
    async tailLogs(filters = {}) {
      const hostId = topology.owners[filters.service];
      const host = topology.hosts.find((entry) => entry.id === hostId);
      if (!topology.isPrimary || !host || host.id === topology.hostId) return local.tailLogs(filters);
      try {
        const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
        return {...await client.request(host, `/api/logs?${query}`), hostId};
      } catch (error) {
        return {hostId, selectedService: filters.service, entries: [], redacted: true, error: errorMessage(error)};
      }
    }
  };
};
