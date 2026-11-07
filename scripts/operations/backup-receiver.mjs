/** @file Restricted SSH receiver; accepts encrypted objects and immutable snapshots only. */
import {createReadStream, createWriteStream} from "node:fs";
import {mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {pipeline} from "node:stream/promises";
import {Readable, Transform} from "node:stream";
import {pathToFileURL} from "node:url";
import {sha256File} from "./backup-crypto.mjs";
import {retainedSnapshots} from "./backup-retention.mjs";

const RUN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const OBJECT = /^[a-f0-9-]{36}\.aesgcm$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_BYTES = 256 * 1024 ** 3;

async function json(pathname) { return JSON.parse(await readFile(pathname, "utf8")); }

/** Validate a manifest without exposing original library paths or secrets. */
export function validateManifest(data, id) {
  if (!RUN.test(id) || data.version !== 1 || data.id !== id || !Number.isFinite(Date.parse(data.createdAt)) || new Date(data.createdAt).getTime() > Date.now() + 3600000) throw new Error("Invalid snapshot metadata.");
  if (!SHA.test(data.archive?.sha256) || !Number.isSafeInteger(data.archive?.bytes) || data.archive.bytes < 1 || data.archive.bytes > MAX_BYTES) throw new Error("Invalid archive metadata.");
  if (!Array.isArray(data.objects) || data.objects.length > 1000000) throw new Error("Invalid object manifest.");
  const seen = new Set();
  for (const object of data.objects) {
    if (!OBJECT.test(object.id) || seen.has(object.id) || !SHA.test(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes < 1 || object.bytes > MAX_BYTES) throw new Error("Invalid encrypted object reference.");
    seen.add(object.id);
  }
  return data;
}

/** Initialize only the receiver-owned namespace. */
export async function initializeStore(root) {
  if (!path.isAbsolute(root) || root === "/" || root.length < 12) throw new Error("A dedicated absolute store path is required.");
  for (const name of ["objects", "incoming", "snapshots", "status", "pins"]) await mkdir(path.join(root, name), {recursive: true, mode: 0o700});
}

async function writeAtomic(filename, value) {
  const temporary = `${filename}.partial-${process.pid}`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {flag: "wx", mode: 0o600}); await rename(temporary, filename); }
  catch (error) { await rm(temporary, {force: true}); throw error; }
}

async function receive(input, filename, maximum = MAX_BYTES) {
  const partial = `${filename}.partial-${process.pid}`;
  try {
    try { await stat(filename); throw new Error("Artifact already exists."); } catch (error) { if (error.code !== "ENOENT") throw error; }
    let count = 0;
    const bound = new Transform({transform(chunk, encoding, callback) { count += chunk.length; callback(count > maximum ? new Error("Upload exceeds configured limit.") : null, chunk); }});
    await pipeline(input, bound, createWriteStream(partial, {flags: "wx", mode: 0o600}));
    if (!count) throw new Error("Empty uploads are not accepted.");
    const checksum = await sha256File(partial);
    await rename(partial, filename);
    return {bytes: count, sha256: checksum};
  } catch (error) { await rm(partial, {force: true}); throw error; }
}

async function listSnapshots(root) {
  const snapshots = [];
  for (const id of await readdir(path.join(root, "snapshots"))) {
    if (!RUN.test(id)) throw new Error("Unexpected entry in snapshot namespace; refusing pruning.");
    snapshots.push(validateManifest(await json(path.join(root, "snapshots", id, "manifest.json")), id));
  }
  return snapshots;
}

/** Retain daily/weekly recovery points and garbage-collect only old unreferenced objects. */
export async function pruneStore(root, now = Date.now()) {
  const snapshots = await listSnapshots(root);
  const retained = retainedSnapshots(snapshots);
  for (const id of await readdir(path.join(root, "pins"))) {
    if (!RUN.test(id) || !snapshots.some(item => item.id === id)) throw new Error("Invalid pinned recovery point; refusing pruning.");
    retained.add(id);
  }
  const references = new Set(snapshots.filter(item => retained.has(item.id)).flatMap(item => item.objects.map(object => object.id)));
  for (const item of snapshots) if (!retained.has(item.id)) await rm(path.join(root, "snapshots", item.id), {recursive: true});
  for (const filename of await readdir(path.join(root, "objects"))) {
    if (!OBJECT.test(filename) || references.has(filename)) continue;
    const full = path.join(root, "objects", filename);
    if ((await stat(full)).mtimeMs > now - 86400000) continue;
    await rm(full);
    await rm(`${full}.json`, {force: true});
  }
  return {retainedSnapshots: retained.size};
}

