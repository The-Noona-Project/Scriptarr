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
  const mutation = registry.flatMap((group) => group.endpoints).find((endpoint) => endpoint.method === "POST");
  assert.equal(mutation.safeToProbe, false);
});

test("system status payload probes only safe reads and keeps mutation rows visible", async () => {
  const calls = [];
  const payload = await buildSystemStatusPayload({
    config: {
      ravenBaseUrl: "http://raven.test",
      wardenBaseUrl: "http://warden.test",
      portalBaseUrl: "http://portal.test",
      oracleBaseUrl: "http://oracle.test",
      vaultBaseUrl: "http://vault.test",
      publicBaseUrl: "http://moon.test",
      port: 4400
    },
    serviceJson: async (baseUrl, path, options = {}) => {
      calls.push({url: `${baseUrl}${path}`, timeoutMs: options.timeoutMs});
      return {ok: true, status: 200, payload: {status: "ok"}};
    },
    includeChecks: true
  });

  assert.equal(payload.groups.length, 8);
  assert.ok(calls.some((call) => call.url.includes("/v1/downloads/tasks")));
  assert.equal(calls.some((call) => call.url.includes("/api/updates/check")), false);
  assert.equal(calls.every((call) => call.timeoutMs > 0), true);
  assert.equal(payload.summary.notProbed > 0, true);
});
