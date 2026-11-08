# Warden

Warden bootstraps Scriptarr, owns the shared internal `scriptarr-network`, parses the URL-first MySQL contract, derives
the Discord callback URL, and selects the appropriate LocalAI AIO image profile for the host hardware.

Warden is also responsible for injecting the internal service topology that keeps first-party HTTP behind Sage. Raven,
Portal, and Oracle now receive Sage broker settings instead of direct first-party base URLs.
Warden also injects Sage's production Vault auth timeout as `SCRIPTARR_VAULT_AUTH_TIMEOUT_MS`, defaulting to `8000`
milliseconds unless the operator provides `SCRIPTARR_VAULT_AUTH_TIMEOUT_MS` or the legacy
`SCRIPTARR_AUTH_VAULT_TIMEOUT_MS`.

The supported install shape is to run Warden as its own Docker container and let it reconcile the other first-party
containers through the Docker socket. Outside test mode, Warden should not be published publicly; Moon remains the
default public first-party surface.

Warden no longer pulls or starts LocalAI on first boot. It exposes manual LocalAI configuration, install, start, and
remove actions so Moon admin can opt into the slower AI setup later or remove the selected runtime image. Warden treats
Sage's Oracle settings as the authoritative LocalAI selection, caches the last Sage-synced profile in its runtime
directory, reloads that selection on boot and before LocalAI lifecycle actions, and reports those lifecycle actions as
asynchronous brokered jobs with task progress.

The supported database inputs are:

- `SCRIPTARR_MYSQL_URL=SELFHOST`
- `SCRIPTARR_MYSQL_URL=mysql://[user[:password]@]host[:port]/database`
- `SCRIPTARR_MYSQL_USER` for the managed app user or as the username fallback when the URL omits one
- `SCRIPTARR_MYSQL_DATABASE` to retain an existing schema name in SELFHOST mode
- `SCRIPTARR_MYSQL_IMAGE` to pin a compatible MySQL image/digest during migration (default `mysql:8.4`)

First-party images also accept explicit `SCRIPTARR_<SERVICE>_IMAGE` references, for example
`SCRIPTARR_ORACLE_IMAGE=registry.example/scriptarr-oracle@sha256:...`. These references take precedence over the shared
image namespace/tag, allowing each host to reconcile a verified immutable release. A pinned reference stays pinned
until its deployment configuration is changed; an image update check does not silently advance a digest pin.

Warden also ships the Docker-backed test stack used by repo contributors:

- `npm run docker:healthcheck`
- `npm run docker:test`
- `npm run docker:test:teardown`

## Container Contract

- default container name: `scriptarr-warden`
- required bind: `/var/run/docker.sock:/var/run/docker.sock`
- required persistent folders:
  - `warden/logs -> /var/log/scriptarr`
  - `warden/runtime -> /var/lib/scriptarr`
- managed Moon folders that Warden mounts for derived browser assets:
  - `moon/cover-cache -> /app/cover-cache`
  - `moon/reader-page-cache -> /app/reader-page-cache`
- optional LocalAI folders that Warden mounts when admins start LocalAI:
  - `localai/models -> /models`
  - `localai/data -> /data`
- recommended Linux/Unraid bind:
  - `<data-root> -> <data-root>`
- supported runtime: start Warden, let Warden create and reconcile Moon, Vault, Sage, Raven, Portal, Oracle, and
  optional managed MySQL
- Docker health checks: Warden and the managed containers report `healthy` through Docker once each `/health` endpoint
  or MySQL readiness check passes
- test runtime: `npm run docker:test` starts a containerized Warden first and only publishes the Warden API so the
  helper can verify health

## Runtime APIs

- `/api/bootstrap`: static service plan, install mode, callback URL, and storage contract
- `/api/runtime`: Warden self status plus live managed-service runtime details, with sensitive env values redacted
- `/api/logs`: allowlisted, server-redacted Docker log tails for Warden and managed Scriptarr services
- `/api/updates`: current managed-service image state plus the latest broker-backed update job snapshot
- `/api/updates/check`: asynchronous pull-first check; HTTP 202 returns a job to poll through `/api/updates`
- `/api/updates/install`: asynchronous managed-service install or restart flow for the sibling services
- `/api/localai/*`: legacy standalone LocalAI sidecar controls kept for single-host compatibility only; multi-host
  deployments reject configuration/install/start/remove with HTTP 409 and retain read diagnostics. Moon's current AI
  page reaches Oracle's embedded LocalAI routes through Sage
