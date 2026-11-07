/** @file Recovery, tamper-detection, restricted-receiver, and retention regression checks. */
import assert from "node:assert/strict";
import {generateKeyPairSync, randomBytes} from "node:crypto";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {createReadStream} from "node:fs";
import {mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {Readable} from "node:stream";
import test from "node:test";
import {decryptFile, encryptStream} from "./backup-crypto.mjs";
import {dispatch, initializeStore, pruneStore, validateManifest, verifyStore} from "./backup-receiver.mjs";
import {retainedSnapshots} from "./backup-retention.mjs";
import {validateSourceConfig} from "./backup-source.mjs";
import {probe} from "./monitor.mjs";

const keys = generateKeyPairSync("rsa", {modulusLength: 2048});

async function temporary(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scriptarr-recovery-test-"));
  try { await run(directory); } finally { await rm(directory, {recursive: true, force: true}); }
}

async function healthServer(responder, run) {
  const server = createServer(responder);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try { await run(`http://127.0.0.1:${server.address().port}/health`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("authenticated backup round-trip publishes exact bytes only after verification", () => temporary(async directory => {
  const original = randomBytes(2 * 1024 * 1024 + 37);
  const encrypted = path.join(directory, "backup.aesgcm");
  const restored = path.join(directory, "restore.tar.gz");
  await encryptStream(Readable.from([original]), encrypted, keys.publicKey);
  await decryptFile(encrypted, restored, keys.privateKey);
  assert.deepEqual(await readFile(restored), original);
  if (process.platform !== "win32") assert.equal((await stat(restored)).mode & 0o077, 0);
  await assert.rejects(decryptFile(encrypted, restored, keys.privateKey), /replace/);
}));

test("empty source files still authenticate and restore exactly", () => temporary(async directory => {
  const encrypted = path.join(directory, "empty.enc");
  await encryptStream(Readable.from([]), encrypted, keys.publicKey);
  await decryptFile(encrypted, path.join(directory, "empty"), keys.privateKey);
  assert.equal((await stat(path.join(directory, "empty"))).size, 0);
}));

test("small producer output remains buffered while encryption initializes", () => temporary(async directory => {
  const command = process.platform === "win32" ? [process.execPath, ["-e", "process.stdout.write('small archive payload')"]] : ["/usr/bin/printf", ["%s", "small archive payload"]];
  const child = spawn(command[0], command[1], {stdio: ["ignore", "pipe", "pipe"]});
  const complete = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("Producer failed"))); });
  child.stdout.pause();
  const encrypted = path.join(directory, "small.enc");
  const metadata = await encryptStream(child.stdout, encrypted, keys.publicKey);
  await complete;
  assert.equal(metadata.plaintextBytes, Buffer.byteLength("small archive payload"));
  await decryptFile(encrypted, path.join(directory, "small"), keys.privateKey);
  assert.equal(await readFile(path.join(directory, "small"), "utf8"), "small archive payload");
}));

test("ciphertext tampering and truncation never publish recovered plaintext", () => temporary(async directory => {
  const encrypted = path.join(directory, "backup.aesgcm");
  await encryptStream(Readable.from([randomBytes(32768)]), encrypted, keys.publicKey);
  const valid = await readFile(encrypted);
  for (const [label, modified] of [
    ["tampered", Buffer.from(valid)], ["truncated", valid.subarray(0, valid.length - 3)]
  ]) {
    if (label === "tampered") modified[modified.length - 20] ^= 1;
    const target = path.join(directory, label);
    await writeFile(`${target}.enc`, modified);
    await assert.rejects(decryptFile(`${target}.enc`, target, keys.privateKey));
    assert.equal((await readdir(directory)).some(name => name === label || name.startsWith(`${label}.recovering`)), false);
  }
}));

test("aborted capture removes partial ciphertext", () => temporary(async directory => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(encryptStream(Readable.from([randomBytes(1024)]), path.join(directory, "cancelled"), keys.publicKey, {signal: controller.signal}));
  assert.deepEqual(await readdir(directory), []);
}));

