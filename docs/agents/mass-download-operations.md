# Array storage and automatic bulk downloads

## Owner-approved cancellation and full library purge

Explicit full-library deletion supersedes the preservation/resume sequence below. Remove the Codex heartbeat and
hash-matching host copy cron under its flock, terminate only the pinned rsync tree, and hold Warden reconciliation
and all content writers. Keep Vault/MySQL available for a temporary Sage maintenance runner using the existing
broker contract. Full reset uses the conversion pool lock and clears aliases, jobs, claims, scoped fences and only
Sage's three `portal-downloadall-*` job kinds alongside the original content tables. Preserve unrelated jobs and
account/configuration state. Memory reset joins the same conversion transaction queue; scoped reset behavior stays
unchanged. Remove only an inventoried, quiescent physical content scope, including reader/conversion artifacts and the
unpublished migration data tree. Keep VPN configuration, application/database directories, existing backups and
retirement archives. Hold maintenance on any partial failure; restart through Warden only after empty-content and
protected-state checks pass. No migration cutover or automatic download resume follows this purge.

## Operational sequence

1. Preserve the existing A/T run identities and take a current inventory. A remains paused during storage maintenance.
2. Configure the core `scriptarr` share for Array primary storage with no secondary pool. All core data, including MySQL, caches, private configuration and temporary work, belongs on the array. Remote service storage and the shared Docker engine keep their existing placement.
3. Pre-copy between verified physical paths, then stop reconciliation and writers for the final consistent sync. Preserve permissions, links and timestamps; checksum the copied inventory. Keep a database/configuration recovery point before retiring the SSD source. Verify representative writes against physical array locations.
4. Recreate Warden through `scripts/operations/replace-warden.mjs` using an exact expected ID, immutable cached image and protected operation JSON. The helper preserves mounts and creates only the canonical name. Restore the previous private deployment file if rollback is necessary. Historical audit scripts which retain renamed Wardens are not the supported deployment path.
   For array-backed Docker storage with slow stop/unmount operations, set integer `dockerTimeoutMs:180000` in those protected options. Each operation retains both idle and absolute deadlines (default 45000 ms, bounds 1000–300000 ms); extend the caller's SSH budget to cover the full replacement and health wait. Reject malformed budgets before any Docker call and reconcile canonical identity after an interrupted response.
5. Retire only separately reviewed stopped/created containers through `retire-container.mjs ID NAME ARCHIVE_ROOT`. The protected archive contains private Docker configuration, root filesystem and a SHA-256 receipt. The optional `--read-only-btrfs` archive path reads the exact inspected stopped snapshot when Docker export stalls; deletion still goes through Docker. It never removes images, bind-mounted files or volumes. Keep unresolved migration/custody containers and running qualification work.

## Overnight pre-copy controller

- `scripts/operations/scheduled-copy.mjs CONFIG [--dry-run]` controls an existing reviewed Linux rsync tree; it never
  launches rsync. The protected version-1 manifest pins the boot ID, owner and child PID/start/parent/group/argv,
  physical source/destination device and inode, original copy start time, status/journal paths, timezone and hours.
- Install the controller and private manifest under `/boot/config/plugins/dynamix/scriptarr-overnight-copy/`.
  Install one every-minute entry in `/boot/config/plugins/dynamix/scriptarr-overnight-copy.cron`, guarded by an
  exclusive nonblocking `flock` in `/run/lock`, then apply it using `/usr/local/sbin/update_cron`. Invoke the actual
  absolute Node binary; preserve all unrelated cron files. Hold that same lock for manual controller invocations.
- Capture identities from the current verified tree, pause it, and retain the bootstrap receipt outside both copy
  trees. The separate controller journal is authoritative for scheduling; do not overwrite the original worker's
  `precopy-status.json`, which continues to own transfer completion. Record the installed cron SHA-256 in the manifest.
- Midnight is inclusive and 7 AM exclusive in `America/Los_Angeles`. The host checks every minute; kernel writeback
  can outlive a stop request. Do not kill rsync, alter its copy flags, or issue a system-wide sync to enforce a pause.
  The owner worker stays alive to persist its child's eventual exit. Repeated ticks signal only members needing a change.
