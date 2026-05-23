/**
 * @file Scriptarr Sage tests: services/sage/tests/vaultClient.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {createVaultClient} from "../lib/vaultClient.mjs";

const originalFetch = globalThis.fetch;

/**
 * Build a JSON fetch response for the Vault client timeout wiring tests.
 *
 * @param {Record<string, unknown>} payload
 * @param {number} [status]
 * @returns {Response}
 */
const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: {"Content-Type": "application/json"}
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("vault auth methods attach timeout signals", async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({
      url: String(input),
      method: init.method || "GET",
      hasSignal: init.signal instanceof AbortSignal
    });
    const url = String(input);
    if (url.endsWith("/api/service/sessions")) {
      return jsonResponse({token: "session-token"});
    }
    if (url.includes("/api/service/sessions/")) {
      return jsonResponse({discordUserId: "owner-1"});
    }
    if (url.endsWith("/api/service/api-keys/resolve")) {
      return jsonResponse({id: "api-key-1", kind: "system"});
    }
    if (url.endsWith("/api/service/events")) {
      return jsonResponse({ok: true});
    }
    return jsonResponse({
      ownerClaimed: false,
      discordUserId: "owner-1",
      username: "Owner"
    });
  };

  const client = createVaultClient({
    vaultBaseUrl: "http://vault.test",
    serviceToken: "vault-token",
    vaultAuthTimeoutMs: 1234
  });

  await client.getBootstrapStatus();
  await client.upsertDiscordUser({discordUserId: "owner-1"});
  await client.getUserByDiscordId("owner-1");
  await client.createSession("owner-1");
  await client.getSessionUser("session-token");
  await client.clearSession("session-token");
  await client.clearSessionsForUser("owner-1");
  await client.resolveApiKey("hash");
  await client.appendEvent({domain: "auth"}, {timeoutMs: 77});

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    "GET /api/public/bootstrap-status",
    "POST /api/service/users/upsert-discord",
    "GET /api/service/users/by-discord/owner-1",
    "POST /api/service/sessions",
    "GET /api/service/sessions/session-token",
    "DELETE /api/service/sessions/session-token",
    "DELETE /api/service/sessions/user/owner-1",
    "POST /api/service/api-keys/resolve",
    "POST /api/service/events"
  ]);
  assert.equal(calls.every((call) => call.hasSignal), true);
});

test("vault getSetting retries transient fetch failures with bounded timeouts", async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({
      url: String(input),
      method: init.method || "GET",
      hasSignal: init.signal instanceof AbortSignal
    });
    if (calls.length === 1) {
      throw new Error("fetch failed");
    }
    return jsonResponse({key: "portal.discord", value: {guildId: "guild-1"}});
  };

  const client = createVaultClient({
    vaultBaseUrl: "http://vault.test",
    serviceToken: "vault-token"
  });

  const setting = await client.getSetting("portal.discord", {
    timeoutMs: 123,
    retries: 2,
    retryDelayMs: 1,
    context: "Failed to load Portal Discord settings from Vault"
  });

  assert.deepEqual(setting, {key: "portal.discord", value: {guildId: "guild-1"}});
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    "GET /api/service/settings/portal.discord",
    "GET /api/service/settings/portal.discord"
  ]);
  assert.equal(calls.every((call) => call.hasSignal), true);
});

test("vault auth user methods retry transient fetch failures with bounded timeouts", async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({
      url: String(input),
      method: init.method || "GET",
      hasSignal: init.signal instanceof AbortSignal
    });
    if (calls.length === 1 || calls.length === 3 || calls.length === 5) {
      throw new Error("fetch failed");
    }
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/public/bootstrap-status") {
      return jsonResponse({ownerClaimed: false});
    }
    if (pathname.includes("/api/service/users/by-discord/")) {
      return jsonResponse({discordUserId: "owner-1", role: "member"});
    }
    if (pathname === "/api/service/users/upsert-discord") {
      return jsonResponse({discordUserId: "owner-1", role: "owner"});
    }
    return jsonResponse({ok: true});
  };

  const client = createVaultClient({
    vaultBaseUrl: "http://vault.test",
    serviceToken: "vault-token"
  });

  assert.deepEqual(await client.getBootstrapStatus({timeoutMs: 123, retries: 2, retryDelayMs: 1}), {ownerClaimed: false});
  assert.deepEqual(await client.getUserByDiscordId("owner-1", {timeoutMs: 123, retries: 2, retryDelayMs: 1}), {
    discordUserId: "owner-1",
    role: "member"
  });
  assert.deepEqual(await client.upsertDiscordUser({discordUserId: "owner-1"}, {
    timeoutMs: 123,
    retries: 2,
    retryDelayMs: 1,
    throwOnError: true
  }), {
    discordUserId: "owner-1",
    role: "owner"
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    "GET /api/public/bootstrap-status",
    "GET /api/public/bootstrap-status",
    "GET /api/service/users/by-discord/owner-1",
    "GET /api/service/users/by-discord/owner-1",
    "POST /api/service/users/upsert-discord",
    "POST /api/service/users/upsert-discord"
  ]);
  assert.equal(calls.every((call) => call.hasSignal), true);
});