test("retention keeps seven latest distinct daily points and four weekly points", () => {
  const entries = [];
  for (let day = 0; day < 50; day++) {
    const date = new Date(Date.UTC(2026, 10, 7 - day, 3));
    entries.push({id: `d${day}`, createdAt: date.toISOString()});
    entries.push({id: `older-${day}`, createdAt: new Date(date.getTime() - 3600000).toISOString()});
  }
  const retained = retainedSnapshots(entries);
  for (let day = 0; day < 7; day++) assert.ok(retained.has(`d${day}`));
  assert.ok(retained.size <= 11);
  assert.ok(retained.size >= 9);
  assert.equal([...retained].some(id => id.startsWith("older")), false);
  assert.equal(retained.has("d49"), false);
});

test("forced command rejects shell syntax, traversal, invalid uploads, and missing objects", () => temporary(async directory => {
  for (const command of ["sh -c id", "scriptarr-backup snapshot ../../escape manifest.json", "scriptarr-backup status ; id", "scriptarr-backup object ../../../bad"]) {
    await assert.rejects(dispatch(directory, command, Readable.from(["x"])));
  }
  assert.throws(() => validateManifest({version: 1, id: "bad"}, "bad"));
  const id = "20261107T030000Z-1234abcd";
  const archive = randomBytes(4096);
  const stored = await dispatch(directory, `scriptarr-backup snapshot ${id} snapshot.aesgcm`, Readable.from([archive]));
  const manifest = {version: 1, id, createdAt: "2026-11-07T03:00:00.000Z", archive: {sha256: stored.sha256, bytes: stored.bytes}, objects: [{id: "12345678-1234-1234-1234-123456789abc.aesgcm", sha256: "a".repeat(64), bytes: 500}]};
  await dispatch(directory, `scriptarr-backup snapshot ${id} manifest.json`, Readable.from([JSON.stringify(manifest)]));
  await assert.rejects(dispatch(directory, `scriptarr-backup commit ${id}`));
}));

test("receiver commits and verifies immutable ciphertext with source-independent hashes", () => temporary(async directory => {
  const id = "20261107T030000Z-1234abce";
  const object = "12345678-1234-1234-1234-123456789abc.aesgcm";
  const objectMetadata = await dispatch(directory, `scriptarr-backup object ${object}`, Readable.from([randomBytes(900)]));
  const archive = await dispatch(directory, `scriptarr-backup snapshot ${id} snapshot.aesgcm`, Readable.from([randomBytes(4096)]));
  const manifest = {version: 1, id, createdAt: "2026-11-07T03:00:00.000Z", archive, objects: [{id: object, bytes: objectMetadata.bytes, sha256: objectMetadata.sha256}]};
  await dispatch(directory, `scriptarr-backup snapshot ${id} manifest.json`, Readable.from([JSON.stringify(manifest)]));
  assert.equal((await dispatch(directory, `scriptarr-backup commit ${id}`)).state, "complete");
  assert.equal((await verifyStore(directory)).objects, 1);
  await writeFile(path.join(directory, "objects", object), "corrupt");
  await assert.rejects(verifyStore(directory), /checksum/);
}));

test("library garbage collection preserves retained references and in-progress uploads", () => temporary(async directory => {
  await initializeStore(directory);
  const retained = "12345678-1234-1234-1234-123456789abc.aesgcm";
  const oldOrphan = "12345678-1234-1234-1234-123456789abd.aesgcm";
  const newOrphan = "12345678-1234-1234-1234-123456789abe.aesgcm";
  const oldDate = new Date(Date.now() - 2 * 86400000);
  for (const name of [retained, oldOrphan, newOrphan]) await writeFile(path.join(directory, "objects", name), "opaque ciphertext");
  for (const name of [retained, oldOrphan]) await utimes(path.join(directory, "objects", name), oldDate, oldDate);
  const id = "20261107T030000Z-1234abcf";
  await mkdir(path.join(directory, "snapshots", id));
  const manifest = {version: 1, id, createdAt: "2026-11-07T03:00:00.000Z", archive: {bytes: 100, sha256: "a".repeat(64)}, objects: [{id: retained, bytes: 100, sha256: "b".repeat(64)}]};
  await writeFile(path.join(directory, "snapshots", id, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "sentinel-outside-object-namespace"), "keep");
  await pruneStore(directory);
  const remaining = await readdir(path.join(directory, "objects"));
  assert.ok(remaining.includes(retained));
  assert.ok(remaining.includes(newOrphan));
  assert.equal(remaining.includes(oldOrphan), false);
  assert.equal(await readFile(path.join(directory, "sentinel-outside-object-namespace"), "utf8"), "keep");
}));