- Validate every identity before signaling. Missing/reused PIDs, ancestry/argv changes, reboot, changed directories,
  failed/malformed copy status or a latched controller fault prohibit resume. Pause still-matching children where safe.
  Preserve malformed controller journals under a `.rejected-*` name and latch a review fault before any resumption.
  Review and explicitly reinstall a manifest after a fault; never restart a duplicate from a daily task.
- Only a matching original copy receipt with exit 0 or online exit 24 and no remaining live reviewed children can
  finish pre-copy. Rename only the hash-matching cron file to `.cron.disabled` and reload cron. The controller retains
  its manifest and journal and cannot authorize cold sync, cutover, source deletion, new backups or download resume.
- Create one midnight Codex heartbeat in the current chat to check this host controller and report meaningful
  progress/failures. The server remains responsible for the morning pause when Codex is closed. Retire the heartbeat
  after verified pre-copy completion and hand the remaining migration gates back to the existing workflow.

## Capacity and readiness

- Raven uses a 100 GiB reserve and writes `.storage-pressure` on rejection. Capacity GETs are observational. Explicit start/continue clears the latch only above 150 GiB. `SCRIPTARR_STORAGE_RESERVE_BYTES` and `SCRIPTARR_STORAGE_RESUME_BYTES` override these defaults for controlled environments; isolated tests may use zero.
- Admission runs before titles, chapters, page writes, conversion acceptance and bulk retry allocation. Paused work retains its IDs and physical files. A pressure rejection must not allocate another owned execution attempt.
- Warden reports the actual mounted runtime filesystem's capacity and inode readiness. Moon's public `/health/downloads` returns only readiness booleans, with a five-second upstream deadline and no-store caching. It brokers through Sage and returns 503 for incomplete evidence. Independent monitoring checks this endpoint and backup freshness for configured backup stores.
- The committed backup sender may write `completionStatusFile` to `/mnt/user/scriptarr/raven/downloads/.operations/core-backup.json`. Only successful receiver commit writes `{state:"complete",createdAt,id}`. Automatic work requires a recovery point younger than 30 hours by default. An explicit Boolean `backupRequired:false` in the owner-reviewed capacity proof skips only that evidence read and freshness check. Missing values default true; null/string/numeric values fail closed. The forecast must still be approved and fit with headroom, and storage, VPN and worker checks remain mandatory. When the owner disables backups, disable only the matching Scriptarr backup/retention schedules, remove their monitor stores, and preserve existing completed files.
- Before launch, audit all four A types and calculate retained canonical archive plus reader-output bytes per title. Use the provider population and the completed A sample to choose a conservative per-letter estimate. Record a reviewed `.operations/mass-capacity.json` with `approved:true`, `type:"all"`, `nsfw:false`, and positive integral `perLetterEstimateBytes`. Recheck the remaining alphabet against available capacity with 25% headroom and the reserve before every batch. Missing or malformed proofs pause automation.

## VPN transport recovery

- Compare the selected cached profile with the current official provider profile before attributing a failed handshake to cache age. Existing exact-region profiles are reused; archive age alone does not replace them.
- When the default UDP profile fails TLS negotiation, an owner-approved manual override may use the same region from PIA's official `https://www.privateinternetaccess.com/openvpn/openvpn-tcp.zip`. Download through Raven's VPN bootstrap network path, bound and validate the ZIP, and record archive/profile hashes. Check that the exact target is a regular managed profile and that no Raven tunnel is active before atomically replacing it.
- Preserve credentials, region selection and TLS verification. Run the Sage-brokered `/v1/vpn/test`, then confirm sustained `protected:true` through Raven health and Moon's public boolean readiness route. Source downloads stay paused on failed protection; never disable the guard to test throughput.
- Treat a manual TCP profile as private deployment configuration. A cache reconstruction from the default IP/UDP archive can overwrite it; reapply the approved provider profile after such a rebuild. Keep the public Settings enable/region/credentials contract unchanged.

## Command and identity compatibility

`/downloadall run type:All nsfw:False titlegroup:all groupsize:4 autoadvance:True`

- `autoadvance` is optional and defaults false. Portal forwards Boolean `autoAdvance` through Sage. Raven accepts it only for all four types, A-Z, explicit non-adult policy and four batches per window.
- Consent persists in the run payload and public filters. Enabled consent extends the creation fingerprint; legacy false/omitted fingerprints stay unchanged. A changed consent cannot reuse an existing creation request key.
- Automatic execution stays within the durable worker and restore barrier. It checks the explicit backup policy, capacity, VPN and real worker-pool readiness before each batch. Failures pause rather than approving unresolved work repeatedly. Continue and cancellation retain existing approval/receipt fencing.
- Finish the existing A run before starting the full run. Rediscovery must reuse verified completed content. Numeric and non-Latin prefixes are outside this A-Z command.

