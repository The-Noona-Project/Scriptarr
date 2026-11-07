# Network deployment backup and recovery

The operations helpers in `scripts/operations` back up the core data owner on ItsRainingPlex to na-west-2. An optional
second configuration-only sender backs up the AI host. These are recovery copies, not writable database replicas or
automatic failover.

## Safety and ownership

- Run the sender under an OS `flock` and a private root-owned configuration. Its work directory must be outside the live
  data root, so neither the temporary database copy nor encrypted archives can recurse into a later backup.
- Each sender has its own key and receiver namespace. The `scriptarr-backup` account has a locked password and a
  source-IP-restricted forced SSH command, with no PTY or forwarding. The receiver accepts only opaque encrypted
  objects, immutable snapshots, status/verification, and ciphertext fetches; original SSH commands are never executed.
- Pin the receiver's SSH host key. Never use `StrictHostKeyChecking=no`, a shared administrator key, or a password in
  command arguments. The receiver binaries are root-owned and the store is writable only by its dedicated account.
- RSA-OAEP wraps a new AES-256-GCM key for each artifact. The sender stores the public recovery key only. The private
  recovery key is escrowed separately with Windows DPAPI under the operator account. Preserve that Windows profile or
  export a separately protected recovery key before retiring the workstation.
- Encryption is streamed. Live database dumps and container metadata exist only in a private temporary directory and
  are removed after either success or failure. Logs and status expose phase/count/checksum metadata, never credentials.

## Capture and retention

`backup-source.mjs CONFIG` captures an initialized stopped MySQL directory without starting it. When MySQL is running,
it instead takes an all-databases single-transaction logical dump with routines, events, and triggers. A cold capture
is rejected if MySQL starts during the capture. `databaseMode: "none"` is for the AI host's configuration-only sender.

Configuration capture includes deployment secrets and certificates, Warden runtime configuration, image/container
metadata, and an encrypted canonical-library index. Only canonical CBZs below `raven/downloads/downloaded` are included
as incremental library objects; staged downloads and derived reader pages are rebuildable and excluded. Unchanged
canonical files reuse their encrypted objects; changed files receive new random identifiers. Files changing during
capture abort the run rather than publishing a mixed recovery point.

The receiver validates ciphertext hashes before committing a snapshot. It keeps the newest snapshot from each of seven
days and four calendar weeks. Library garbage collection uses the union of all retained manifests and additionally
protects newly uploaded objects for 24 hours. Retention never operates outside the dedicated receiver store.
Operator-created files under the store's `pins/`, named by an existing snapshot id, preserve migration baselines beyond
daily/weekly rotation. A source SSH key cannot create or remove pins. Pin the verified pre-migration cold snapshot.

Nightly source capture should run at 03:17 Pacific on Plex and 03:47 Pacific on the AI host. Independent na-west-2
monitoring runs every five minutes and fails if a source's committed backup is over 30 hours old or the public login
endpoint is unavailable. A weekly ciphertext scrub verifies all retained archives and referenced objects. Status JSON,
process exit codes, and systemd failed units are the local alert surfaces; the helpers send no external messages.
Oracle and Portal checks additionally validate bounded JSON health fields, including enabled LocalAI generation
readiness and Discord connection state. HTTP 200 alone cannot mark those checks healthy. Response bodies are limited
to 64 KiB with a seven-second total deadline and are never copied into monitoring logs.

## Restore

1. Fetch a committed snapshot's `manifest.json` and `snapshot.aesgcm` through the restricted receiver `fetch` command.
   Recover the private key into a temporary root-only file; remove it with an EXIT trap.
2. Run `node restore.mjs SNAPSHOT_DIRECTORY PRIVATE_KEY NEW_RECOVERY_DIRECTORY`. The helper checks the ciphertext
   checksum, authenticates before exposing plaintext, checks archive member paths, and extracts only into a newly
   created private directory. It never starts MySQL, changes routing, or starts Discord.
3. For a cold snapshot, start the exact recorded MySQL image against the recovered directory on an isolated Docker
   network with no published ports. For a logical snapshot, initialize a separate MySQL instance and import
   `database.sql`. Check all application tables and record row counts before testing Vault schema initialization.
4. Recover referenced canonical CBZ objects using the encrypted `library-index.json` mappings. Authenticate each object
   before placing it into a new library directory. Rebuild derived AVIF pages through Raven after database/library
   reconciliation. Do not point a trial restore at production mounts.
5. Compare account/settings/catalog counts and perform a real reader request. A checksum-only scrub does not replace
   an authenticated restore or database compatibility test.

## Verification

Run `node --test scripts/operations/operations.test.mjs`. The suite covers authenticated round trips, tampering,
truncation, cancellation cleanup, immutable destinations, command/path rejection, missing object refusal, independent
ciphertext verification, seven-daily/four-weekly selection, and live-root/workspace boundary validation. Execute the
same suite on a Linux host to verify Unix permission behavior.

The initial November 7 recovery point preserved the stopped October 8 database, then was fetched from na-west-2,
authenticated, and restored on Plex. Its 50 application tables passed `CHECK TABLE ... QUICK`; the trial instance was
stopped afterward so the deployment owner can test Vault migration on the recovered copy.
