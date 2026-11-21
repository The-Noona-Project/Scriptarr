/** @file Reconcile one reviewed Linux rsync process tree against an overnight window. */
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";

/** Return whether a date falls inside the explicit local-time window. */
export function windowOpen(date, {timezone, startHour, endHour}) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", {timeZone: timezone, hour: "2-digit", hourCycle: "h23"}).format(date));
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

/** Match a process birth, command and ancestry, independently of its current signal state. */
export function sameProcess(expected, actual) {
  return actual != null && expected.pid === actual.pid && expected.start === actual.start
    && expected.parentPid === actual.parentPid && expected.group === actual.group
    && JSON.stringify(expected.argv) === JSON.stringify(actual.argv) && !["Z", "X"].includes(actual.state);
}

/** Reject malformed or ambiguous manifests before any signals are possible. */
export function validateSchedule(config) {
  if (config.version !== 1 || !config.bootId || !config.copyStartedAt) throw new Error("Invalid copy identity.");
  if (![config.source, config.destination, config.statusFile, config.journalFile].every(p => typeof p === "string" && path.isAbsolute(p))) throw new Error("Absolute reviewed paths are required.");
  if (path.resolve(config.source) === path.resolve(config.destination)) throw new Error("Copy paths must differ.");
  for (const hour of [config.startHour, config.endHour]) if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("Invalid copy hours.");
  if (config.startHour === config.endHour) throw new Error("A bounded daily window is required.");
  if (typeof config.timezone !== "string" || !config.timezone) throw new Error("An explicit timezone is required.");
  windowOpen(new Date(), config);
  if (!Array.isArray(config.jobs) || config.jobs.length === 0) throw new Error("A reviewed process tree is required.");
  const all = [config.owner, ...config.jobs], ids = new Set();
  for (const p of all) {
    if (!p || !Number.isSafeInteger(p.pid) || p.pid <= 1 || !/^\d+$/.test(p.start) || !Number.isSafeInteger(p.parentPid) || !Number.isSafeInteger(p.group) || !Array.isArray(p.argv) || !p.argv.length || ids.has(p.pid)) throw new Error("Invalid process identity.");
    ids.add(p.pid);
  }
  const byId = new Map(all.map(p => [p.pid, p]));
  for (const p of config.jobs) {
    if (path.basename(p.argv[0]) !== "rsync" || p.argv.at(-2) !== config.source || p.argv.at(-1) !== config.destination || p.group !== config.owner.group) throw new Error("Unexpected rsync command.");
    const visited = new Set(); let cursor = p;
    while (cursor.pid !== config.owner.pid) {
      if (visited.has(cursor.pid) || !byId.has(cursor.parentPid)) throw new Error("Unexpected process ancestry.");
      visited.add(cursor.pid); cursor = byId.get(cursor.parentPid);
    }
  }
  for (const identity of [config.sourceIdentity, config.destinationIdentity]) if (!identity || !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino)) throw new Error("Directory identities are required.");
  return config;
}

/** Pure reconciliation decision; uncertainty can pause matching work, never resume it. */
export function decideCopy(config, observation) {
  validateSchedule(config);
  const {bootId, owner, jobs, status, pathsUnchanged, prior, now} = observation;
  if (bootId !== config.bootId) return {phase: "blocked", reason: "host-restarted", signal: null, targets: []};
  const matching = config.jobs.filter((p, i) => sameProcess(p, jobs[i]));
  const pause = reason => ({phase: "blocked", reason, signal: "SIGSTOP", targets: matching.filter(p => jobs[config.jobs.indexOf(p)].state !== "T")});
  if (prior?.phase === "blocked") return pause(prior.reason || "operator-review-required");
  const statusOwned = status?.startedAt === config.copyStartedAt;
  if (statusOwned && status.phase === "precopy-complete" && [0, 24].includes(status.exitCode) && matching.length === 0 && jobs.every(p => !p || ["Z", "X"].includes(p.state))) return {phase: "complete", reason: "precopy-finished", signal: null, targets: []};
  if (!statusOwned || status.phase !== "copying") return pause("copy-status-changed");
  if (!sameProcess(config.owner, owner) || matching.length !== config.jobs.length) return pause("process-identity-changed");
  if (!pathsUnchanged) return pause("directory-identity-changed");
  if (jobs.some(p => p.state === "t")) return pause("process-traced");
  const allowed = windowOpen(now, config);
  const targets = config.jobs.filter((p, i) => allowed ? jobs[i].state === "T" : jobs[i].state !== "T");
  return {phase: allowed ? "copying" : targets.length ? "pausing" : "paused", reason: allowed ? "overnight-window" : "outside-window", signal: allowed ? "SIGCONT" : "SIGSTOP", targets};
}

/** Parse Linux proc stat without assuming the command has no spaces or parentheses. */
export function parseProcess(pid, stat, argv) {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return {pid, state: fields[0], parentPid: Number(fields[1]), group: Number(fields[2]), start: fields[19], argv};
}

