/**
 * @file Validate the authoritative multi-host Warden placement configuration.
 */
import {isIP} from "node:net";

const normalize = (value) => String(value ?? "").trim();
const REQUIRED_SERVICES = ["scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven", "scriptarr-portal", "scriptarr-oracle"];
const ALL_SERVICES = new Set(["scriptarr-mysql", ...REQUIRED_SERVICES]);

/**
 * Parse the shared placement map, rejecting ambiguous ownership before Docker is touched.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options] environment
 * @returns {object} validated local identity, primary identity, hosts and service owners
 */
export const resolveClusterTopology = ({env = process.env} = {}) => {
  const raw = normalize(env.SCRIPTARR_WARDEN_TOPOLOGY);
  if (!raw) {
    return {enabled: false, hostId: "local", primaryHostId: "local", isPrimary: true, hosts: [], owners: {}};
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("SCRIPTARR_WARDEN_TOPOLOGY must be valid JSON.");
  }
  if (!Array.isArray(input.hosts) || input.hosts.length < 2 || input.hosts.length > 8) {
    throw new Error("Warden topology requires between two and eight hosts.");
  }
  const ids = new Set();
  const addresses = new Set();
  const owners = {};
  const hosts = input.hosts.map((host) => {
    const id = normalize(host.id);
    const address = normalize(host.address);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || ids.has(id) || !isIP(address) || addresses.has(address)) {
      throw new Error("Warden hosts require unique safe ids and unique IP addresses.");
    }
    ids.add(id);
    addresses.add(address);
    let agentUrl;
    try {
      agentUrl = new URL(host.agentUrl);
    } catch {
      throw new Error(`Warden host ${id} requires an HTTPS agent URL.`);
    }
    if (agentUrl.protocol !== "https:" || agentUrl.hostname.replace(/^\[|\]$/g, "") !== address
      || agentUrl.username || agentUrl.password || agentUrl.search || agentUrl.hash || agentUrl.pathname !== "/") {
      throw new Error(`Warden host ${id} agent URL must be HTTPS on its configured IP with no extra path or credentials.`);
    }
    if (!Array.isArray(host.services) || !host.services.length) {
      throw new Error(`Warden host ${id} requires an explicit service list.`);
    }
    const services = host.services.map(normalize);
    for (const service of services) {
      if (!ALL_SERVICES.has(service) || owners[service]) {
        throw new Error(`Warden service ${service} has unknown or duplicate ownership.`);
      }
      owners[service] = id;
    }
    return {id, address, agentUrl: agentUrl.origin, services};
  });
  const hostId = normalize(env.SCRIPTARR_WARDEN_HOST_ID);
  const primaryHostId = normalize(input.primaryHostId);
  if (!ids.has(hostId) || !ids.has(primaryHostId) || REQUIRED_SERVICES.some((service) => !owners[service])) {
    throw new Error("Warden topology must identify the local/primary hosts and assign every first-party service once.");
  }
  if (owners["scriptarr-sage"] !== primaryHostId) {
    throw new Error("Sage must be assigned to the primary Warden host.");
  }
  if (["scriptarr-vault", "scriptarr-raven"].some((service) => owners[service] !== primaryHostId)) {
    throw new Error("Vault and Raven must share Sage's primary host because their ports remain private to its Docker network.");
  }
  if (owners["scriptarr-mysql"] && owners["scriptarr-mysql"] !== owners["scriptarr-vault"]) {
    throw new Error("Managed MySQL must be assigned to the same host as Vault.");
  }
  return {enabled: true, hostId, primaryHostId, isPrimary: hostId === primaryHostId, hosts, owners};
};

/**
 * Select a local Docker alias or a LAN service address from explicit ownership.
 *
 * @param {object} topology validated topology
 * @param {string} service service name
 * @param {number} port internal/LAN service port
 * @returns {string} HTTP service address
 */
export const resolveClusterServiceUrl = (topology, service, port) => {
  if (!topology.enabled || topology.owners[service] === topology.hostId) {
    return `http://${service}:${port}`;
  }
  const host = topology.hosts.find((entry) => entry.id === topology.owners[service]);
  if (!host) {
    throw new Error(`No host owns ${service}.`);
  }
  const address = isIP(host.address) === 6 ? `[${host.address}]` : host.address;
  return `http://${address}:${port}`;
};