- `/health`: service health, Docker socket availability, and latest reconcile summary

Moon's `/admin/system/ai` page now reaches Oracle's embedded LocalAI endpoints only through Sage. Warden should keep
its runtime APIs service-authenticated, but its active role for LocalAI is planning the Oracle container mounts,
environment, GPU device requests, and drift detection.

## Raven VPN Runtime

Warden starts the managed Raven container with `--cap-add NET_ADMIN` and `--device /dev/net/tun` by default so Raven can
run OpenVPN when admins enable the PIA-backed VPN setting. Drift detection compares those capability and device bindings
against Docker inspect output and recreates Raven when they disappear. Hosts without TUN support should keep Raven VPN
disabled or set `SCRIPTARR_RAVEN_VPN_RUNTIME_DISABLED=true`; Raven will still boot, but its VPN status reports the
runtime as unsupported and enabled VPN downloads fail closed.

## Multiple Hosts

Set the same `SCRIPTARR_WARDEN_TOPOLOGY` JSON on each participating Warden and set its local
`SCRIPTARR_WARDEN_HOST_ID`. A topology assigns every service to exactly one host. `primaryHostId` identifies the host
that owns Sage and aggregates remote status and updates. Each Warden reconciles only its assigned containers through
its local Docker socket; Docker bridge DNS and sockets are never stretched across servers.
Vault and Raven must remain on Sage's primary host because their service ports stay private to that Docker bridge.
Unsupported remote placements are rejected before container planning.

```json
{
  "primaryHostId": "core",
  "hosts": [
    {
      "id": "core", "address": "192.168.50.6", "agentUrl": "https://192.168.50.6:4401",
      "services": ["scriptarr-mysql", "scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven"]
    },
    {
      "id": "ai", "address": "192.168.50.7", "agentUrl": "https://192.168.50.7:4401",
      "services": ["scriptarr-oracle", "scriptarr-portal"]
    }
  ]
}
```

All `/api/*` routes require `Authorization: Bearer <SCRIPTARR_WARDEN_SERVICE_TOKEN>`, including single-host installs.
Warden injects that token into Sage. Set a strong explicit token in production; the development default is only for
isolated tests. `/health` remains available for local Docker health checks. Keep HTTP port 4001 unpublished.

The separate multi-host HTTPS listener defaults to port 4401. Bind/publish it only on the host LAN address and set
`SCRIPTARR_WARDEN_TLS_CA_FILE`, `SCRIPTARR_WARDEN_TLS_CERT_FILE`, and `SCRIPTARR_WARDEN_TLS_KEY_FILE` to read-only
mounted certificate files. Each host certificate must have its host id as CN, its LAN IP in the subject alternative
name, and client/server authentication usage. The primary uses its own certificate for outbound requests. The
listener requires a CA-trusted client certificate, the configured primary host CN, its configured source IP, and the
control bearer token. A worker cannot issue control requests to the primary or another worker.

`SCRIPTARR_WARDEN_AGENT_PORT` and `SCRIPTARR_WARDEN_AGENT_HOST` override the HTTPS listener bind. The agent URL in
the shared topology must match the published port. Agent requests have bounded response sizes and timeouts
(`SCRIPTARR_WARDEN_AGENT_TIMEOUT_MS`, default 4000, maximum 15000).
Image update checks run as background jobs, so image pulls can continue beyond this short control-request deadline.
Poll `/api/updates` for the job outcome and refreshed image availability; checking does not restart containers.

In this topology Sage port 3004 is published on the core LAN IP, and Portal/Oracle ports 3003/3001 are published on
the AI LAN IP. Restrict those LAN ports to the peer host; Portal and Oracle receive required service authorization.
MySQL and Vault remain private to their owning host. Only Moon belongs behind the public reverse proxy.

