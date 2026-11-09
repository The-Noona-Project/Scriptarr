/** @file Private, per-run SSH multiplexing for encrypted backup transfers. */
import {lstat, mkdtemp, rm, rmdir} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Build pinned SSH arguments for one restricted receiver channel.
 * @param {Record<string, any>} remote Existing receiver configuration.
 * @param {string | null} command Exact restricted receiver command, or null for control exit.
 * @param {string} controlPath Private socket owned by this backup run.
 * @returns {string[]} Arguments with no inherited SSH configuration or weakened host verification.
 */
export const receiverSshArgs = (remote, command, controlPath) => [
  "-F", "/dev/null", "-T", "-p", String(remote.port || 22),
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
  "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${remote.knownHostsFile}`,
  "-o", "IdentitiesOnly=yes", "-i", remote.identityFile,
  "-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-o", `ControlPath=${controlPath}`,
  ...(command === null ? ["-O", "exit"] : []),
  `${remote.user}@${remote.host}`, ...(command === null ? [] : [command])
];

/**
 * Allocate a private short socket path; reuse authentication across object and snapshot channels.
 * @param {Record<string, any>} remote Existing receiver configuration.
 * @returns {Promise<{args: (command: string) => string[], close: (run: Function) => Promise<void>}>} Scoped channel arguments and cleanup.
 */
export async function createBackupSshSession(remote) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scriptarr-backup-ssh-"));
  const controlPath = path.join(directory, "master");
  return {
    args: command => receiverSshArgs(remote, command, controlPath),
    async close(run) {
      try {
        await lstat(controlPath);
        try { await run(receiverSshArgs(remote, null, controlPath)); } catch { /* An expired master is already closed. */ }
        await rm(controlPath, {force: true});
      } catch (error) { if (error.code !== "ENOENT") return; }
      try { await rmdir(directory); } catch { /* Preserve unexpected entries instead of recursively deleting them. */ }
    }
  };
}
