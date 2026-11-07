/**
 * @file Exercise real mTLS handshakes, topology peer authorization and bearer-token enforcement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import https from "node:https";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createWardenClusterServer, createWardenControlAuthorization, isAuthorizedClusterPeer} from "../api/controlSecurity.mjs";
import {createClusterAgentClient} from "../core/clusterAgentClient.mjs";
import {registerRuntimeRoutes} from "../api/registerRuntimeRoutes.mjs";

test("unreachable update owners produce HTTP 503 rather than a false success", async () => {
  const app = express();
  const failure = {ok: false, error: "Agent unavailable", hosts: [{hostId: "ai", available: false}]};
  registerRuntimeRoutes(app, {checkUpdates: async () => failure, installUpdates: async () => failure});
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    for (const operation of ["check", "install"]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/updates/${operation}`, {method: "POST"});
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), failure);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("control API rejects missing and wrong tokens before an operation runs", async () => {
  const app = express();
  let operations = 0;
  app.use("/api", createWardenControlAuthorization({env: {SCRIPTARR_WARDEN_SERVICE_TOKEN: "test-only-warden-token"}}));
  app.post("/api/updates/install", (_req, res) => {operations += 1; res.json({ok: true});});
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/updates/install`;
  try {
    assert.equal((await fetch(url, {method: "POST"})).status, 401);
    assert.equal((await fetch(url, {method: "POST", headers: {Authorization: "Bearer wrong"}})).status, 401);
    assert.equal(operations, 0);
    assert.equal((await fetch(url, {method: "POST", headers: {Authorization: "Bearer test-only-warden-token"}})).status, 200);
    assert.equal(operations, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("certificate identity alone cannot bypass the host IP allowlist", () => {
  const topology = {primaryHostId: "core", hosts: [{id: "core", address: "192.168.50.6"}]};
  const socket = {authorized: true, remoteAddress: "::ffff:192.168.50.7", getPeerCertificate: () => ({subject: {CN: "core"}})};
  assert.equal(isAuthorizedClusterPeer(socket, topology), false);
  socket.remoteAddress = "::ffff:192.168.50.6";
  assert.equal(isAuthorizedClusterPeer(socket, topology), true);
  socket.authorized = false;
  assert.equal(isAuthorizedClusterPeer(socket, topology), false);
});

test("agent listener requires a trusted certificate for the configured primary host", async () => {
  const openssl = process.platform === "win32" && existsSync("C:/Program Files/Git/usr/bin/openssl.exe")
    ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl";
  const directory = mkdtempSync(path.join(tmpdir(), "scriptarr-warden-mtls-"));
  const file = (name) => path.join(directory, name);
  const run = (args) => execFileSync(openssl, args, {stdio: "ignore", windowsHide: true});
  let server;
  try {
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Scriptarr test CA", "-keyout", file("ca.key"), "-out", file("ca.pem"), "-addext", "basicConstraints=critical,CA:TRUE"]);
    for (const [name, address] of [["core", "127.0.0.1"], ["ai", "127.0.0.2"], ["intruder", "127.0.0.1"]]) {
      writeFileSync(file(`${name}.ext`), `subjectAltName=IP:${address}\nextendedKeyUsage=serverAuth,clientAuth\n`);
      run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${name}`, "-keyout", file(`${name}.key`), "-out", file(`${name}.csr`)]);
      run(["x509", "-req", "-in", file(`${name}.csr`), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial", "-days", "1", "-extfile", file(`${name}.ext`), "-out", file(`${name}.pem`)]);
    }
    const topology = {primaryHostId: "core", hosts: [
      {id: "core", address: "127.0.0.1", agentUrl: "https://127.0.0.1:4401", services: ["scriptarr-mysql", "scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven"]},
      {id: "ai", address: "127.0.0.2", agentUrl: "https://127.0.0.2:4401", services: ["scriptarr-portal", "scriptarr-oracle"]}
    ]};
    const environment = {SCRIPTARR_WARDEN_HOST_ID: "ai", SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(topology), SCRIPTARR_WARDEN_SERVICE_TOKEN: "test-control-token"};
    const material = (name) => ({ca: readFileSync(file("ca.pem")), cert: readFileSync(file(`${name}.pem`)), key: readFileSync(file(`${name}.key`))});
    const app = express();
    app.use("/api", createWardenControlAuthorization({env: environment}));
    app.get("/api/runtime", (_req, res) => res.json({hostId: "ai"}));
    server = createWardenClusterServer(app, {env: environment, tlsOptions: material("ai")});
    server.listen(0, "127.0.0.2");
    await new Promise((resolve) => server.once("listening", resolve));
    const host = {id: "ai", agentUrl: `https://127.0.0.2:${server.address().port}`};
    const client = createClusterAgentClient({env: environment, tlsOptions: material("core")});
    assert.deepEqual(await client.request(host, "/api/runtime"), {hostId: "ai"});
    const intruder = createClusterAgentClient({env: environment, tlsOptions: material("intruder")});
    await assert.rejects(() => intruder.request(host, "/api/runtime"), /HTTP 403/);
    const wrongIdentity = createClusterAgentClient({env: environment, tlsOptions: material("core")});
    await assert.rejects(() => wrongIdentity.request({...host, id: "other"}, "/api/runtime"), /configured host identity/);
    await assert.rejects(() => new Promise((resolve, reject) => {
      const request = https.get(`${host.agentUrl}/api/runtime`, {ca: material("core").ca}, (response) => {response.resume(); resolve(response.statusCode);});
      request.on("error", reject);
    }), /certificate|required|alert|socket hang up/i);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, {recursive: true, force: true});
  }
});