The worker also needs `SCRIPTARR_SAGE_BASE_URL=http://192.168.50.6:3004` for its durable update-job broker. Set shared
service tokens consistently on both hosts. Use independent local data roots and mount the full root into each Warden
at its same absolute path. Oracle receives only its local model/data directories. `SCRIPTARR_ORACLE_CPUS=4` and
`SCRIPTARR_ORACLE_MEMORY=8g` add enforced container resource ceilings and drift detection.

The primary's bootstrap lists service ownership, runtime/health expose per-host availability, and update/log requests
route to the service owner. An unavailable worker is reported as degraded without making core reader health fail.
Docker health responses use cached remote availability and refresh it in the background, so a stalled worker cannot
consume the core container's health-check timeout.
Update check/install requests return HTTP 503 with per-host diagnostics when an owner cannot be reached; operations
already accepted by other hosts may still be running. The legacy single-job field prioritizes failures, and each
Warden hydrates its own host-scoped durable update job after restart. Existing unmanaged or foreign-host containers
are never replaced by either ordinary drift reconciliation or forced update actions.
Host assignment changes do not automatically delete containers left behind on another host; preserve/migrate state
and remove obsolete containers deliberately. Standalone installs without a topology keep their existing local plan.

## Raven Ingest Runtime

Raven supports `SCRIPTARR_RAVEN_AVIF_ENCODER=auto|nvenc|cpu`. Auto selects a working encoder by a real encode test;
strict `nvenc` requires hardware AV1 support, and `cpu` uses software AVIF without NVIDIA device/runtime arguments.
CPU mode works on servers whose GPU cannot encode AV1, including P2000-equipped hosts. For household background
ingest, start with `SCRIPTARR_RAVEN_AVIF_ENCODER=cpu`, `SCRIPTARR_RAVEN_INGEST_GPU_PROFILE=cpu`,
`SCRIPTARR_RAVEN_AVIF_THREADS=2`, and one slot/page through `SCRIPTARR_RAVEN_AVIF_ENCODER_SLOTS=1` and
`SCRIPTARR_RAVEN_AVIF_PAGE_CONCURRENCY=1`.

GPU-capable auto/nvenc profiles can use FFmpeg `av1_nvenc`. Explicit runtime env still wins:
`SCRIPTARR_RAVEN_INGEST_GPU_PROFILE=nvidia`, `SCRIPTARR_GPU_HINT=nvidia`, or
the Docker runtime detection make Warden give Raven the same NVIDIA runtime args, `--gpus all`, and env
style used for Oracle GPU planning. Raven also receives the NVIDIA `video` driver capability because FFmpeg NVENC needs
`libnvidia-encode.so.1` in addition to compute/utility access. Explicit `/dev/nvidia*` device binds are opt-in with
`SCRIPTARR_NVIDIA_DEVICE_BINDINGS=true` for hosts that need them. When Warden cannot run `nvidia-smi` from inside its own
container, it also checks Docker's runtime metadata so hosts with the NVIDIA Docker runtime are still detected. A
missing or incompatible NVIDIA runtime makes strict NVENC ingest unavailable; auto can select the software encoder.
Neither case should make Raven's ordinary health endpoint fail solely because GPU encoding is unavailable.

## LocalAI

Oracle embeds the LocalAI runtime in the `scriptarr-oracle` image. Warden mounts the persistent `localai/models` and
`localai/data` folders into Oracle, passes profile-specific runtime flags such as NVIDIA `--gpus all`, and recreates
Oracle when Docker inspect shows the requested GPU runtime or device request is missing. Explicit `/dev/nvidia*` device
bindings are opt-in with `SCRIPTARR_NVIDIA_DEVICE_BINDINGS=true` for hosts that require and expose those paths. Install,
start, remove, and generation probe jobs are Oracle-owned and brokered through Sage. If Oracle lands on an NVIDIA host
with an old CPU-only LocalAI backend cached under `/data/backends`, Oracle rejects that backend and prepares a
GPU-capable runtime instead.
