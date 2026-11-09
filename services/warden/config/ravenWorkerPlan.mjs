/**
 * @file Restricted, optional remote Raven ingest worker descriptor.
 */
import path from "node:path";
import {resolveServiceImage} from "./images.mjs";
import {isWindowsAbsolutePath} from "../filesystem/storageLayout.mjs";

/**
 * Validate the worker-only broker identity and build its bounded CPU runtime.
 * No worker receives a coordinator credential, canonical file mount or provider configuration.
 *
 * @param {object} options deployment configuration
 * @param {NodeJS.ProcessEnv} options.env host environment
 * @param {object} options.topology authoritative placement
 * @param {object} options.serviceTokens existing coordinator/service credentials
 * @param {object} options.storageLayout host-local storage layout
 * @param {string} options.containerName prefixed worker container name
 * @returns {object | null} optional service descriptor
 */
export const resolveRavenWorkerPlan = ({env, topology, serviceTokens, storageLayout, containerName}) => {
  const workerHostId = topology.owners["scriptarr-raven-worker"];
  if (!topology.enabled || !workerHostId) return null;
  if (workerHostId === topology.primaryHostId) throw new Error("Raven ingest worker must be assigned to a remote host.");
  const token = String(env.SCRIPTARR_RAVEN_WORKER_SERVICE_TOKEN || "").trim();
  if (!token || /-dev-token$/i.test(token) || Object.values(serviceTokens).some(value => String(value).trim() === token)) {
    throw new Error("Raven worker requires an explicit non-development service token distinct from every other service.");
  }
  const primary = topology.hosts.find(host => host.id === topology.primaryHostId);
  let url;
  try { url = new URL(env.SCRIPTARR_RAVEN_WORKER_SAGE_BASE_URL); } catch {
    throw new Error("Raven worker requires an explicit HTTPS Sage broker URL.");
  }
  if (url.protocol !== "https:" || url.hostname.replace(/^\[|\]$/g, "") !== primary.address
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Raven worker broker must use HTTPS on the primary host with no path or credentials.");
  }
  const caFile = String(env.SCRIPTARR_RAVEN_WORKER_CA_FILE || "").trim();
  if ((!path.isAbsolute(caFile) && !isWindowsAbsolutePath(caFile)) || /[\0\r\n]/.test(caFile) || !/\.(crt|pem)$/i.test(caFile)) {
    throw new Error("Raven worker requires an absolute dedicated Sage CA file path.");
  }
  const folders = storageLayout.services["scriptarr-raven-worker"];
  return {
    name: "scriptarr-raven-worker", containerName, image: resolveServiceImage("scriptarr-raven-worker", {env}),
    optional: true,
    env: {
      SCRIPTARR_RAVEN_ROLE: "ingest-worker",
      SCRIPTARR_SERVICE_TOKEN: token,
      SCRIPTARR_SAGE_BASE_URL: url.origin,
      SCRIPTARR_RAVEN_WORKER_CA_FILE: "/app/worker-tls/ca.crt",
      SCRIPTARR_RAVEN_WORKER_ID: workerHostId,
      SCRIPTARR_RAVEN_WORKER_SCRATCH_ROOT: "/work",
      SCRIPTARR_RAVEN_LOG_DIR: "/app/logs",
      SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT: "webp",
      SCRIPTARR_RAVEN_WEBP_THREADS: "2",
      SCRIPTARR_RAVEN_WEBP_PAGE_CONCURRENCY: "1",
      SCRIPTARR_RAVEN_WORKER_CHAPTER_CONCURRENCY: "1",
      SCRIPTARR_RAVEN_WEBP_QUALITY: "85",
      SCRIPTARR_RAVEN_WEBP_METHOD: "4",
      JAVA_TOOL_OPTIONS: "-Xms128m -Xmx1536m -XX:MaxDirectMemorySize=256m -XX:ActiveProcessorCount=2"
    },
    mounts: [folders.scratch, folders.logs, {hostPath: caFile, containerPath: "/app/worker-tls/ca.crt", readOnly: true}],
    networkAliases: ["scriptarr-raven-worker"], publishedPorts: [], containerPort: 8080,
    extraArgs: ["--cpus", "2", "--memory", "4g", "--memory-swap", "4g", "--runtime", "runc", "--cap-drop", "ALL"],
    healthCheck: {command: "curl -fsS http://127.0.0.1:8080/health | grep -Eq '\"ready\"[[:space:]]*:[[:space:]]*true'", interval: "15s", timeout: "5s", startPeriod: "25s", retries: 5}
  };
};