## Artifact retention and recovery

- A bounded coordinator sweep inspects 32 conversion descriptors each minute; authenticated POST `/v1/ingest/artifacts/reclaim` inspects up to 128. GET `/v1/storage` is observational.
- Reclamation requires a completed durable conversion older than 24 hours, exact epoch/artifact/catalog binding, unchanged source fingerprint, a healthy canonical manifest and matching physical page hashes. Active writers and maintenance fences defer it.
- Preserve bundle/proof files and an atomic reclamation receipt. Remove only verified duplicate WebP payloads. Unknown, changed, failed, queued and publishing work remain intact. Interrupted reclamation resumes from its phase receipt.
- Completed replay reads the verified canonical output after reclamation. Missing/corrupt output with unchanged source/catalog binding may request a fenced `rebuildPublished` retry. Vault requires the exact epoch, coordinator generation and artifact hash, retains prior publication receipts, and allocates a new epoch. Broker outages and changed identities cannot authorize reconstruction.
- Malformed manifest reconstruction validates the accepted artifact and all retained pages before preserving the damaged metadata under `.ingest-recovery`. The restored manifest publishes last; foreign or changed retained files still block recovery. Warden rollback uses the inspected image ID even when the original container used a mutable tag.
- New reclamation uses a process-local quiescent fence because it removes only duplicates. Canonical cleanup continues using restart-durable maintenance fences. Reader publication holds the title writer scope throughout file publication.
- Transient reclamation counts as active maintenance for destructive cleanup. Incoming writers wait cooperatively and receive priority over another reclamation sweep; permanent cleanup fences still reject writes. Storage admission and explicit latch release share one lock, preventing a stale admission read from relatching an approved recovery. The global latch is cleared only by owner bulk start/continue, after which ordinary retries may resume.
- Completion may include `publication` with `jobId`, `epoch`, `artifactSha256` and `manifestSha256`. Vault validates the artifact against the current execution or private accepted-publication history. This binds an unchanged immutable manifest during a newer rebuild without changing chapter idempotency hashes. Completed replay cannot change the binding. Retention validates its file hash and original publication identity, falling back to the execution identity only for legacy receipts.
- Cancellation and retry retain accepted-artifact evidence before advancing/clearing state. A legacy cancelled job's retained result belongs to the epoch immediately before its single cancellation increment. Unknown or conflicting artifacts cannot populate this history. A fenced completed rebuild carries its saved `publication` and chapter scope as `spec.rebuildPublication`; only that binding permits replacing changed parseable metadata after validating every accepted and retained page and preserving rejected bytes. Unchanged manifests remain immutable.

## Failure handling

- MySQL operations use bounded acquisition and execution. A timed-out executing connection is destroyed; uncertain writes are not automatically retried. Vault health and availability errors return 503 without SQL or secrets.
- Ordinary SQL conflicts retain the connection for lookup/rollback; fatal transport failures still retire it. User hydration uses bounded batches rather than an unbounded query fanout. Source HTTP status/Retry-After is processed before MIME validation, and all response bodies close on success, errors and cancellation.
- Container retirement synchronizes the archive, inspect snapshot, receipt, containing directory, archive root and parent directory before Docker removal. A synchronization failure preserves the original container. Canonical Warden replacement verifies its rollback image before stop, and aborted/failed Docker responses settle with a bounded error.
- Recursive archive creation also flushes every new ancestor and its parent. Truncated HTTP responses retain received status; an ambiguous rollback create is inspected and accepted only with its unique rollback operation label and inspected original image. Successful body reads retain the source request's elapsed-time deadline, independently of socket inactivity.
- Provider HTML uses shared pacing and Retry-After cooldown. Cancellation remains interruptible. Explicit adult conflicts become separately counted policy exclusions; uncertain source identity/type remains unresolved.
- Binary VPN probes discard output to avoid pipe stalls and distinguish missing/execution failures, timeout and interruption. Protection remains fail-closed.
- Review binary-log expiration only after verifying backup/replication requirements. Use supported MySQL expiration or purge commands, never filesystem removal.
