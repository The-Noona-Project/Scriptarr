/** @file Encrypted MySQL/config snapshots and incremental canonical-CBZ backup sender. */
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {createReadStream, createWriteStream} from "node:fs";
import {mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {pipeline} from "node:stream/promises";
import {pathToFileURL} from "node:url";
import {encryptStream} from "./backup-crypto.mjs";
import {createBackupSshSession} from "./backup-ssh.mjs";

async function exists(filename) { try { await stat(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function writeJson(filename, data) { const temporary = `${filename}.partial-${process.pid}`; await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", {mode: 0o600}); await rename(temporary, filename); }

function child(executable, args, {timeout = 120000, input, output, streamOutput = false, signal} = {}) {
  const subprocess = spawn(executable, args, {stdio: [input ? "pipe" : "ignore", "pipe", "pipe"]});
  let stdout = "";
  let forced;
  const kill = () => { subprocess.kill("SIGTERM"); forced = setTimeout(() => subprocess.kill("SIGKILL"), 5000); };
  const timer = setTimeout(kill, timeout);
  signal?.addEventListener("abort", kill, {once: true});
  if (signal?.aborted) kill();
  subprocess.once("exit", () => clearTimeout(forced));
  subprocess.stderr.resume();
  if (streamOutput) subprocess.stdout.pause();
  else if (!output) subprocess.stdout.on("data", chunk => { if (stdout.length < 1048576) stdout += chunk; });
  const io = output ? pipeline(subprocess.stdout, createWriteStream(output, {flags: "wx", mode: 0o600})) : Promise.resolve();
  io.catch(kill);
  if (input) pipeline(input, subprocess.stdin).catch(kill);
  const done = new Promise((resolve, reject) => {
    subprocess.on("error", reject);
    subprocess.on("close", (code, stoppedBy) => { clearTimeout(timer); signal?.removeEventListener("abort", kill); if (code === 0 && !stoppedBy && !signal?.aborted) resolve(stdout); else reject(Object.assign(new Error("A backup subprocess failed, was cancelled, or timed out."), {program: executable, exitCode: code, stoppedBy})); });
  });
  const complete = Promise.all([done, io]).then(([value]) => value);
  // Streaming callers await this after draining stdout, so register a rejection handler immediately.
  complete.catch(() => {});
  return {subprocess, done: complete, kill};
}

async function receiver(session, command, input, signal) {
  const result = await child("ssh", session.args(command), {input, signal, timeout: 2 * 3600000}).done;
  return JSON.parse(result);
}

async function filesUnder(root, relative = "") {
  const files = [];
  if (!await exists(root)) return files;
  for (const item of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const next = path.join(relative, item.name);
    if (item.isDirectory()) files.push(...await filesUnder(root, next));
    else if (item.isFile() && /\.cbz$/i.test(item.name)) files.push(next);
  }
  return files.sort();
}

function fingerprint(info) { return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }

/** Validate local ownership/path boundaries before any backup writes or remote calls. */
export function validateSourceConfig(config) {
  for (const key of ["dataRoot", "workRoot", "publicKeyFile", "libraryRoot"]) if (!path.posix.isAbsolute(config[key] || "") || config[key] === "/" || path.posix.resolve(config[key]) !== config[key]) throw new Error(`Invalid ${key}.`);
  if (config.workRoot === config.dataRoot || config.workRoot.startsWith(config.dataRoot + "/")) throw new Error("Backup workspace must be outside the live data root.");
  if (!/^[A-Za-z0-9_.-]+$/.test(config.mysqlContainer || "scriptarr-mysql")) throw new Error("Invalid MySQL container name.");
  if (!["mysql", "none"].includes(config.databaseMode || "mysql")) throw new Error("Invalid database backup mode.");
  if (!config.remote || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(config.remote.user || "") || !/^[A-Za-z0-9.:-]+$/.test(config.remote.host || "")) throw new Error("Invalid backup receiver.");
  for (const key of ["identityFile", "knownHostsFile"]) if (!path.posix.isAbsolute(config.remote[key] || "")) throw new Error("SSH identity and host pins must use absolute paths.");
  return config;
}

/** Remove private staging before best-effort failure reporting; retain the original cause. */
export async function cleanupFailedBackup(directory, statusFile, status, originalError) {
  let cleanupError;
  try { await rm(directory, {recursive: true, force: true}); } catch (error) { cleanupError = error; }
  try { await writeJson(statusFile, status); } catch { /* Disk exhaustion must not hide the backup failure. */ }
  const failure = new Error(`Backup failed during ${status.phase}.`, {cause: originalError});
  if (cleanupError) failure.cleanupError = cleanupError;
  throw failure;
}

/** Run one immutable backup; the caller should hold an OS flock across this operation. */
export async function runBackup(config, {signal} = {}) {
  validateSourceConfig(config);
  signal?.throwIfAborted();
  const invoke = (executable, args, options = {}) => child(executable, args, {...options, signal});
  const createdAt = new Date().toISOString();
  const id = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + "-" + randomUUID().slice(0, 8);
  const directory = path.join(config.workRoot, id);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const publicKey = await readFile(config.publicKeyFile);
  let phase = "inventory";
  let session;
  try {
    session = await createBackupSshSession(config.remote);
    let prior = {};
    const indexFile = path.join(config.workRoot, "last-library-index.json");
    if (await exists(indexFile)) prior = JSON.parse(await readFile(indexFile, "utf8"));
    const current = {};
    const uniqueObjects = new Map();
    for (const relative of await filesUnder(config.libraryRoot)) {
      signal?.throwIfAborted();
      const filename = path.join(config.libraryRoot, relative);
      const before = await stat(filename);
      let object;
      if (prior[relative]?.fingerprint === fingerprint(before)) object = prior[relative].object;
      else {
        phase = "library-encryption";
        const objectId = `${randomUUID()}.aesgcm`;
        const encrypted = path.join(directory, objectId);
        object = {id: objectId, ...await encryptStream(createReadStream(filename), encrypted, publicKey, {signal})};
        if (fingerprint(await stat(filename)) !== fingerprint(before)) throw new Error("A canonical library file changed during capture.");
        phase = "library-upload";
        const stored = await receiver(session, `scriptarr-backup object ${objectId}`, createReadStream(encrypted), signal);
        if (stored.sha256 !== object.sha256 || stored.bytes !== object.bytes) throw new Error("Library upload verification failed.");
        await rm(encrypted);
      }
      current[relative] = {fingerprint: fingerprint(before), object};
      uniqueObjects.set(object.id, object);
    }
    await writeJson(path.join(directory, "library-index.json"), current);
    phase = "database";
    const mysql = config.mysqlContainer || "scriptarr-mysql";
    const state = config.databaseMode === "none" ? null : JSON.parse(await invoke("docker", ["inspect", "--format", "{{json .State}}", mysql]).done);
    let databaseKind;
    if (!state) databaseKind = "none";
    else if (state.Running) {
      databaseKind = "logical-mysqldump";
      const command = 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysqldump --all-databases --single-transaction --routines --events --triggers --hex-blob --set-gtid-purged=OFF --no-tablespaces -uroot';
      await invoke("docker", ["exec", mysql, "sh", "-c", command], {timeout: 3600000, output: path.join(directory, "database.sql")}).done;
    } else {
      if (!await exists(path.join(config.dataRoot, "mysql/data"))) throw new Error("Stopped MySQL has no preserved data directory.");
      databaseKind = "stopped-cold-datadir";
    }
    const listed = await invoke("docker", ["ps", "-a", "--format", "{{json .Names}}"]).done;
    const names = listed.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(name => name.startsWith("scriptarr-"));
    if (names.length) await invoke("docker", ["inspect", ...names], {output: path.join(directory, "containers.json")}).done;
    const mysqlImage = state ? JSON.parse(await invoke("docker", ["inspect", "--format", "{{json .Image}}", mysql]).done) : null;
    const mysqlRepoDigests = state ? JSON.parse(await invoke("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", mysqlImage]).done) || [] : [];
    await writeJson(path.join(directory, "recovery.json"), {version: 1, id, createdAt, databaseKind, mysqlImage, mysqlRepoDigests, libraryFiles: Object.keys(current).length});
    phase = "snapshot-encryption";
    const entries = [];
    if (databaseKind === "stopped-cold-datadir") entries.push("mysql/data");
    for (const relative of ["deploy", "secrets", "warden/runtime", "operations/config.json", "operations/backup-recovery-public.pem"]) if (await exists(path.join(config.dataRoot, relative))) entries.push(relative);
    const metadata = ["library-index.json", "containers.json", "recovery.json", ...(databaseKind === "logical-mysqldump" ? ["database.sql"] : [])].filter(name => name !== "containers.json" || names.length);
    const tar = invoke("tar", ["-I", "gzip -1", "-cf", "-", "-C", config.dataRoot, ...entries, "-C", directory, ...metadata], {timeout: 2 * 3600000, streamOutput: true});
    const encryptedPath = path.join(directory, "snapshot.aesgcm");
    let archive;
    try { archive = await encryptStream(tar.subprocess.stdout, encryptedPath, publicKey, {signal}); await tar.done; }
    catch (error) { tar.kill(); throw error; }
    if (archive.plaintextBytes === 0) throw new Error("Archive command produced an empty stream.");
    if (databaseKind === "stopped-cold-datadir") {
      const after = JSON.parse(await invoke("docker", ["inspect", "--format", "{{json .State.Running}}", mysql]).done);
      if (after) throw new Error("MySQL started during cold capture; refusing inconsistent snapshot.");
    }
    const manifest = {version: 1, id, createdAt, databaseKind, archive, objects: [...uniqueObjects.values()]};
    const manifestFile = path.join(directory, "manifest.json");
    await writeJson(manifestFile, manifest);
    phase = "snapshot-upload";
    const uploaded = await receiver(session, `scriptarr-backup snapshot ${id} snapshot.aesgcm`, createReadStream(encryptedPath), signal);
    if (uploaded.sha256 !== archive.sha256 || uploaded.bytes !== archive.bytes) throw new Error("Snapshot upload verification failed.");
    await receiver(session, `scriptarr-backup snapshot ${id} manifest.json`, createReadStream(manifestFile), signal);
    phase = "commit";
    signal?.throwIfAborted();
    const result = await receiver(session, `scriptarr-backup commit ${id}`, undefined, signal);
    await writeJson(indexFile, current);
    const status = {...result, databaseKind, libraryFiles: Object.keys(current).length, archiveBytes: archive.bytes};
    await writeJson(path.join(config.workRoot, "latest-status.json"), status);
    await rm(directory, {recursive: true});
    return status;
  } catch (error) {
    // Configuration and logical dumps are plaintext only inside this private staging directory.
    await cleanupFailedBackup(directory, path.join(config.workRoot, "latest-status.json"),
      {state: "failed", id, createdAt, failedAt: new Date().toISOString(), phase, program: error.program, exitCode: error.exitCode}, error);
  } finally {
    await session?.close(args => child("ssh", args, {timeout: 10000}).done);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  readFile(process.argv[2], "utf8").then(text => runBackup(JSON.parse(text), {signal: controller.signal})).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