/** Read only the process identified by a reviewed numeric PID. */
function readProcess(pid) {
  try {
    return parseProcess(pid, fs.readFileSync(`/proc/${pid}/stat`, "utf8"), fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean));
  } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
}

/** Atomically persist a small scheduling receipt. */
function saveReceipt(file, value) {
  const temporary = file + ".partial", fd = fs.openSync(temporary, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** Match the original physical directories, rejecting symlink and mount changes. */
function sameDirectory(file, identity) {
  try {
    const stat = fs.statSync(file);
    return fs.realpathSync(file) === path.resolve(file) && stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch { return false; }
}

/** Retire only the exact installed copy schedule after pre-copy has finished. */
function retireSchedule(config) {
  if (!config.cronFile || !/^\/boot\/config\/plugins\/dynamix\/scriptarr-overnight-copy\.cron$/.test(config.cronFile)) throw new Error("Unexpected schedule path.");
  if (fs.existsSync(config.cronFile)) {
    const digest = createHash("sha256").update(fs.readFileSync(config.cronFile)).digest("hex");
    if (digest !== config.cronSha256 || fs.existsSync(config.cronFile + ".disabled")) throw new Error("Schedule changed; manual retirement required.");
    fs.renameSync(config.cronFile, config.cronFile + ".disabled");
  }
  execFileSync("/usr/local/sbin/update_cron", [], {stdio: "pipe", timeout: 15000});
}

/** Reconcile once. The caller must hold the documented flock for the complete invocation. */
export function runSchedule(config, {dryRun = false, clock = () => new Date()} = {}) {
  validateSchedule(config);
  const now = clock();
  let prior = null, invalidJournal = false;
  try {
    prior = JSON.parse(fs.readFileSync(config.journalFile, "utf8"));
    if (prior?.version !== 1 || !["copying", "pausing", "paused", "blocked", "complete"].includes(prior.phase)) throw new Error("Invalid journal.");
  } catch (error) {
    if (error.code !== "ENOENT") { invalidJournal = true; prior = {phase: "blocked", reason: "journal-unreadable"}; }
  }
  let status = null;
  try { status = JSON.parse(fs.readFileSync(config.statusFile, "utf8")); } catch { /* Invalid status must pause instead of resuming. */ }
  const observe = () => ({bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), owner: readProcess(config.owner.pid), jobs: config.jobs.map(p => readProcess(p.pid)), status, prior, now,
    pathsUnchanged: sameDirectory(config.source, config.sourceIdentity) && sameDirectory(config.destination, config.destinationIdentity)});
  const decision = decideCopy(config, observe());
  const receipt = {version: 1, checkedAt: now.toISOString(), ...decision, targets: decision.targets.map(p => p.pid), timezone: config.timezone, startHour: config.startHour, endHour: config.endHour};
  if (dryRun) return receipt;
  const signalTargets = () => {
    for (const p of decision.targets) {
      const current = observe(), next = decideCopy(config, {...current, now: clock()});
      if (!sameProcess(p, readProcess(p.pid)) || !next.targets.some(t => t.pid === p.pid) || next.signal !== decision.signal) throw new Error("Copy state changed before signal.");
      process.kill(p.pid, decision.signal);
    }
  };
  try {
    // Pausing must not wait for a busy destination's journal flush. Resuming requires a durable receipt first.
    if (decision.signal === "SIGSTOP") signalTargets();
    if (invalidJournal && fs.existsSync(config.journalFile)) fs.renameSync(config.journalFile, `${config.journalFile}.rejected-${process.pid}-${now.getTime()}`);
    saveReceipt(config.journalFile, {...receipt, actionPending: receipt.targets.length > 0});
    if (decision.signal === "SIGCONT") signalTargets();
    if (decision.phase === "complete") { retireSchedule(config); receipt.scheduleRetired = true; }
    const current = observe();
    receipt.processStates = current.jobs.map(p => ({pid: p?.pid, state: p?.state || "missing"}));
    if (decision.phase === "pausing" && current.jobs.every(p => p?.state === "T")) receipt.phase = "paused";
    saveReceipt(config.journalFile, {...receipt, actionPending: false});
    return receipt;
  } catch (error) {
    // A failed resume must not leave only part of the reviewed tree running.
    for (const p of config.jobs) if (sameProcess(p, readProcess(p.pid))) process.kill(p.pid, "SIGSTOP");
    saveReceipt(config.journalFile, {...receipt, phase: "blocked", reason: "action-failed", actionPending: false});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2] || process.argv.slice(3).some(arg => arg !== "--dry-run")) throw new Error("Usage: scheduled-copy.mjs CONFIG [--dry-run]");
    const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    console.log(JSON.stringify(runSchedule(config, {dryRun: process.argv.includes("--dry-run")})));
  } catch { console.error("Scheduled copy needs operator review; no new copy was started."); process.exitCode = 1; }
}
