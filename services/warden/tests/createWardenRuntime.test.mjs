/**
 * @file Scriptarr Warden module: services/warden/tests/createWardenRuntime.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {createWardenRuntime} from "../core/createWardenRuntime.mjs";

test("warden bootstrap payload omits raw secrets while keeping the install contract", () => {
  const runtime = createWardenRuntime({
    env: {
      SCRIPTARR_PUBLIC_BASE_URL: "https://scriptarr.example.com",
      SCRIPTARR_MYSQL_URL: "mysql://vault-user:vault-password@db.example.com:3306/scriptarr",
      SCRIPTARR_DISCORD_CLIENT_ID: "discord-client-id",
      SCRIPTARR_DISCORD_CLIENT_SECRET: "discord-client-secret",
      DISCORD_TOKEN: "discord-bot-token",
      SUPERUSER_ID: "owner-1"
    }
  });

  const bootstrap = runtime.getBootstrap();
  const serialized = JSON.stringify(bootstrap);

  assert.equal(bootstrap.callbackUrl, "https://scriptarr.example.com/api/moon/auth/discord/callback");
  assert.equal(bootstrap.superuserRequired, true);
  assert.equal(bootstrap.mysql.user, "vault-user");
  assert.doesNotMatch(serialized, /vault-password|discord-client-secret|discord-bot-token/);
});

test("warden initialize refreshes the LocalAI runtime after stack reconciliation", async () => {
  const calls = [];
  const loggerFactory = () => ({
    info() {},
    warn() {},
    error() {}
  });

  const runtime = createWardenRuntime({
    env: {},
    loggerFactory,
    localAiRuntimeFactory: () => ({
      async initialize() {
        calls.push("localai");
      },
      getStatus() {
        return {};
      },
      async refreshStatus() {
        return {};
      },
      async configure() {
        return {};
      },
      async install() {
        return {};
      },
      async start() {
        return {};
      }
    }),
    managedStackRuntimeFactory: () => ({
      async initialize() {
        calls.push("stack");
      },
      async refreshStatus() {
        return {};
      },
      getStatusSnapshot() {
        return {
          warden: {},
          managedServices: []
        };
      }
    }),
    updateRuntimeFactory: () => ({
      async getStatus() {
        return {};
      },
      async checkForUpdates() {
        return {};
      },
      async installUpdates() {
        return {};
      }
    })
  });

  await runtime.initialize();
  assert.deepEqual(calls, ["stack", "localai"]);
});
