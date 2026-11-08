/**
 * @file Verify placement ownership, cross-host service addresses and CPU resource planning.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {resolveClusterTopology} from "../config/clusterTopology.mjs";
import {resolveServicePlan} from "../config/servicePlan.mjs";

const topology = {
  primaryHostId: "core",
  hosts: [
    {id: "core", address: "192.168.50.6", agentUrl: "https://192.168.50.6:4401", services: ["scriptarr-mysql", "scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven"]},
    {id: "ai", address: "192.168.50.7", agentUrl: "https://192.168.50.7:4401", services: ["scriptarr-oracle", "scriptarr-portal"]}
  ]
};
const environment = (hostId) => ({
  ...Object.fromEntries(["WARDEN", "VAULT", "SAGE", "MOON", "RAVEN", "PORTAL", "ORACLE"].map((name) =>
    [`SCRIPTARR_${name}_SERVICE_TOKEN`, `test-only-${name.toLowerCase()}-explicit-service-token`])),
  SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(topology), SCRIPTARR_WARDEN_HOST_ID: hostId,
  SCRIPTARR_GPU_HINT: "cpu", SCRIPTARR_MYSQL_DATABASE: "s75_noona", SCRIPTARR_RAVEN_AVIF_ENCODER: "cpu",
  SCRIPTARR_ORACLE_CPUS: "4", SCRIPTARR_ORACLE_MEMORY: "8g"
});

test("multi-host planning rejects missing or known development credentials", () => {
  for (const name of ["WARDEN", "VAULT", "SAGE", "MOON", "RAVEN", "PORTAL", "ORACLE"]) {
    for (const token of [undefined, "", `${name.toLowerCase()}-dev-token`]) {
      assert.throws(() => resolveServicePlan({env: {...environment("core"), [`SCRIPTARR_${name}_SERVICE_TOKEN`]: token}}), /requires explicit non-development service tokens/);
    }
  }
});

test("each host plans only its assigned services and injects reachable broker addresses", () => {
  const core = resolveServicePlan({env: environment("core")});
  const ai = resolveServicePlan({env: environment("ai")});
  assert.deepEqual(core.services.map((service) => service.name), ["scriptarr-mysql", "scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven"]);
  assert.deepEqual(ai.services.map((service) => service.name), ["scriptarr-portal", "scriptarr-oracle"]);
  const sage = core.services.find((service) => service.name === "scriptarr-sage");
  assert.equal(sage.env.SCRIPTARR_ORACLE_BASE_URL, "http://192.168.50.7:3001");
  assert.equal(sage.env.SCRIPTARR_PORTAL_BASE_URL, "http://192.168.50.7:3003");
  assert.equal(sage.env.SCRIPTARR_VAULT_BASE_URL, "http://scriptarr-vault:3005");
  assert.equal(sage.publishedPorts[0].hostIp, "192.168.50.6");
  const oracle = ai.services.find((service) => service.name === "scriptarr-oracle");
  assert.equal(oracle.env.SCRIPTARR_SAGE_BASE_URL, "http://192.168.50.6:3004");
  assert.equal(oracle.env.SCRIPTARR_REQUIRE_SERVICE_AUTH, "true");
  assert.deepEqual(oracle.extraArgs, ["--cpus", "4", "--memory", "8g"]);
  assert.equal(core.services.find((service) => service.name === "scriptarr-vault").env.SCRIPTARR_MYSQL_DATABASE, "s75_noona");
  assert.deepEqual(core.services.find((service) => service.name === "scriptarr-mysql").publishedPorts, []);
});

test("explicit CPU encoding removes all NVIDIA requirements even on a GPU-enabled host", () => {
  const plan = resolveServicePlan({env: {...environment("core"), SCRIPTARR_GPU_HINT: "nvidia"}});
  const raven = plan.services.find((service) => service.name === "scriptarr-raven");
  assert.equal(raven.env.SCRIPTARR_RAVEN_AVIF_REQUIRE_NVIDIA, "false");
  assert.equal(raven.env.SCRIPTARR_RAVEN_INGEST_REQUIRE_NVIDIA, "false");
  assert.equal(raven.env.SCRIPTARR_RAVEN_INGEST_GPU_PROFILE, "cpu");
  assert.equal(raven.env.SCRIPTARR_RAVEN_AVIF_ENCODER_SLOTS, "1");
  assert.equal(raven.env.SCRIPTARR_RAVEN_AVIF_PAGE_CONCURRENCY, "1");
  assert.equal(raven.env.SCRIPTARR_RAVEN_AVIF_THREADS, "2");
  assert.equal(raven.env.NVIDIA_VISIBLE_DEVICES, undefined);
  assert.equal(raven.extraArgs.includes("--gpus"), false);
});

test("ambiguous ownership and insecure remote agent addresses fail before planning containers", () => {
  const duplicate = structuredClone(topology);
  duplicate.hosts[1].services.push("scriptarr-sage");
  assert.throws(() => resolveClusterTopology({env: {...environment("core"), SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(duplicate)}}), /duplicate ownership/);
  const insecure = structuredClone(topology);
  insecure.hosts[1].agentUrl = "http://192.168.50.7:4401";
  assert.throws(() => resolveClusterTopology({env: {...environment("core"), SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(insecure)}}), /must be HTTPS/);
  assert.throws(() => resolveClusterTopology({env: {...environment("core"), SCRIPTARR_WARDEN_HOST_ID: "unknown"}}), /local\/primary/);
});

test("private Vault and Raven placements must remain with Sage", () => {
  for (const service of ["scriptarr-vault", "scriptarr-raven"]) {
    const remote = structuredClone(topology);
    const moved = service === "scriptarr-vault" ? [service, "scriptarr-mysql"] : [service];
    remote.hosts[0].services = remote.hosts[0].services.filter((name) => !moved.includes(name));
    remote.hosts[1].services.push(...moved);
    for (const hostId of ["core", "ai"]) {
      assert.throws(() => resolveServicePlan({env: {
        ...environment(hostId), SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(remote)
      }}), /Vault and Raven must share Sage's primary host/);
    }
  }
});
