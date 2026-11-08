/**
 * @file Optional worker ownership, restricted credentials, WebP policy and TLS isolation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {resolveServicePlan} from "../config/servicePlan.mjs";
import {resourceLimitsMatchExtraArgs, createManagedStackRuntime} from "../core/managedStackRuntime.mjs";
import {createClusterRuntime} from "../core/clusterRuntime.mjs";

const topology = {primaryHostId: "core", hosts: [
  {id: "core", address: "192.168.50.6", agentUrl: "https://192.168.50.6:4401", services: ["scriptarr-mysql", "scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven"]},
  {id: "ai", address: "192.168.50.7", agentUrl: "https://192.168.50.7:4401", services: ["scriptarr-oracle", "scriptarr-portal", "scriptarr-raven-worker"]}
]};
const environment = (hostId = "core") => ({
  ...Object.fromEntries(["WARDEN", "VAULT", "SAGE", "MOON", "RAVEN", "PORTAL", "ORACLE"].map(name => [`SCRIPTARR_${name}_SERVICE_TOKEN`, `isolated-${name}-credential`])),
  SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(topology), SCRIPTARR_WARDEN_HOST_ID: hostId,
  SCRIPTARR_DATA_ROOT: "/isolated/appdata", SCRIPTARR_GPU_HINT: "nvidia",
  SCRIPTARR_ORACLE_CPUS: "4", SCRIPTARR_ORACLE_MEMORY: "8g",
  SCRIPTARR_RAVEN_WORKER_SERVICE_TOKEN: "isolated-worker-credential",
  SCRIPTARR_RAVEN_WORKER_SAGE_BASE_URL: "https://192.168.50.6:3444",
  SCRIPTARR_RAVEN_WORKER_CA_FILE: "/isolated/tls/ca.crt",
  SCRIPTARR_SAGE_WORKER_TLS_CERT_FILE: "/isolated/tls/worker-server.crt",
  SCRIPTARR_SAGE_WORKER_TLS_KEY_FILE: "/isolated/tls/worker-server.key"
});
const find = (plan, name) => plan.allServices.find(service => service.name === name);

test("unassigned optional workers leave WebP conversion waiting without local encoding or extra TLS grants", () => {
  const single = resolveServicePlan({env: {SCRIPTARR_GPU_HINT: "cpu", SCRIPTARR_RAVEN_AVIF_ENCODER: "nvenc", SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED: "false"}});
  assert.equal(find(single, "scriptarr-raven-worker"), undefined);
  assert.equal(find(single, "scriptarr-raven").env.SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED, "true");
  assert.equal(find(single, "scriptarr-raven").env.SCRIPTARR_RAVEN_AVIF_ENCODER, "cpu");
  const withoutWorker = structuredClone(topology);
  withoutWorker.hosts[1].services.pop();
  const plan = resolveServicePlan({env: {...environment(), SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(withoutWorker)}});
  assert.equal(find(plan, "scriptarr-raven-worker"), undefined);
  assert.equal(find(plan, "scriptarr-sage").env.SCRIPTARR_SAGE_WORKER_TLS_PORT, undefined);
  assert.equal(find(plan, "scriptarr-raven").env.SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED, "true");
});

test("only the remote steward owns the worker and shares the Raven artifact without granting shared storage", () => {
  const core = resolveServicePlan({env: environment()}), ai = resolveServicePlan({env: environment("ai")});
  assert.equal(core.services.some(service => service.name === "scriptarr-raven-worker"), false);
  assert.equal(ai.services.some(service => service.name === "scriptarr-raven"), false);
  const worker = find(ai, "scriptarr-raven-worker"), raven = find(core, "scriptarr-raven");
  assert.equal(worker.image, raven.image);
  assert.equal(worker.hostId, "ai");
  assert.equal(worker.optional, true);
  assert.match(worker.healthCheck.command, /grep -Eq.*ready/);
  assert.equal(worker.env.SCRIPTARR_RAVEN_ROLE, "ingest-worker");
  assert.equal(raven.env.SCRIPTARR_RAVEN_ROLE, "coordinator");
  assert.equal(raven.env.SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED, "true");
  assert.equal(worker.env.SCRIPTARR_RAVEN_WORKER_ID, "ai");
  assert.deepEqual(worker.publishedPorts, []);
  assert.deepEqual(worker.mounts.map(mount => mount.containerPath), ["/work", "/app/logs", "/app/worker-tls/ca.crt"]);
  assert.equal(worker.mounts[2].readOnly, true);
  assert.equal(worker.env.SCRIPTARR_SERVICE_TOKEN, environment().SCRIPTARR_RAVEN_WORKER_SERVICE_TOKEN);
  assert.equal(Object.keys(worker.env).some(key => /MYSQL|VAULT|WARDEN|DISCORD|NVIDIA|VPN|SERVICE_TOKENS/.test(key)), false);
  assert.equal(worker.extraArgs.some(arg => /NET_ADMIN|gpus|docker.sock|net\/tun|nvidia/.test(arg)), false);
});

test("worker CPU/memory/JVM and single-job WebP policy cannot be overridden by host GPU or concurrency hints", () => {
  const worker = find(resolveServicePlan({env: {...environment("ai"), JAVA_TOOL_OPTIONS: "-Xmx16g", SCRIPTARR_RAVEN_WEBP_THREADS: "32",
    SCRIPTARR_RAVEN_WEBP_PAGE_CONCURRENCY: "8", SCRIPTARR_RAVEN_WORKER_CHAPTER_CONCURRENCY: "8"}}), "scriptarr-raven-worker");
  assert.deepEqual(worker.extraArgs, ["--cpus", "2", "--memory", "4g", "--memory-swap", "4g", "--runtime", "runc", "--cap-drop", "ALL"]);
  assert.match(worker.env.JAVA_TOOL_OPTIONS, /-Xmx1536m/);
  assert.equal(worker.env.SCRIPTARR_RAVEN_WEBP_THREADS, "2");
  assert.equal(worker.env.SCRIPTARR_RAVEN_WEBP_PAGE_CONCURRENCY, "1");
  assert.equal(worker.env.SCRIPTARR_RAVEN_WORKER_CHAPTER_CONCURRENCY, "1");
  assert.equal(worker.env.SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT, "webp");
  assert.equal(worker.env.SCRIPTARR_RAVEN_WEBP_QUALITY, "85");
  assert.equal(worker.env.SCRIPTARR_RAVEN_WEBP_METHOD, "4");
  const valid = {HostConfig: {NanoCpus: 2e9, Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3}};
  assert.equal(resourceLimitsMatchExtraArgs(worker.extraArgs, valid), true);
  for (const key of ["NanoCpus", "Memory", "MemorySwap"]) {
    const bad = structuredClone(valid); bad.HostConfig[key] *= 2;
    assert.equal(resourceLimitsMatchExtraArgs(worker.extraArgs, bad), false);
  }
});

test("worker token reaches only Sage and TLS is exact-file/read-only with unchanged ordinary ports", () => {
  const plan = resolveServicePlan({env: environment()}), sage = find(plan, "scriptarr-sage");
  assert.equal(JSON.parse(sage.env.SCRIPTARR_SERVICE_TOKENS)["scriptarr-raven-worker"], environment().SCRIPTARR_RAVEN_WORKER_SERVICE_TOKEN);
  for (const name of ["scriptarr-vault", "scriptarr-portal"]) {
    assert.equal(JSON.parse(find(plan, name).env.SCRIPTARR_SERVICE_TOKENS)["scriptarr-raven-worker"], undefined);
  }
  assert.deepEqual(sage.publishedPorts, [{hostIp: "192.168.50.6", hostPort: 3004, containerPort: 3004}, {hostIp: "192.168.50.6", hostPort: 3444, containerPort: 3444}]);
  assert.deepEqual(sage.mounts.filter(mount => mount.readOnly).map(mount => mount.containerPath), ["/app/worker-tls/server.crt", "/app/worker-tls/server.key"]);
  assert.equal(sage.env.SCRIPTARR_SAGE_WORKER_TLS_CERT_FILE, "/app/worker-tls/server.crt");
  assert.equal(sage.env.SCRIPTARR_SAGE_WORKER_TLS_KEY_FILE, "/app/worker-tls/server.key");
  const oracle = find(resolveServicePlan({env: environment("ai")}), "scriptarr-oracle");
  assert.equal(oracle.env.SCRIPTARR_SAGE_BASE_URL, "http://192.168.50.6:3004");
  assert.deepEqual(oracle.extraArgs, ["--runtime", "nvidia", "--gpus", "all", "--cpus", "4", "--memory", "8g"]);
  assert.equal(find(plan, "scriptarr-raven").extraArgs.includes("NET_ADMIN"), true);
});

test("unsafe credentials, HTTP/foreign broker, TLS key sharing and malformed certificate paths fail before Docker", () => {
  for (const override of [
    {SCRIPTARR_RAVEN_WORKER_SERVICE_TOKEN: ""}, {SCRIPTARR_RAVEN_WORKER_SERVICE_TOKEN: "worker-dev-token"},
    {SCRIPTARR_RAVEN_WORKER_SERVICE_TOKEN: environment().SCRIPTARR_RAVEN_SERVICE_TOKEN},
    {SCRIPTARR_RAVEN_WORKER_SAGE_BASE_URL: "http://192.168.50.6:3444"},
    {SCRIPTARR_RAVEN_WORKER_SAGE_BASE_URL: "https://192.168.50.7:3444"},
    {SCRIPTARR_RAVEN_WORKER_SAGE_BASE_URL: "https://192.168.50.6:3444/anything"},
    {SCRIPTARR_RAVEN_WORKER_CA_FILE: "ca.crt"}, {SCRIPTARR_RAVEN_WORKER_CA_FILE: "/private/server.key"},
    {SCRIPTARR_SAGE_WORKER_TLS_KEY_FILE: "key"}, {SCRIPTARR_SAGE_WORKER_TLS_PORT: "3004"},
    {SCRIPTARR_WARDEN_TLS_KEY_FILE: environment().SCRIPTARR_SAGE_WORKER_TLS_KEY_FILE}
  ]) assert.throws(() => resolveServicePlan({env: {...environment(), ...override}}));
  const duplicate = structuredClone(topology); duplicate.hosts[0].services.push("scriptarr-raven-worker");
  assert.throws(() => resolveServicePlan({env: {...environment(), SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(duplicate)}}), /duplicate ownership/);
  const local = structuredClone(topology); local.hosts[1].services.pop(); local.hosts[0].services.push("scriptarr-raven-worker");
  assert.throws(() => resolveServicePlan({env: {...environment(), SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(local)}}), /remote host/);
});

test("worker image can be pinned independently while defaulting to the coordinator image", () => {
  const coordinatorPin = "registry/raven@sha256:" + "a".repeat(64), workerPin = "registry/raven@sha256:" + "b".repeat(64);
  const env = {...environment(), SCRIPTARR_RAVEN_IMAGE: coordinatorPin};
  assert.equal(find(resolveServicePlan({env}), "scriptarr-raven-worker").image, coordinatorPin);
  assert.equal(find(resolveServicePlan({env: {...env, SCRIPTARR_RAVEN_WORKER_IMAGE: workerPin}}), "scriptarr-raven-worker").image, workerPin);
});

test("unhealthy optional worker does not fail sibling initialization or trigger repeated recreations", async () => {
  const rows = new Map(), created = [], removed = [];
  let permitRepair = false;
  const runtime = createManagedStackRuntime({env: {}, logger: {info() {}, warn() {}, error() {}, debug() {}},
    resolvePlan: () => ({mysql: {mode: "external"}, services: [
      {name: "scriptarr-portal", containerName: "portal", image: "portal:test", env: {}},
      {name: "scriptarr-raven-worker", containerName: "worker", image: "raven:test", env: {}, optional: true,
        mounts: [{hostPath: "/isolated/ca.crt", containerPath: "/app/worker-tls/ca.crt", readOnly: true}]}
    ]}),
    dockerOps: {
      dockerSocketAvailable: async () => true, ensureDockerNetwork: async () => ({created: false}),
      inspectDockerContainer: async name => rows.get(name) || null, listContainersByLabel: async () => [],
      runDetachedContainer: async options => {
        created.push(options.name);
        rows.set(options.name, {Config: {Image: options.image, Env: [], Labels: options.labels},
          State: {Running: true, Status: "running", Health: {Status: options.name === "worker" ? "unhealthy" : "healthy"}},
          Mounts: (options.mounts || []).map(mount => ({Type: "bind", Source: mount.hostPath, Destination: mount.containerPath, RW: !mount.readOnly})),
          HostConfig: {RestartPolicy: {Name: "unless-stopped"}, CapDrop: ["ALL"]}});
      },
      waitForContainerHealthy: async name => { if (name === "worker") throw new Error("Optional encoder not ready"); },
      removeDockerContainer: async name => { assert.equal(permitRepair, true, "Must not recreate a matching unhealthy worker"); removed.push(name); rows.delete(name); },
      startDockerContainer: async () => assert.fail("Must not restart a running worker")
    }});
  await runtime.initialize();
  await runtime.initialize();
  const snapshot = runtime.getStatusSnapshot();
  assert.equal(snapshot.warden.lastError, null);
  assert.equal(snapshot.managedServices.find(service => service.name === "scriptarr-raven-worker").optional, true);
  assert.deepEqual(created, ["portal", "worker"]);
  assert.deepEqual(removed, []);
  permitRepair = true;
  rows.get("worker").Mounts[0].RW = true;
  await assert.rejects(runtime.reconcileSelectedServices(["scriptarr-raven-worker"]), /Optional encoder not ready/);
  assert.deepEqual(removed, ["worker"]);
  assert.equal(rows.get("worker").Mounts[0].RW, false);
});

test("remote ingest degradation preserves core health and worker updates route only to their Docker owner", async () => {
  const calls = [];
  const local = {getBootstrap: () => ({services: []}), getRuntime: async () => ({warden: {dockerSocketAvailable: true}, managedServices: []}),
    getHealth: async () => ({ok: true}), getUpdates: async () => ({}), installUpdates: async () => assert.fail("Worker must not be installed on core")};
  const client = {request: async (host, route, options) => {
    calls.push({hostId: host.id, route, body: options?.body});
    if (route === "/api/runtime") return {warden: {dockerSocketAvailable: true}, managedServices: [{name: "scriptarr-raven-worker", running: true, health: "unhealthy", managed: true}]};
    return {services: [{name: "scriptarr-raven-worker"}], job: {status: "running"}};
  }};
  const runtime = createClusterRuntime({env: environment(), local, client});
  assert.equal((await runtime.getRuntime()).ingestDegraded, true);
  assert.equal((await runtime.getHealth()).ok, true);
  assert.equal((await runtime.getHealth()).ingestDegraded, true);
  assert.equal((await runtime.installUpdates(["scriptarr-raven-worker"])).ok, true);
  assert.deepEqual(calls.at(-1), {hostId: "ai", route: "/api/updates/install", body: {services: ["scriptarr-raven-worker"]}});
  const without = structuredClone(topology); without.hosts[1].services.pop();
  const legacy = createClusterRuntime({env: {...environment(), SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(without)}, local, client});
  assert.equal((await legacy.getRuntime()).ingestDegraded, true);
  assert.equal((await legacy.getHealth()).ingestDegraded, true);
  assert.equal((await legacy.getHealth()).ok, true);
  await assert.rejects(legacy.installUpdates(["scriptarr-raven-worker"]), /assigned first-party/);
  const foreign = createClusterRuntime({env: environment(), local, client: {request: async () => ({warden: {dockerSocketAvailable: true},
    managedServices: [{name: "scriptarr-raven-worker", running: true, health: "healthy", managed: false}]})}});
  assert.equal((await foreign.getRuntime()).ingestDegraded, true);
});
