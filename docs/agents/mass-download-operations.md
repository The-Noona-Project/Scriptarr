# Array storage and automatic bulk downloads

## Operational sequence

1. Preserve the existing A/T run identities and take a current inventory. A remains paused during storage maintenance.
2. Configure the core `scriptarr` share for Array primary storage with no secondary pool. All core data, including MySQL, caches, private configuration and temporary work, belongs on the array. Remote service storage and the shared Docker engine keep their existing placement.
3. Pre-copy between verified physical paths, then stop reconciliation and writers for the final consistent sync. Preserve permissions, links and timestamps; checksum the copied inventory. Keep a database/configuration recovery point before retiring the SSD source. Verify representative writes against physical array locations.
4. Recreate Warden through `scripts/operations/replace-warden.mjs` using an exact expected ID, immutable cached image and protected operation JSON. The helper preserves mounts and creates only the canonical name. Restore the previous private deployment file if rollback is necessary. Historical audit scripts which retain renamed Wardens are not the supported deployment path.
5. Retire only separately reviewed stopped/created containers through `retire-container.mjs ID NAME ARCHIVE_ROOT`. The protected archive contains private Docker configuration, root filesystem and a SHA-256 receipt. The optional `--read-only-btrfs` archive path reads the exact inspected stopped snapshot when Docker export stalls; deletion still goes through Docker. It never removes images, bind-mounted files or volumes. Keep unresolved migration/custody containers and running qualification work.

## Capacity and readiness

- Raven uses a 100 GiB reserve and writes `.storage-pressure` on rejection. Capacity GETs are observational. Explicit start/continue clears the latch only above 150 GiB. `SCRIPTARR_STORAGE_RESERVE_BYTES` and `SCRIPTARR_STORAGE_RESUME_BYTES` override these defaults for controlled environments; isolated tests may use zero.
- Admission runs before titles, chapters, page writes, conversion acceptance and bulk retry allocation. Paused work retains its IDs and physical files. A pressure rejection must not allocate another owned execution attempt.
- Warden reports the actual mounted runtime filesystem's capacity and inode readiness. Moon's public `/health/downloads` returns only readiness booleans, with a five-second upstream deadline and no-store caching. It brokers through Sage and returns 503 for incomplete evidence. Independent monitoring checks this endpoint as well as backup freshness.
- The committed backup sender may write `completionStatusFile` to `/mnt/user/scriptarr/raven/downloads/.operations/core-backup.json`. Only successful receiver commit writes `{state:"complete",createdAt,id}`. Automatic work requires a recovery point younger than 30 hours.
- Before launch, audit all four A types and calculate retained canonical archive plus reader-output bytes per title. Use the provider population and the completed A sample to choose a conservative per-letter estimate. Record a reviewed `.operations/mass-capacity.json` with `approved:true`, `type:"all"`, `nsfw:false`, and positive integral `perLetterEstimateBytes`. Recheck the remaining alphabet against available capacity with 25% headroom and the reserve before every batch. Missing or malformed proofs pause automation.

## Command and identity compatibility

`/downloadall run type:All nsfw:False titlegroup:all groupsize:4 autoadvance:True`

- `autoadvance` is optional and defaults false. Portal forwards Boolean `autoAdvance` through Sage. Raven accepts it only for all four types, A-Z, explicit non-adult policy and four batches per window.
- Consent persists in the run payload and public filters. Enabled consent extends the creation fingerprint; legacy false/omitted fingerprints stay unchanged. A changed consent cannot reuse an existing creation request key.
- Automatic execution stays within the durable worker and restore barrier. It checks current backup, capacity, VPN and real worker-pool readiness before each batch. Failures pause rather than approving unresolved work repeatedly. Continue and cancellation retain existing approval/receipt fencing.
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

## Failure handling

- MySQL operations use bounded acquisition and execution. A timed-out executing connection is destroyed; uncertain writes are not automatically retried. Vault health and availability errors return 503 without SQL or secrets.
- Ordinary SQL conflicts retain the connection for lookup/rollback; fatal transport failures still retire it. User hydration uses bounded batches rather than an unbounded query fanout. Source HTTP status/Retry-After is processed before MIME validation, and all response bodies close on success, errors and cancellation.
- Container retirement synchronizes the archive, inspect snapshot, receipt, containing directory, archive root and parent directory before Docker removal. A synchronization failure preserves the original container. Canonical Warden replacement verifies its rollback image before stop, and aborted/failed Docker responses settle with a bounded error.
- Provider HTML uses shared pacing and Retry-After cooldown. Cancellation remains interruptible. Explicit adult conflicts become separately counted policy exclusions; uncertain source identity/type remains unresolved.
- Binary VPN probes discard output to avoid pipe stalls and distinguish missing/execution failures, timeout and interruption. Protection remains fail-closed.
- Review binary-log expiration only after verifying backup/replication requirements. Use supported MySQL expiration or purge commands, never filesystem removal.