async function commit(root, id) {
  const directory = path.join(root, "incoming", id);
  const manifest = validateManifest(await json(path.join(directory, "manifest.json")), id);
  const archivePath = path.join(directory, "snapshot.aesgcm");
  if ((await stat(archivePath)).size !== manifest.archive.bytes || await sha256File(archivePath) !== manifest.archive.sha256) throw new Error("Snapshot ciphertext checksum does not match.");
  for (const reference of manifest.objects) {
    const target = path.join(root, "objects", reference.id);
    const recorded = await json(`${target}.json`);
    if ((await stat(target)).size !== reference.bytes || recorded.bytes !== reference.bytes || recorded.sha256 !== reference.sha256) throw new Error("A required encrypted library object is missing or unverified.");
  }
  await rename(directory, path.join(root, "snapshots", id));
  const retention = await pruneStore(root);
  const status = {state: "complete", id, createdAt: manifest.createdAt, committedAt: new Date().toISOString(), ...retention};
  await writeAtomic(path.join(root, "status", "latest.json"), status);
  return status;
}

/** Verify retained ciphertext, including the incremental library objects. */
export async function verifyStore(root) {
  const snapshots = await listSnapshots(root);
  const objects = new Map();
  for (const item of snapshots) {
    if (await sha256File(path.join(root, "snapshots", item.id, "snapshot.aesgcm")) !== item.archive.sha256) throw new Error("Stored snapshot checksum failed.");
    for (const object of item.objects) objects.set(object.id, object);
  }
  for (const object of objects.values()) if (await sha256File(path.join(root, "objects", object.id)) !== object.sha256) throw new Error("Stored library object checksum failed.");
  const status = {state: "verified", checkedAt: new Date().toISOString(), snapshots: snapshots.length, objects: objects.size};
  await writeAtomic(path.join(root, "status", "verification.json"), status);
  return status;
}

/** Dispatch the exact forced-command grammar; no original command reaches a shell. */
export async function dispatch(root, command, input = process.stdin) {
  await initializeStore(root);
  const parts = command.trim().split(/\s+/);
  if (parts[0] !== "scriptarr-backup") throw new Error("Unsupported backup command.");
  const [, action, id, filename, ...extra] = parts;
  if (extra.length) throw new Error("Unexpected backup command arguments.");
  if (action === "status" && !id) return json(path.join(root, "status", "latest.json"));
  if (action === "verify" && !id) return verifyStore(root);
  if (action === "fetch" && RUN.test(id || "") && ["snapshot.aesgcm", "manifest.json"].includes(filename)) return createReadStream(path.join(root, "snapshots", id, filename));
  if (action === "fetch-object" && OBJECT.test(id || "") && !filename) return createReadStream(path.join(root, "objects", id));
  if (action === "object" && OBJECT.test(id || "") && !filename) {
    const target = path.join(root, "objects", id);
    const metadata = await receive(input, target);
    await writeAtomic(`${target}.json`, metadata);
    return {state: "stored", id, ...metadata};
  }
  if (action === "snapshot" && RUN.test(id || "") && ["snapshot.aesgcm", "manifest.json"].includes(filename)) {
    const directory = path.join(root, "incoming", id);
    await mkdir(directory, {recursive: true, mode: 0o700});
    return {state: "stored", id, filename, ...await receive(input, path.join(directory, filename), filename === "manifest.json" ? 128 * 1024 ** 2 : MAX_BYTES)};
  }
  if (action === "commit" && RUN.test(id || "") && !filename) return commit(root, id);
  throw new Error("Unsupported backup command or invalid identifier.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, ...arguments_] = process.argv.slice(2);
  const command = process.env.SSH_ORIGINAL_COMMAND || arguments_.join(" ");
  dispatch(root, command).then(result => result instanceof Readable ? pipeline(result, process.stdout) : console.log(JSON.stringify(result))).catch(() => {
    console.error("Backup receiver rejected the request or detected an integrity failure.");
    process.exitCode = 1;
  });
}
