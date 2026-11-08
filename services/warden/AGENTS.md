# Warden Agent Guide

Read this before editing `services/warden`.

## Role

Warden is Scriptarr's Docker orchestrator and first-boot source of truth. It seeds runtime defaults, derives the
Discord callback URL, parses the URL-first MySQL contract, owns `scriptarr-network`, and injects GPU/runtime flags for
managed services.

## Hard Rules

- Keep public runtime and setup details in `README.md` and [../../ServerAdmin.md](../../ServerAdmin.md).
- Warden should degrade safely when AI acceleration is unavailable.
- Do not reintroduce a setup wizard.
- Warden is the only first-party container admins should start manually. It must run as `scriptarr-warden` unless a
  narrower test or preview scope explicitly changes the name.
- Warden requires a Docker socket bind and should reconcile the rest of the managed Scriptarr containers from inside its
  own container.
- Warden owns the managed service env contract and should inject Sage broker settings plus Noona/Appa Discord env into
  the relevant sibling services instead of reviving direct Vault, Oracle, or Warden cross-calls.
- Do not pull or start LocalAI during first boot.
- Keep the public MySQL contract URL-first. Internal split MySQL envs are derived outputs, not first-class admin
  inputs.
- Keep Moon as the only public first-party service by default; other services should stay on the internal Warden
  network.
- Keep full JSDoc on exported Warden `.mjs` source and test files. `npm test` is expected to fail when doc coverage
  regresses.
- A multi-host topology is authoritative and immutable for a deployment: reconcile/prune only locally assigned
  services, use authenticated mTLS for primary-to-worker control, and never expose a remote Docker socket. Keep
  remote AI/Portal failures separate from core reader health.
- Vault and Raven must share Sage's primary host while their ports are bridge-private. Public update checks must
  return background jobs; reserve synchronous image comparison for the update worker itself.
- Multi-host planning must reject missing or development-default service credentials before creating published services.
- Multi-host mode must reject legacy standalone LocalAI mutations on both hosts. Oracle owns its embedded backend;
  retain legacy Warden LocalAI read diagnostics and single-host compatibility only.
- New Raven output is CPU WebP; legacy AVIF remains readable. Never inherit Oracle/shared GPU grants for Raven.
  Oracle GPU planning remains independent of Raven encoding.
- Managed WebP coordinators are always remote-required, even without worker placement or with a legacy false override.
  Normalize the compatibility AVIF encoder to CPU so strict legacy NVENC cannot disable the CPU-only deployment.
  Unassigned worker capacity degrades ingest and waits; it must not trigger local AVIF/Plex encoding or fail core health.
- `scriptarr-raven-worker` is optional and must belong to a remote host. It reuses the Raven image in `ingest-worker`
  role, with a distinct worker token present only in Sage's token map. Its only persistent mounts are scratch, logs,
  and the exact read-only Sage CA file. Never grant canonical storage, Docker socket, provider/VPN secrets or NET_ADMIN.
- Worker limits are fixed at 2 CPUs/4 GiB (swap ceiling also 4 GiB), JVM heap 1536 MiB, one chapter job, one page encoder,
  two encode threads, WebP q85/method4. A missing/unhealthy worker degrades ingest; matching unhealthy containers must
  not be repeatedly recreated. Worker placement makes coordinator ingest remote-required with no local fallback.
- Worker artifacts use Sage's dedicated HTTPS3444 listener on the core LAN IP; ordinary Sage3004 stays unchanged.
  Mount only the dedicated Sage leaf certificate/key into Sage and CA into the worker, read-only. Never share Warden's key.
- Keep `npm run docker:healthcheck` aligned with Warden's real runtime plan; it is the default cross-service smoke path
  for contributors and agents.
- Keep Moon -> Sage -> Warden managed-service updates scoped to the sibling first-party services. Warden and MySQL stay
  manual unless the product requirements explicitly change.
- Keep Warden update jobs durable through the shared broker instead of leaving them in process-local memory only.
- Keep LocalAI manual. Oracle owns the embedded LocalAI model cache/runtime; Sage/Vault stay the durable owner of
  Oracle/LocalAI settings.
- Do not revive the standalone `scriptarr-localai` sidecar by default. Warden should mount persistent LocalAI models
  and data into `scriptarr-oracle`, then let Oracle's embedded runtime handle install/start/remove/readiness.
- For the next AI startup hardening pass, Warden's expected role is plan validation only: confirm Oracle receives the
  model/data mounts, NVIDIA `--gpus all` device requests, optional explicit device flags, and env needed for embedded
  LocalAI. Do not make Warden start LocalAI; that belongs in Oracle.
- Keep Oracle LocalAI runtime mounts and hardware flags aligned with the selected preset:
  - `cpu`: no extra device flags
  - `nvidia`: `--runtime nvidia --gpus all`; explicit `/dev/nvidia*` device bindings are opt-in with
    `SCRIPTARR_NVIDIA_DEVICE_BINDINGS=true` when the host requires and exposes those paths
  - `intel`: `--device /dev/dri --group-add video`
  - `amd`: `--device /dev/kfd --device /dev/dri --group-add video`
- Retain legacy AVIF configuration data for compatibility, but do not let it select NVIDIA runtime/device grants or
  change new WebP output. Keep encoder, page and title concurrency separate; Warden does not change Sage's title limit.
- If service boot order, network topology, embedded LocalAI runtime planning, first-boot auth, or Docker test mode changes,
  update the Warden docs.

## Coding Map

- Service definitions, env injection, network aliases, ports, volumes, and health commands live in
  `config/servicePlan.mjs`.
- Container reconciliation and drift handling live in `core/managedStackRuntime.mjs`; update orchestration lives in
  `core/updateRuntime.mjs`; legacy sidecar LocalAI lifecycle work lives in `core/localAiRuntime.mjs`.
- Docker CLI helpers live under `docker`; filesystem and storage layout helpers live under `filesystem`.
- Cluster placement lives in `config/clusterTopology.mjs`, bounded mTLS transport in `core/clusterAgentClient.mjs`,
  owner-routed aggregation in `core/clusterRuntime.mjs`, and the control authorization/listener in
  `api/controlSecurity.mjs`.
- Warden should reconcile sibling first-party services from inside the `scriptarr-warden` container through the Docker
  socket. Do not move this responsibility into Moon, Sage, or host scripts.
- Managed-service updates are for sibling services only. Warden itself and MySQL stay manual unless product
  requirements explicitly change.
- Prove Warden changes with `npm --workspace services/warden test`, then `npm run docker:healthcheck` for plan,
  network, health, update, or first-boot behavior.