test("operator-pinned migration baseline survives ordinary retention", () => temporary(async directory => {
  await initializeStore(directory);
  const ids = [];
  for (let day = 0; day < 45; day++) {
    const createdAt = new Date(Date.UTC(2026, 10, 7 - day, 3)).toISOString();
    const id = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + "-1234abcd";
    ids.push(id);
    await mkdir(path.join(directory, "snapshots", id));
    await writeFile(path.join(directory, "snapshots", id, "manifest.json"), JSON.stringify({version: 1, id, createdAt, archive: {bytes: 100, sha256: "a".repeat(64)}, objects: []}));
  }
  const baseline = ids.at(-1);
  await writeFile(path.join(directory, "pins", baseline), "verified migration baseline\n");
  await pruneStore(directory);
  assert.ok((await readdir(path.join(directory, "snapshots"))).includes(baseline));
  assert.ok((await readdir(path.join(directory, "snapshots"))).length <= 12);
}));

test("sender rejects staging inside live data and remote command injection", () => {
  const base = {dataRoot: "/srv/scriptarr", workRoot: "/srv/scriptarr-backups", libraryRoot: "/srv/scriptarr/raven/downloads/downloaded", publicKeyFile: "/root/public.pem", remote: {user: "scriptarr-backup", host: "192.168.50.14", identityFile: "/root/id", knownHostsFile: "/root/pins"}};
  assert.equal(validateSourceConfig(base), base);
  assert.throws(() => validateSourceConfig({...base, workRoot: "/srv/scriptarr/backups"}));
  assert.throws(() => validateSourceConfig({...base, remote: {...base.remote, user: "x;id"}}));
});

test("HTTP 200 with unavailable AI is failed and response secrets are never logged", () => healthServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ok: true, enabled: true, provider: "localai", embeddedLocalAi: {ready: false}, privateDetail: "never-log-this-value"}));
}, async url => {
  const result = await probe({name: "oracle", url, expectedFields: {ok: true, enabled: true, provider: "localai", "embeddedLocalAi.ready": true}});
  assert.equal(result.status, 200);
  assert.equal(result.state, "failed");
  assert.deepEqual(result.failedFields, ["embeddedLocalAi.ready"]);
  assert.equal(JSON.stringify(result).includes("never-log-this-value"), false);
}));

test("bounded semantic probe accepts expected nested fields", () => healthServer((request, response) => {
  response.end(JSON.stringify({ok: true, connected: true}));
}, async url => {
  assert.equal((await probe({name: "portal", url, expectedFields: {ok: true, connected: true}})).state, "healthy");
}));

test("oversized health body fails rather than buffering indefinitely", () => healthServer((request, response) => {
  response.end(JSON.stringify({ok: true, padding: "x".repeat(131072)}));
}, async url => {
  const result = await probe({name: "large", url, expectedFields: {ok: true}});
  assert.equal(result.state, "failed");
  assert.equal(result.error, "health_body_too_large");
}));

test("stalled JSON body is bounded by the total probe deadline", () => healthServer((request, response) => {
  response.writeHead(200, {"Content-Type": "application/json"});
  response.write('{"ok":');
}, async url => {
  const start = Date.now();
  const result = await probe({name: "stalled", url, expectedFields: {ok: true}}, {timeoutMs: 80});
  assert.equal(result.state, "failed");
  assert.ok(Date.now() - start < 2000);
}));
