# Warden AI Notes

- Warden owns first boot, runtime defaults, service descriptors, the URL-first MySQL contract, and GPU/runtime flag
  planning for managed services.
- Warden must surface the exact Discord callback URL administrators need.
- Warden owns one shared internal Docker network named `scriptarr-network`; Moon is the only default public bridge.
- Per-service `SCRIPTARR_<SERVICE>_DNS_SERVERS` is opt-in. Validate resolver IPs, pass the ordered `dnsServers` descriptor
  through every Docker create/update path, and reconcile against `HostConfig.Dns` only when explicitly configured.
  Unset DNS must not recreate other services; explicit `[]` requests inherited DNS. Keep Docker aliases and VPN routing.
- Warden runs as its own Docker container and is the only first-party container admins should start manually in the
  supported install path.
- Warden requires a Docker socket bind and should reconcile the managed sibling containers from inside that container.
- Warden's own persistent folders are `warden/logs -> /var/log/scriptarr` and `warden/runtime -> /var/lib/scriptarr`.
- On Linux or Unraid installs, prefer binding the full `SCRIPTARR_DATA_ROOT` back into the Warden container at the
  same absolute path so Warden can create the host storage tree directly.
- Keep Docker health checks aligned between Warden, the managed HTTP services, and managed MySQL so operators can trust
  Docker's `healthy` status during first boot and upgrades.
- `npm run docker:healthcheck` is the default Warden-managed smoke flow for contributors. It is expected to take a
  while on cold machines because it rebuilds images and may need to pull missing layers.
- LocalAI is manual in 3.0: no first-boot model pull, install, or start.
- Embedded LocalAI now lives inside Oracle. Warden must mount persistent `localai/models` and `localai/data` into the
  Oracle container and pass the correct hardware flags for the selected profile, especially NVIDIA
  `--runtime nvidia --gpus all`. Explicit `/dev/nvidia*` device bindings are opt-in with
  `SCRIPTARR_NVIDIA_DEVICE_BINDINGS=true` for hosts where Docker's GPU request does not expose `/dev/nvidia0` by
  itself. If Warden cannot see `nvidia-smi` from inside its own container, it should still
  detect Docker's configured NVIDIA runtime from Docker runtime metadata before falling back to CPU planning.
- LocalAI install, start, remove, and readiness actions are Oracle-owned embedded runtime jobs brokered through Sage.
  Warden should not recreate the standalone `scriptarr-localai` sidecar path by default.
- If the next AI startup pass auto-starts embedded LocalAI after Oracle restarts, keep that implementation in Oracle.
  Warden should only provide the correct service-plan mounts, environment, GPU flags, update reconciliation, and drift
  detection for `scriptarr-oracle`.
- AI acceleration is optional; safe fallback is required.
- The repo-level Docker test stack is Warden-managed, starts a containerized Warden first, and should stay aligned with
  the runtime service plan.
- Warden's public bootstrap and runtime APIs must redact secrets before Moon or other operators consume them.
- Warden's log-tail API must stay allowlisted to managed Scriptarr containers and must redact secrets server-side
  before Sage or Moon ever see log entries. There is intentionally no raw-log toggle.
- The managed-service update path lives behind Moon -> Sage -> Warden and only targets the sibling first-party
  services. Warden and MySQL are informational or manual in the current product scope.
- Moon's `/admin/system/ai` page still shows LocalAI status, profile, install, start, and remove actions through Sage,
  but those requests terminate at Oracle's embedded runtime routes. Keep Warden's role focused on service-plan mounts,
  environment, GPU device requests, and drift detection.
- Warden should inject Sage broker settings into Portal, Oracle, and Raven instead of direct first-party base URLs.
- Warden should inject Moon's service token and `SCRIPTARR_PUBLIC_BASE_URL` into Moon so Moon can enforce same-origin
  live WebSocket tickets and authenticate its internal Sage live bridge.
- Warden should inject Sage's `SCRIPTARR_VAULT_AUTH_TIMEOUT_MS`, defaulting managed production to `8000` ms while
  honoring explicit `SCRIPTARR_VAULT_AUTH_TIMEOUT_MS` or legacy `SCRIPTARR_AUTH_VAULT_TIMEOUT_MS` overrides.
- Warden should launch Raven with the VPN runtime device/capability contract (`NET_ADMIN` and `/dev/net/tun`) when not
  explicitly disabled, and drift detection should recreate Raven when those flags disappear.
- Raven's new output is WebP q85/method4, CPU-only even with legacy AVIF/shared NVIDIA hints. Existing AVIF remains a
  reader compatibility concern. Oracle GPU/model mounts and resource settings remain independent and unchanged.
- Optional placement `scriptarr-raven-worker` activates the same image's early `ingest-worker` role on a remote host;
  the normal `scriptarr-raven` remains the coordinator beside Sage/Vault. Do not add a separate worker image build.
  `SCRIPTARR_RAVEN_WORKER_IMAGE` may independently pin the Raven artifact; otherwise it inherits `SCRIPTARR_RAVEN_IMAGE`.
- The worker gets only its own credential, HTTPS Sage URL, exact read-only CA and scratch/log paths. Its credential
  enters only Sage's service-token map, never Portal or Vault's maps. No Docker socket, canonical downloads, VPN,
  metadata/provider credentials, NVIDIA grants or NET_ADMIN belong in the worker.
- Fix worker CPU/memory/combined memory-swap at 2 CPUs/4 GiB/4 GiB, heap 1536 MiB, encode threads 2, pages 1, chapters 1. Check swap and read-only
  mount drift, in addition to the existing CPU/memory/device checks. Broker unavailability is diagnostic liveness;
  unhealthy optional initialization must not fail other services or cause recreation storms.
  Docker checks the worker's explicit `ready:true` (real WebP codec probe plus recent authenticated Sage traffic),
  while HTTP `/health` remains process liveness. No job is needed to register idle worker readiness.
- The coordinator receives `SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED=true` when a worker is assigned. Lack of capacity
  means wait; Warden never enables Plex encoding or changes the six-title setting to bypass worker backpressure.
- Sage's worker-only HTTPS port 3444 binds to the core LAN IP in Docker, with dedicated read-only leaf certificate/key
  mounts. Existing HTTP 3004 and all Oracle/Portal URLs stay unchanged. Verify server CA/name on worker outbound calls.
- Warden should mount Moon's derived cover-cache folder at `/app/cover-cache` and set
  `SCRIPTARR_MOON_COVER_CACHE_DIR` for the Moon container. The cache is rebuildable and separate from Vault/Raven
  authoritative catalog state.
- Update jobs should be mirrored into the shared broker as durable jobs and job tasks, not left as Warden-only memory.
- Warden-originated runtime or update transitions that matter to operators should be reported through Sage's internal
  broker routes so Vault's shared durable event log stays authoritative for Moon admin timelines.
- Keep full JSDoc on exported Warden `.mjs` source and tests so the ESLint doc gate stays green.
