/**
 * @file Scriptarr Warden module: services/warden/tests/servicePlan.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {resolveServicePlan} from "../config/servicePlan.mjs";

test("service plan exposes the fixed Scriptarr network and selfhost mysql by default", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret",
      SUPERUSER_ID: "owner-1",
      SCRIPTARR_APPA_DISCORD_TOKEN: "appa-token",
      SCRIPTARR_APPA_DISCORD_CLIENT_ID: "appa-client-id",
      SCRIPTARR_GPU_HINT: "cpu"
    }
  });

  assert.equal(plan.managedNetworkName, "scriptarr-network");
  assert.equal(plan.stackMode, "production");
  assert.equal(plan.mysql.mode, "selfhost");
  assert.equal(plan.services.some((service) => service.name === "scriptarr-mysql"), true);
  const oracle = plan.services.find((service) => service.name === "scriptarr-oracle");
  const moon = plan.services.find((service) => service.name === "scriptarr-moon");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-moon").publishedPorts[0].hostPort, 3000);
  assert.equal(plan.services.find((service) => service.name === "scriptarr-vault").env.SUPERUSER_ID, "owner-1");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-raven").env.SCRIPTARR_RAVEN_LOG_DIR, "/app/logs");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-raven").env.SCRIPTARR_SAGE_BASE_URL, "http://scriptarr-sage:3004");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-raven").env.SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT, "avif");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-raven").env.SCRIPTARR_RAVEN_AVIF_REQUIRE_NVIDIA, "false");
  assert.deepEqual(plan.services.find((service) => service.name === "scriptarr-raven").extraArgs, ["--cap-add", "NET_ADMIN", "--device", "/dev/net/tun"]);
  assert.equal(plan.services.find((service) => service.name === "scriptarr-portal").env.SCRIPTARR_SAGE_BASE_URL, "http://scriptarr-sage:3004");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-sage").env.SCRIPTARR_APPA_DISCORD_TOKEN, "appa-token");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-sage").env.SCRIPTARR_APPA_DISCORD_CLIENT_ID, "appa-client-id");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-sage").env.SCRIPTARR_VAULT_AUTH_TIMEOUT_MS, "8000");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-portal").env.SCRIPTARR_APPA_DISCORD_TOKEN, "appa-token");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-portal").env.SCRIPTARR_APPA_DISCORD_CLIENT_ID, "appa-client-id");
  assert.equal(moon.env.SCRIPTARR_SERVICE_TOKEN, plan.serviceTokens["scriptarr-moon"]);
  assert.equal(moon.env.SCRIPTARR_PUBLIC_BASE_URL, "http://localhost:3000");
  assert.equal(moon.env.SCRIPTARR_MOON_READER_PAGE_CACHE_DIR, "/app/reader-page-cache");
  assert.equal(moon.mounts.some((mount) => mount.containerPath === "/app/reader-page-cache"), true);
  assert.equal(oracle.env.SCRIPTARR_SAGE_BASE_URL, "http://scriptarr-sage:3004");
  assert.equal(oracle.env.SCRIPTARR_LOCALAI_EMBEDDED, "true");
  assert.equal(oracle.env.SCRIPTARR_LOCALAI_BASE_URL, "http://127.0.0.1:8080/v1");
  assert.equal(oracle.env.SCRIPTARR_ORACLE_LOCALAI_GPU_PROFILE, "cpu");
  assert.equal(oracle.env.SCRIPTARR_LOCALAI_DEFAULT_MODEL.includes("Hermes-3-Llama-3.1-8B-Q4_K_S.gguf"), true);
  assert.equal(oracle.mounts.some((mount) => mount.containerPath === "/models"), true);
  assert.equal(oracle.mounts.some((mount) => mount.containerPath === "/data"), true);
  assert.match(plan.services.find((service) => service.name === "scriptarr-mysql").healthCheck.command, /mysqladmin ping/);
  assert.match(plan.services.find((service) => service.name === "scriptarr-moon").healthCheck.command, /127\.0\.0\.1:3000\/health/);
  assert.match(plan.services.find((service) => service.name === "scriptarr-raven").healthCheck.command, /curl -fsS http:\/\/127\.0\.0\.1:8080\/health/);
  assert.match(plan.services.find((service) => service.name === "scriptarr-oracle").healthCheck.command, /python -c/);
  assert.match(plan.services.find((service) => service.name === "scriptarr-oracle").healthCheck.command, /127\.0\.0\.1:3001\/health/);
});

test("service plan passes explicit Sage Vault auth timeout overrides", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret",
      SCRIPTARR_VAULT_AUTH_TIMEOUT_MS: "12000"
    }
  });

  assert.equal(plan.services.find((service) => service.name === "scriptarr-sage").env.SCRIPTARR_VAULT_AUTH_TIMEOUT_MS, "12000");
});

test("managed MySQL can pin the preserved database engine image by digest", () => {
  const image = "mysql@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb";
  const plan = resolveServicePlan({env: {SCRIPTARR_MYSQL_IMAGE: image, SCRIPTARR_MYSQL_DATABASE: "s75_noona", SCRIPTARR_GPU_HINT: "cpu"}});
  assert.equal(plan.services.find((service) => service.name === "scriptarr-mysql").image, image);
  assert.equal(plan.services.find((service) => service.name === "scriptarr-mysql").env.MYSQL_DATABASE, "s75_noona");
});

test("first-party service image pins override namespace and tag defaults", () => {
  const image = "docker.darkmatterservers.com/the-noona-project/scriptarr-oracle@sha256:0123456789abcdef";
  const plan = resolveServicePlan({env: {SCRIPTARR_IMAGE_NAMESPACE: "ignored", SCRIPTARR_IMAGE_TAG: "ignored", SCRIPTARR_ORACLE_IMAGE: image, SCRIPTARR_GPU_HINT: "cpu"}});
  assert.equal(plan.services.find((service) => service.name === "scriptarr-oracle").image, image);
  assert.equal(plan.services.find((service) => service.name === "scriptarr-moon").image, "ignored/scriptarr-moon:ignored");
});

test("service plan gives embedded Oracle LocalAI NVIDIA runtime args when hinted", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret",
      SCRIPTARR_ORACLE_LOCALAI_GPU_PROFILE: "nvidia",
      SCRIPTARR_LOCALAI_BASE_URL: "http://scriptarr-localai:8080/v1"
    }
  });

  const oracle = plan.services.find((service) => service.name === "scriptarr-oracle");
  assert.deepEqual(oracle.extraArgs, ["--runtime", "nvidia", "--gpus", "all"]);
  assert.equal(oracle.env.NVIDIA_VISIBLE_DEVICES, "all");
  assert.equal(oracle.env.NVIDIA_DRIVER_CAPABILITIES, "compute,utility");
  assert.equal(oracle.env.SCRIPTARR_ORACLE_LOCALAI_GPU_PROFILE, "nvidia");
  assert.equal(oracle.env.SCRIPTARR_LOCALAI_BASE_URL, "http://127.0.0.1:8080/v1");
});

test("service plan gives Raven ingest NVIDIA runtime args when hinted", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret",
      SCRIPTARR_RAVEN_INGEST_GPU_PROFILE: "nvidia"
    }
  });

  const raven = plan.services.find((service) => service.name === "scriptarr-raven");
  assert.deepEqual(raven.extraArgs, [
    "--cap-add", "NET_ADMIN",
    "--device", "/dev/net/tun",
    "--runtime", "nvidia",
    "--gpus", "all"
  ]);
  assert.equal(raven.env.SCRIPTARR_RAVEN_INGEST_GPU_PROFILE, "nvidia");
  assert.equal(raven.env.SCRIPTARR_RAVEN_INGEST_REQUIRE_NVIDIA, "false");
  assert.equal(raven.env.NVIDIA_VISIBLE_DEVICES, "all");
  assert.equal(raven.env.NVIDIA_DRIVER_CAPABILITIES, "compute,utility,video");
});

test("strict NVENC selects the NVIDIA runtime without requiring a separate GPU hint", () => {
  const plan = resolveServicePlan({env: {SCRIPTARR_RAVEN_AVIF_ENCODER: "nvenc", SCRIPTARR_GPU_HINT: "cpu"}});
  const raven = plan.services.find((service) => service.name === "scriptarr-raven");
  assert.equal(raven.extraArgs.includes("--gpus"), true);
  assert.equal(raven.env.SCRIPTARR_RAVEN_AVIF_REQUIRE_NVIDIA, "true");
  assert.equal(raven.env.SCRIPTARR_RAVEN_INGEST_REQUIRE_NVIDIA, "true");
  assert.throws(() => resolveServicePlan({env: {SCRIPTARR_RAVEN_AVIF_ENCODER: "nvenc", SCRIPTARR_RAVEN_INGEST_GPU_PROFILE: "cpu"}}), /requires the NVIDIA/);
});

test("service plan preserves Raven NVENC video capability when NVIDIA caps are overridden", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret",
      SCRIPTARR_RAVEN_INGEST_GPU_PROFILE: "nvidia",
      NVIDIA_DRIVER_CAPABILITIES: "compute,utility"
    }
  });

  const raven = plan.services.find((service) => service.name === "scriptarr-raven");
  assert.equal(raven.env.NVIDIA_DRIVER_CAPABILITIES, "compute,utility,video");
});

test("service plan gives Oracle and Raven NVIDIA runtime args when Docker exposes the NVIDIA runtime", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret",
      SCRIPTARR_DOCKER_INFO_RUNTIMES_JSON: JSON.stringify({
        runc: {path: "runc"},
        nvidia: {path: "/usr/bin/nvidia-container-runtime"}
      })
    }
  });

  const oracle = plan.services.find((service) => service.name === "scriptarr-oracle");
  const raven = plan.services.find((service) => service.name === "scriptarr-raven");
  assert.equal(oracle.extraArgs.includes("--gpus"), true);
  assert.equal(raven.extraArgs.includes("--gpus"), true);
  assert.equal(oracle.env.NVIDIA_VISIBLE_DEVICES, "all");
  assert.equal(oracle.env.SCRIPTARR_ORACLE_LOCALAI_GPU_PROFILE, "nvidia");
  assert.equal(raven.env.NVIDIA_VISIBLE_DEVICES, "all");
  assert.equal(raven.env.SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT, "avif");
  assert.equal(raven.env.SCRIPTARR_RAVEN_AVIF_REQUIRE_NVIDIA, "false");
});

test("service plan can explicitly disable Raven VPN runtime devices", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret",
      SCRIPTARR_GPU_HINT: "cpu",
      SCRIPTARR_RAVEN_VPN_RUNTIME_DISABLED: "true"
    }
  });

  assert.deepEqual(plan.services.find((service) => service.name === "scriptarr-raven").extraArgs, []);
});

test("service plan can override Raven VPN tun device path", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret",
      SCRIPTARR_GPU_HINT: "cpu",
      SCRIPTARR_RAVEN_TUN_DEVICE: "/custom/tun"
    }
  });

  assert.deepEqual(plan.services.find((service) => service.name === "scriptarr-raven").extraArgs, ["--cap-add", "NET_ADMIN", "--device", "/custom/tun"]);
});

test("service plan omits managed mysql for external mysql urls", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "mysql://db.example.com:3308/scriptarr",
      SCRIPTARR_MYSQL_USER: "external-user",
      SCRIPTARR_MYSQL_PASSWORD: "external-password",
      SCRIPTARR_WARDEN_BASE_URL: "http://host.docker.internal:4101"
    },
    containerNamePrefix: "scriptarr-test-demo"
  });

  assert.equal(plan.mysql.mode, "external");
  assert.equal(plan.services.some((service) => service.name === "scriptarr-mysql"), false);
  assert.equal(plan.services.find((service) => service.name === "scriptarr-vault").env.SCRIPTARR_MYSQL_HOST, "db.example.com");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-sage").env.SCRIPTARR_WARDEN_BASE_URL, "http://host.docker.internal:4101");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-sage").env.SCRIPTARR_SERVICE_TOKENS.includes("\"scriptarr-raven\""), true);
  assert.match(plan.services.find((service) => service.name === "scriptarr-vault").containerName, /^scriptarr-test-demo-vault$/);
  assert.match(plan.services.find((service) => service.name === "scriptarr-vault").healthCheck.command, /127\.0\.0\.1:3005\/health/);
});

test("test-mode service plans derive stack-scoped container names from the stack id", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_STACK_MODE: "test",
      SCRIPTARR_STACK_ID: "demo",
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret"
    }
  });

  assert.equal(plan.services.find((service) => service.name === "scriptarr-mysql").containerName, "scriptarr-test-demo-mysql");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-moon").containerName, "scriptarr-test-demo-moon");
});

