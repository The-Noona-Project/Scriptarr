import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.NODE_ENV = "test";
process.env.SCRIPTARR_SERVICE_TOKEN = "oracle-dev-token";

const {createOracleApp} = await import("../lib/createOracleApp.mjs");

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

const createFakeSageServer = async ({
  bootstrap = {
    callbackUrl: "https://scriptarr.test/api/moon/auth/discord/callback",
    localAi: {enabled: false},
    services: {vault: {ok: true}, sage: {ok: true}}
  },
  settings = {
    enabled: false,
    provider: "openai",
    model: "gpt-4.1-mini",
    temperature: 0.2
  },
  secret = ""
} = {}) => {
  const requests = [];
  const app = express();
  app.use(express.json());

  app.get("/api/internal/vault/settings/:key", (req, res) => {
    requests.push({path: req.path, authorization: req.headers.authorization});
    assert.equal(req.headers.authorization, "Bearer oracle-dev-token");
    assert.equal(req.params.key, "oracle.settings");
    res.json({key: req.params.key, value: settings});
  });

  app.get("/api/internal/vault/secrets/:key", (req, res) => {
    requests.push({path: req.path, authorization: req.headers.authorization});
    assert.equal(req.headers.authorization, "Bearer oracle-dev-token");
    assert.equal(req.params.key, "oracle.openai.apiKey");
    res.json({key: req.params.key, value: secret});
  });

  app.get("/api/internal/warden/bootstrap", (req, res) => {
    requests.push({path: req.path, authorization: req.headers.authorization});
    assert.equal(req.headers.authorization, "Bearer oracle-dev-token");
    res.json(bootstrap);
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => closeServer(server)
  };
};

test("oracle starts disabled and reports the off-state cleanly through Sage", {concurrency: false}, async () => {
  const sage = await createFakeSageServer();
  process.env.SCRIPTARR_SAGE_BASE_URL = sage.baseUrl;
  process.env.SCRIPTARR_VAULT_BASE_URL = "http://127.0.0.1:9";
  process.env.SCRIPTARR_WARDEN_BASE_URL = "http://127.0.0.1:9";
  const {app: oracleApp} = await createOracleApp();
  const oracleServer = await new Promise((resolve) => {
    const instance = oracleApp.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${oracleServer.address().port}`;

  const payload = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({message: "Tell me something about the library"})
  }).then((response) => response.json());

  assert.equal(payload.ok, true);
  assert.equal(payload.disabled, true);
  assert.ok(sage.requests.some((request) => request.path === "/api/internal/vault/settings/oracle.settings"));
  assert.ok(sage.requests.some((request) => request.path === "/api/internal/vault/secrets/oracle.openai.apiKey"));
  assert.ok(sage.requests.some((request) => request.path === "/api/internal/warden/bootstrap"));

  await closeServer(oracleServer);
  await sage.close();
});

test("oracle status reads Scriptarr bootstrap through Sage instead of direct first-party URLs", {concurrency: false}, async () => {
  const sage = await createFakeSageServer({
    bootstrap: {
      callbackUrl: "https://pax-kun.com/api/moon/auth/discord/callback",
      localAi: {enabled: true, hostPort: 11434},
      services: {
        vault: {ok: true},
        sage: {ok: true},
        warden: {ok: true}
      }
    }
  });
  process.env.SCRIPTARR_SAGE_BASE_URL = sage.baseUrl;
  process.env.SCRIPTARR_VAULT_BASE_URL = "http://127.0.0.1:9";
  process.env.SCRIPTARR_WARDEN_BASE_URL = "http://127.0.0.1:9";

  const {app: oracleApp} = await createOracleApp();
  const oracleServer = await new Promise((resolve) => {
    const instance = oracleApp.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${oracleServer.address().port}`;

  const payload = await fetch(`${baseUrl}/api/status`).then((response) => response.json());

  assert.equal(payload.ok, true);
  assert.equal(payload.callbackUrl, "https://pax-kun.com/api/moon/auth/discord/callback");
  assert.deepEqual(payload.localAi, {enabled: true, hostPort: 11434});
  assert.equal(payload.oracle.enabled, false);
  assert.ok(sage.requests.every((request) => request.authorization === "Bearer oracle-dev-token"));

  await closeServer(oracleServer);
  await sage.close();
});
