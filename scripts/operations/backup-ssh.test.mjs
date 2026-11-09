/** @file Verify channel reuse cannot change receiver credentials or cross backup runs. */
import assert from "node:assert/strict";
import {readFile, rm, rmdir, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {createBackupSshSession, receiverSshArgs} from "./backup-ssh.mjs";

const remote = {host: "192.0.2.10", port: 2222, user: "backup", identityFile: "/private/sender", knownHostsFile: "/private/pins"};
const control = args => args.find(arg => arg.startsWith("ControlPath=")).slice("ControlPath=".length);

test("object and commit channels reuse one private master while retaining pinned receiver authentication", async () => {
  const session = await createBackupSshSession(remote);
  const first = session.args("scriptarr-backup object one"), next = session.args("scriptarr-backup commit run");
  const socket = control(first), directory = path.dirname(socket);
  assert.equal(control(next), socket);
  assert.ok(socket.length < 100);
  assert.ok(first.includes("StrictHostKeyChecking=yes"));
  assert.ok(first.includes("UserKnownHostsFile=/private/pins"));
  assert.ok(first.includes("IdentitiesOnly=yes"));
  assert.deepEqual(first.slice(0, 6), ["-F", "/dev/null", "-T", "-p", "2222", "-o"]);
  assert.ok(first.includes("ControlMaster=auto"));
  assert.ok(first.includes("ControlPersist=60"));
  assert.equal(first.at(-2), "backup@192.0.2.10");
  if (process.platform !== "win32") assert.equal((await stat(directory)).mode & 0o777, 0o700);
  await session.close(() => { throw Error("No master was created."); });
  await assert.rejects(stat(directory), {code: "ENOENT"});
});

test("concurrent runs receive distinct sockets and cleanup preserves unexpected files", async () => {
  const [a, b] = await Promise.all([createBackupSshSession(remote), createBackupSshSession(remote)]);
  const socketA = control(a.args("scriptarr-backup status")), socketB = control(b.args("scriptarr-backup status"));
  assert.notEqual(socketA, socketB);
  const directory = path.dirname(socketA), sentinel = path.join(directory, "preserve-evidence");
  await writeFile(sentinel, "retained");
  await a.close(() => { throw Error("No master exists."); });
  assert.equal(await readFile(sentinel, "utf8"), "retained");
  await rm(sentinel); await rmdir(directory);
  await b.close(() => { throw Error("No master exists."); });
});

test("explicit close targets only the run socket and never sends an arbitrary receiver command", () => {
  const args = receiverSshArgs(remote, null, "/private/session/master");
  assert.equal(args.at(-1), "backup@192.0.2.10");
  assert.deepEqual(args.slice(-3), ["-O", "exit", "backup@192.0.2.10"]);
  assert.ok(args.includes("ControlPath=/private/session/master"));
});
