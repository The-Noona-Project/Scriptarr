/** @file Canonical Warden replacement does not leave backup containers after success or rollback. */
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {replaceWarden, dockerRequest} from "./replace-warden.mjs";
import {EventEmitter} from "node:events";

for (const outcome of ["complete", "aborted", "close", "error"]) test(`Docker responses settle on ${outcome}`, {timeout: 1000}, async () => {
  const transport = (_options, received) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {const response = new EventEmitter();response.statusCode = 200;received(response);
      response.emit("data", Buffer.from('{"Id":"accepted"}'));
      if (outcome === "complete") {response.emit("end");response.emit("close");}
      else response.emit(outcome, ...(outcome === "error" ? [new Error("broken response")] : []));});
    request.destroy = error => request.emit("error", error); return request;
  };
  const operation = dockerRequest("POST", "/containers/create", {}, transport);
  if (outcome === "complete") assert.deepEqual(await operation, {Id: "accepted"}); else await assert.rejects(operation);
});

test("a missing rollback image prevents stopping the existing Warden", async () => {
  const calls = [], before = {Id: "a".repeat(64), Image: "sha256:" + "c".repeat(64), Name: "/scriptarr-warden"};
  await assert.rejects(replaceWarden({expectedId: before.Id, image: "registry/warden@sha256:" + "b".repeat(64), archiveRoot: tmpdir()}, async (method, route) => {
    calls.push({method, route}); if (route === "/containers/scriptarr-warden/json") return before;
    if (route.includes(encodeURIComponent(before.Image))) throw Object.assign(new Error("rollback image missing"), {status: 404});
    return {};
  }), /rollback image missing/);
  assert.ok(calls.every(call => call.method === "GET"));
});

for (const fail of [false, true]) test(`canonical replacement ${fail ? "rolls back" : "succeeds"} without renamed backups`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "warden-replace-")), calls = [];
  const before = {Id: "a".repeat(64), Image: "sha256:" + "c".repeat(64), Name: "/scriptarr-warden", Config: {Image: "registry/warden:latest", Env: ["PRESERVED=yes"]},
    HostConfig: {Binds: ["/existing/data:/existing/data"]}, NetworkSettings: {Networks: {internal: {Aliases: ["scriptarr-warden"]}}}};
  let current = before, creates = 0;
  try {
    const docker = async (method, route, body) => {
      calls.push({method, route, body});
      if (route.startsWith("/images/")) return {};
      if (method === "GET") { if (!current) throw Object.assign(new Error("absent"), {status: 404}); return current; }
      if (method === "DELETE") { current = null; return null; }
      if (route.startsWith("/containers/create")) { const Id = String(++creates).repeat(64); current = {...before, Id, Config: body}; return {Id}; }
      return null;
    };
    const operation = replaceWarden({expectedId: before.Id, image: "registry/warden@sha256:" + "b".repeat(64), archiveRoot: root}, docker,
      async () => { if (fail && creates === 1) throw new Error("injected unhealthy replacement"); });
    if (fail) { await assert.rejects(operation, /previous canonical Warden was restored/); assert.equal(current.Config.Image, before.Image); }
    else assert.equal((await operation).backupContainersCreated, 0);
    assert.ok(calls.filter(c => c.route.includes("create")).every(c => c.route === "/containers/create?name=scriptarr-warden"));
    assert.ok(calls.filter(c => c.method === "DELETE").every(c => !/[?&]v=/.test(c.route)));
    assert.deepEqual(current.Config.HostConfig.Binds, before.HostConfig.Binds);
  } finally { await rm(root, {recursive: true, force: true}); }
});
