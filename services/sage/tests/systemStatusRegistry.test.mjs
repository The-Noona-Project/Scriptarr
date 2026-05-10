import test from "node:test";
import assert from "node:assert/strict";
import {buildEndpointRegistry, buildSystemStatusPayload} from "../lib/systemStatusRegistry.mjs";

test("system status registry groups known services and avoids probing mutations", () => {
  const registry = buildEndpointRegistry();
  assert.deepEqual(registry.map((group) => group.id), [
    "moon",
    "sage",
    "vault",
    "raven",
    "warden",
    "portal",
    "oracle",
    "localai"
  ]);
  const endpoints = registry.flatMap((group) => group.endpoints);
  assert.equal(endpoints.filter((endpoint) => endpoint.method === "GET").every((endpoint) => endpoint.safeToProbe), true);
  assert.equal(endpoints.filter((endpoint) => endpoint.method !== "GET").every((endpoint) => !endpoint.safeToProbe), true);
  assert.equal(endpoints.find((endpoint) => endpoint.path === "/api/internal/portal/notifications/system")?.probeBase, "sage");
});

test("system status payload probes GET reads, classifies protected routes, and keeps mutation rows visible", async () => {
  const calls = [];
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({url: String(url), options});
    if (String(url).includes("/api/moon-v3/admin") || String(url).includes("/api/moon-v3/user")) {
      return new Response(JSON.stringify({error: "Unauthorized"}), {
        status: 401,
        headers: {"Content-Type": "application/json"}
      });
    }
    return new Response(JSON.stringify({status: "ok"}), {
      status: 200,
      headers: {"Content-Type": "application/json"}
    });
  };

  try {
    const payload = await buildSystemStatusPayload({
      config: {
        ravenBaseUrl: "http://raven.test",
        wardenBaseUrl: "http://warden.test",
        portalBaseUrl: "http://portal.test",
        oracleBaseUrl: "http://oracle.test",
        vaultBaseUrl: "http://vault.test",
        publicBaseUrl: "http://moon.test",
        port: 4400,
        serviceToken: "sage-dev-token",
        serviceTokens: {
          "scriptarr-sage": "sage-dev-token",
          "scriptarr-portal": "portal-dev-token"
        }
      },
      serviceJson: async (baseUrl, path, options = {}) => {
        calls.push({url: `${baseUrl}${path}`, path, timeoutMs: options.timeoutMs, headers: options.headers || {}});
        if (baseUrl === "http://vault.test" && path === "/api/service/events") {
          return {ok: true, status: 200, payload: [{id: "event-1"}, {id: "event-2"}]};
        }
        if (baseUrl === "http://oracle.test" && path === "/health") {
          return {ok: true, status: 200, payload: {status: {localAi: {}, services: {}}}};
        }
        return {ok: true, status: 200, payload: {status: "ok"}};
      },
      includeChecks: true
    });

    const endpoints = payload.groups.flatMap((group) => group.endpoints);
    const nonGetCount = endpoints.filter((endpoint) => endpoint.method !== "GET").length;
    const protectedEndpoint = endpoints.find((endpoint) => endpoint.path === "/api/moon-v3/admin/system/status");
    const oracleHealth = endpoints.find((endpoint) => endpoint.service === "oracle" && endpoint.path === "/health");
    const vaultEvents = endpoints.find((endpoint) => endpoint.path === "/api/service/events");
    const portalNotificationCall = calls.find((call) => call.path === "/api/internal/portal/notifications/system");
    const vaultEventsCall = calls.find((call) => call.path === "/api/service/events");

    assert.equal(payload.groups.length, 8);
    assert.ok(calls.some((call) => call.url.includes("/v1/downloads/tasks")));
    assert.equal(calls.some((call) => call.url.includes("/api/updates/check")), false);
    assert.equal(calls.every((call) => call.timeoutMs > 0), true);
    assert.equal(payload.summary.notProbed, nonGetCount);
    assert.equal(payload.summary.protected > 0, true);
    assert.equal(protectedEndpoint?.probeStatus, "protected");
    assert.equal(oracleHealth?.payloadSummary, "localAi, services");
    assert.equal(vaultEvents?.payloadSummary, "2 items");
    assert.equal(portalNotificationCall?.url, "http://127.0.0.1:4400/api/internal/portal/notifications/system");
    assert.equal(portalNotificationCall?.headers.Authorization, "Bearer portal-dev-token");
    assert.equal(vaultEventsCall?.headers.Authorization, "Bearer sage-dev-token");
    assert.ok(fetchCalls.some((call) => call.url === "http://moon.test/health"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("system status payload can return a lightweight registry without live probes", async () => {
  const payload = await buildSystemStatusPayload({
    config: {
      ravenBaseUrl: "http://raven.test",
      wardenBaseUrl: "http://warden.test",
      portalBaseUrl: "http://portal.test",
      oracleBaseUrl: "http://oracle.test",
      vaultBaseUrl: "http://vault.test",
      publicBaseUrl: "http://moon.test",
      port: 4400,
      serviceToken: "sage-dev-token",
      serviceTokens: {"scriptarr-sage": "sage-dev-token"}
    },
    serviceJson: async () => {
      throw new Error("serviceJson should not be called for lightweight status");
    },
    includeChecks: false
  });
  const endpoints = payload.groups.flatMap((group) => group.endpoints);

  assert.equal(payload.summary.checked, 0);
  assert.equal(endpoints.filter((endpoint) => endpoint.safeToProbe).every((endpoint) => endpoint.probeStatus === "pending"), true);
  assert.equal(endpoints.filter((endpoint) => !endpoint.safeToProbe).every((endpoint) => endpoint.probeStatus === "not_probed"), true);
});
