/**
 * @file Credential-scoping and response tests for Sage's internal requester.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {createServiceJson, serviceRequestHeaders} from "../lib/serviceRequest.mjs";

const config = {
  wardenBaseUrl: "http://warden:4001",
  portalBaseUrl: "http://192.168.50.7:3003",
  oracleBaseUrl: "http://192.168.50.7:3001",
  wardenServiceToken: "warden-private",
  portalServiceToken: "portal-private",
  oracleServiceToken: "oracle-private"
};

test("credentials are scoped to the configured destination, including its port", () => {
  assert.deepEqual(serviceRequestHeaders(config, config.wardenBaseUrl), {Authorization: "Bearer warden-private"});
  assert.deepEqual(serviceRequestHeaders(config, config.portalBaseUrl), {Authorization: "Bearer portal-private"});
  assert.deepEqual(serviceRequestHeaders(config, config.oracleBaseUrl), {Authorization: "Bearer oracle-private"});
  assert.deepEqual(serviceRequestHeaders(config, "http://192.168.50.7:9000"), {});
  assert.deepEqual(serviceRequestHeaders(config, "https://unrelated.test"), {});
});

test("requester authenticates a remote operation and preserves HTTP failure responses", async () => {
  const client = createServiceJson(config, async (url, options) => {
    assert.equal(url, "http://warden:4001/api/updates/install");
    assert.equal(options.headers.Authorization, "Bearer warden-private");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), {services: ["scriptarr-oracle"]});
    return new Response(JSON.stringify({error: "worker unavailable"}), {status: 503});
  });
  assert.deepEqual(await client(config.wardenBaseUrl, "/api/updates/install", {
    method: "POST", body: {services: ["scriptarr-oracle"]}
  }), {ok: false, status: 503, payload: {error: "worker unavailable"}});
});

test("independent app configurations cannot reuse another app's credentials", async () => {
  const client = createServiceJson({...config, wardenServiceToken: "other-private"}, async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer other-private");
    return new Response("not JSON", {status: 502});
  });
  assert.equal((await client(config.wardenBaseUrl, "/api/runtime")).payload.error, "Service request failed with HTTP 502.");
});
