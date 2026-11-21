/** @file Overnight scheduling, stale identity and fail-closed reconciliation checks. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, execFileSync} from "node:child_process";
import {decideCopy, parseProcess, runSchedule, sameProcess, validateSchedule, windowOpen} from "./scheduled-copy.mjs";

const owner = {pid: 10, start: "100", parentPid: 1, group: 10, argv: ["node", "/stage/precopy-worker.cjs"], state: "S"};
const config = {version: 1, bootId: "boot", copyStartedAt: "2026-11-20T18:33:50.215Z", timezone: "America/Los_Angeles", startHour: 0, endHour: 7,
  source: "/source/", destination: "/stage/data/", statusFile: "/stage/precopy-status.json", journalFile: "/stage/overnight-copy-status.json",
  sourceIdentity: {dev: 1, ino: 2}, destinationIdentity: {dev: 3, ino: 4}, owner,
  jobs: [11, 12, 13].map((pid, i) => ({pid, start: String(200 + i), parentPid: pid - 1, group: 10, argv: ["rsync", "-aHAX", "--numeric-ids", "/source/", "/stage/data/"], state: "S"}))};
const observe = (changes = {}) => ({bootId: "boot", owner, jobs: structuredClone(config.jobs), status: {phase: "copying", startedAt: config.copyStartedAt}, pathsUnchanged: true, prior: null, now: new Date("2026-11-21T08:00:00Z"), ...changes});

test("Pacific midnight is included, 7 AM excluded, and daytime excluded", () => {
  for (const [at, expected] of [["2026-11-21T07:59:59Z", false], ["2026-11-21T08:00:00Z", true], ["2026-11-21T14:59:59Z", true], ["2026-11-21T15:00:00Z", false], ["2026-11-22T02:00:00Z", false]]) assert.equal(windowOpen(new Date(at), config), expected, at);
});

test("Pacific window follows daylight saving, including repeated and missing hours", () => {
  for (const [at, expected] of [["2026-07-01T07:00:00Z", true], ["2026-07-01T14:00:00Z", false], ["2026-03-08T09:59:59Z", true], ["2026-03-08T10:00:00Z", true], ["2026-03-08T14:00:00Z", false], ["2026-11-01T08:30:00Z", true], ["2026-11-01T09:30:00Z", true], ["2026-11-01T15:00:00Z", false]]) assert.equal(windowOpen(new Date(at), config), expected, at);
});

test("daytime pauses the tree and repeated reconciliation sends no more signals", () => {
  const now = new Date("2026-11-21T15:00:00Z"), first = decideCopy(config, observe({now}));
  assert.equal(first.signal, "SIGSTOP"); assert.equal(first.targets.length, 3);
  const next = decideCopy(config, observe({now, jobs: config.jobs.map(p => ({...p, state: "T"}))}));
  assert.equal(next.phase, "paused"); assert.equal(next.targets.length, 0);
});

test("midnight resumes only stopped members; running members are idempotent", () => {
  assert.equal(decideCopy(config, observe()).targets.length, 0);
  const result = decideCopy(config, observe({jobs: config.jobs.map(p => ({...p, state: "T"}))}));
  assert.equal(result.signal, "SIGCONT"); assert.equal(result.targets.length, 3);
});

test("stale births, argv, parent and group never authorize resume", () => {
  for (const patch of [{start: "999"}, {argv: ["rsync", "/other/", "/other-destination/"]}, {parentPid: 999}, {group: 999}, {state: "Z"}]) {
    const jobs = config.jobs.map(p => ({...p, state: "T"})); jobs[1] = {...jobs[1], ...patch};
    const result = decideCopy(config, observe({jobs}));
    assert.equal(result.phase, "blocked"); assert.equal(result.signal, "SIGSTOP");
    assert.ok(!result.targets.some(p => p.pid === jobs[1].pid));
  }
});

test("reboots never signal old numeric PIDs or start a replacement", () => {
  const result = decideCopy(config, observe({bootId: "new-boot"}));
  assert.equal(result.phase, "blocked"); assert.equal(result.signal, null); assert.deepEqual(result.targets, []);
});

test("missing owner, child, changed paths, bad status and latched faults block overnight resume", () => {
  for (const patch of [{owner: null}, {jobs: [null, config.jobs[1], config.jobs[2]]}, {pathsUnchanged: false}, {status: null}, {status: {phase: "copying", startedAt: "other-copy"}}, {status: {phase: "failed", startedAt: config.copyStartedAt}}, {prior: {phase: "blocked", reason: "action-failed"}}]) {
    const result = decideCopy(config, observe(patch)); assert.equal(result.phase, "blocked"); assert.notEqual(result.signal, "SIGCONT");
  }
});

test("online exit 24 permits only pre-copy completion, not cutover or download resume", () => {
  for (const exitCode of [0, 24]) {
    const result = decideCopy(config, observe({owner: null, jobs: [null, null, null], status: {phase: "precopy-complete", exitCode, startedAt: config.copyStartedAt}}));
    assert.deepEqual(result, {phase: "complete", reason: "precopy-finished", signal: null, targets: []});
  }
  assert.equal(decideCopy(config, observe({status: {phase: "precopy-complete", exitCode: 0, startedAt: config.copyStartedAt}})).phase, "blocked");
});

test("invalid manifests reject duplicates, foreign commands and ancestry cycles", () => {
  for (const mutate of [c => c.startHour = c.endHour, c => c.timezone = "Invalid/Timezone", c => c.jobs.push(c.jobs[0]), c => c.jobs[0].argv[0] = "node", c => c.jobs[0].parentPid = 13, c => c.jobs[1].group = 77, c => c.sourceIdentity = null]) {
    const broken = structuredClone(config); mutate(broken); assert.throws(() => validateSchedule(broken));
  }
});

test("proc parser handles spaces in command and keeps the process birth field", () => {
  const tail = Array(25).fill("0"); tail[0] = "T"; tail[1] = "10"; tail[2] = "10"; tail[19] = "12345";
  const parsed = parseProcess(11, `11 (a command (rsync)) ${tail.join(" ")}`, ["rsync"]);
  assert.equal(parsed.start, "12345"); assert.equal(parsed.parentPid, 10); assert.equal(parsed.state, "T");
  assert.equal(sameProcess(parsed, {...parsed, start: "different"}), false);
});

test("Linux fixture really pauses and resumes rsync without affecting a foreign process", {skip: process.platform !== "linux", timeout: 30000}, async t => {
  try { execFileSync("rsync", ["--version"], {stdio: "ignore", timeout: 3000}); } catch { t.skip("rsync unavailable"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scriptarr-copy-schedule-test-"));
  const source = directory + "/source/", destination = directory + "/destination/";
  fs.mkdirSync(source); fs.mkdirSync(destination); fs.writeFileSync(source + "payload", Buffer.alloc(4 * 1024 * 1024, 57));
  const statusFile = directory + "/status.json", worker = directory + "/worker.cjs", startedAt = new Date().toISOString();
  fs.writeFileSync(worker, `const fs=require('fs'),{spawn}=require('child_process');fs.writeFileSync(${JSON.stringify(statusFile)},JSON.stringify({phase:'copying',startedAt:${JSON.stringify(startedAt)}}));const c=spawn('rsync',['-aHAX','--numeric-ids','--bwlimit=256',${JSON.stringify(source)},${JSON.stringify(destination)}],{stdio:'ignore'});c.on('exit',code=>{fs.writeFileSync(${JSON.stringify(statusFile)},JSON.stringify({phase:code===0?'precopy-complete':'failed',exitCode:code,startedAt:${JSON.stringify(startedAt)}}))});`);
  const child = spawn(process.execPath, [worker], {stdio: "ignore"});
  const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio: "ignore"});
  const proc = pid => { try { return parseProcess(pid, fs.readFileSync(`/proc/${pid}/stat`, "utf8"), fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)); } catch { return null; } };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await wait(25); } throw new Error("Fixture condition timed out"); };
  let jobs = [];
  try {
    await until(() => {
      jobs = fs.readdirSync("/proc").filter(p => /^\d+$/.test(p)).map(p => proc(+p)).filter(p => p?.argv[0] === "rsync" && p.argv.at(-2) === source && p.argv.at(-1) === destination);
      return jobs.length >= 2 && fs.existsSync(statusFile);
    });
    const identity = p => { const s = fs.statSync(p); return {dev: s.dev, ino: s.ino}; };
    const fixture = {...config, source, destination, owner: proc(child.pid), jobs, statusFile, journalFile: directory + "/journal.json", copyStartedAt: startedAt,
      bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), sourceIdentity: identity(source), destinationIdentity: identity(destination)};
    const day = () => new Date("2026-11-21T18:00:00Z"), night = () => new Date("2026-11-21T08:00:00Z");
    const foreignBefore = proc(foreign.pid);
    runSchedule(fixture, {clock: day}); await until(() => jobs.every(p => proc(p.pid)?.state === "T"));
    assert.equal(runSchedule(fixture, {clock: day}).targets.length, 0);
    runSchedule(fixture, {clock: night}); await until(() => jobs.every(p => proc(p.pid)?.state !== "T"));
    const broken = structuredClone(fixture); broken.jobs[0].start = "0"; broken.journalFile = directory + "/fault.json";
    assert.equal(runSchedule(broken, {clock: night}).phase, "blocked");
    assert.notEqual(proc(jobs[0].pid)?.state, "T");
    assert.equal(runSchedule(broken, {clock: night}).signal, "SIGSTOP");
    assert.ok(sameProcess(foreignBefore, proc(foreign.pid))); assert.notEqual(proc(foreign.pid).state, "T");
    runSchedule(fixture, {clock: day}); await until(() => jobs.every(p => proc(p.pid)?.state === "T"));
  } finally {
    for (const p of jobs) if (sameProcess(p, proc(p.pid))) { process.kill(p.pid, "SIGCONT"); process.kill(p.pid, "SIGTERM"); }
    child.kill("SIGTERM"); foreign.kill("SIGTERM");
    await Promise.all([child, foreign].map(c => c.exitCode != null || c.signalCode != null ? undefined : new Promise(resolve => c.once("exit", resolve))));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
