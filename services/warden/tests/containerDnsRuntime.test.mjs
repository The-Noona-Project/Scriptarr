/**
 * @file Test service DNS reconciliation across every managed container creation path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {createManagedStackRuntime} from "../core/managedStackRuntime.mjs";

const fixture = (services, {missing = false, dns = []} = {}) => {
  const created = [], removed = [], rows = new Map();
  const inspectFor = (service, servers) => ({
    Config: {Image: service.image, Env: [], Labels: {"scriptarr.managed-by": "scriptarr-warden", "scriptarr.service": service.name,
      "scriptarr.stack-mode": "production", "scriptarr.stack-id": "default"}},
    HostConfig: {Dns: servers, RestartPolicy: {Name: "unless-stopped"}, NanoCpus: 0, Memory: 0},
    NetworkSettings: {Networks: {"scriptarr-network": {Aliases: [service.name]}}},
    Mounts: [], State: {Running: true, Health: {Status: "healthy"}}
  });
  for (const service of services) if (!missing) rows.set(service.name, inspectFor(service, dns));
  const runtime = createManagedStackRuntime({
    env: {}, logger: {info() {}, warn() {}, error() {}, debug() {}},
    resolvePlan: () => ({services, mysql: {mode: "external"}}),
    dockerOps: {
      dockerSocketAvailable: async () => true,
      inspectDockerContainer: async (name) => rows.get(name) || null,
      removeDockerContainer: async (name) => {removed.push(name); rows.delete(name);},
      runDetachedContainer: async (descriptor) => {created.push(descriptor); rows.set(descriptor.name, inspectFor(descriptor, descriptor.dnsServers || []));},
      waitForContainerHealthy: async () => {}
    }
  });
  return {runtime, created, removed};
};

const descriptor = (name, dnsServers) => ({name, containerName: name, image: "fixture:release", env: {}, networkAliases: [name],
  mounts: [], publishedPorts: [], ...(dnsServers === undefined ? {} : {dnsServers})});

test("missing, drifted and forced-update paths all pass configured DNS to Docker", async () => {
  for (const mode of ["missing", "drift", "force"]) {
    const service = descriptor("scriptarr-raven", ["1.1.1.1", "8.8.8.8"]);
    const state = fixture([service], {missing: mode === "missing", dns: mode === "force" ? service.dnsServers : []});
    await state.runtime.reconcileSelectedServices([service.name], {forceRecreate: mode === "force"});
    assert.equal(state.created.length, 1, mode);
    assert.deepEqual(state.created[0].dnsServers, service.dnsServers, mode);
    assert.equal(state.removed.length, mode === "missing" ? 0 : 1, mode);
    await state.runtime.reconcileSelectedServices([service.name]);
    assert.equal(state.created.length, 1, "matching DNS must not cause perpetual recreation");
  }
});

test("a Raven DNS drift recreates only Raven while every other service keeps inherited DNS", async () => {
  const services = ["mysql", "vault", "sage", "moon", "raven", "oracle", "portal"].map((name) =>
    descriptor("scriptarr-" + name, name === "raven" ? ["1.1.1.1", "8.8.8.8"] : undefined));
  const state = fixture(services, {dns: ["192.168.50.1"]});
  await state.runtime.reconcileSelectedServices(services.map((service) => service.name));
  assert.deepEqual(state.removed, ["scriptarr-raven"]);
  assert.deepEqual(state.created.map((entry) => entry.name), ["scriptarr-raven"]);
});
