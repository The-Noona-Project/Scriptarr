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

Use `SCRIPTARR_<SERVICE>_DNS_SERVERS` to give one managed service an ordered list of reachable resolver IP addresses.
Comma-separated values or a JSON array are accepted. Leave it unset to retain Docker's DNS defaults; an explicit `[]`
restores inherited DNS after a prior override. Warden recreates only the service with changed DNS. Docker network
aliases stay available. Choose resolvers reachable through that service's VPN when a VPN is enabled; this setting
does not change host DNS, VPN routes, or other services.

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
Multi-host planning rejects missing or development-default service tokens for every first-party service.

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
Conflicting checks/installs return HTTP `409` while another update operation is running; retry after that job finishes.

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
already accepted by other hosts may still be running. The legacy single-job field prioritizes active jobs so polling
continues; failures remain available in the host/job lists. Each
Warden hydrates its own host-scoped durable update job after restart. Existing unmanaged or foreign-host containers
are never replaced by either ordinary drift reconciliation or forced update actions.
Host assignment changes do not automatically delete containers left behind on another host; preserve/migrate state
and remove obsolete containers deliberately. Standalone installs without a topology keep their existing local plan.

## Raven Ingest Runtime

New reader pages use CPU WebP at quality 85/method 4. Existing AVIF remains readable during migration. Legacy AVIF/GPU
settings no longer grant Raven NVIDIA devices or change new output; Oracle's independent GPU/model settings remain
unchanged. Download-title concurrency remains Sage-owned, separately from encoding capacity.
Warden always marks its WebP coordinator as remote-required, including when no worker is assigned. Conversion waits
for worker capacity instead of falling back to local AVIF or encoding on Plex. The compatibility AVIF encoder setting
inside the managed container is normalized to `cpu`; saved deployment settings and existing AVIF files are retained.

To offload encoding, add optional service `scriptarr-raven-worker` to the remote host's topology list. Keep
`scriptarr-raven` beside Sage/Vault on the primary host. Warden runs the worker from the same Raven artifact in
`ingest-worker` role, without provider, downloader, VPN, catalog or reader startup. `SCRIPTARR_RAVEN_WORKER_IMAGE`
can independently pin that artifact; it otherwise inherits the coordinator image. It has no public port, canonical
download mount, Docker socket, GPU access or VPN capability.

Worker CPU/memory limits are fixed at 2 CPUs and 4 GiB, with a 4 GiB combined memory/swap ceiling. Its JVM heap is 1536 MiB to retain
encoder/native headroom. Encoding uses one chapter job, one page at a time and two threads. Only `raven-worker/scratch`
and `raven-worker/logs` are writable mounts. Missing worker capacity waits without enabling Plex encoding; reader
services remain available. A matching unhealthy worker is reported rather than repeatedly recreated.
An unassigned or unhealthy worker sets `ingestDegraded` without failing the platform health check.

Configure these values consistently on both Wardens before enabling its topology placement:

- `SCRIPTARR_RAVEN_WORKER_SERVICE_TOKEN`: a dedicated credential different from every existing service token.
- `SCRIPTARR_RAVEN_WORKER_SAGE_BASE_URL=https://192.168.50.6:3444`: HTTPS on the primary topology address.
- `SCRIPTARR_RAVEN_WORKER_CA_FILE`: absolute host path to the trusted CA certificate (`.crt`/`.pem`). Only this exact
  file is mounted read-only into the worker at `/app/worker-tls/ca.crt`.
- `SCRIPTARR_SAGE_WORKER_TLS_CERT_FILE` and `SCRIPTARR_SAGE_WORKER_TLS_KEY_FILE`: absolute host paths to a dedicated
  Sage leaf certificate/key. Mounts into Sage are read-only exact files, not the Warden TLS directory or private key.
- `SCRIPTARR_SAGE_WORKER_TLS_PORT`: optional listener override, default 3444; it must match the worker URL.

Issue the dedicated Sage certificate with the primary IP in its SAN. Restrict the new LAN port to the worker host;
normal Sage HTTP 3004, Portal and Oracle URLs remain unchanged. The worker token appears only in Sage's token map,
whose worker routes enforce lease/ownership permissions. Warden's existing control-plane mTLS is separate.

## LocalAI

Oracle embeds the LocalAI runtime in the `scriptarr-oracle` image. Warden mounts the persistent `localai/models` and
`localai/data` folders into Oracle, passes profile-specific runtime flags such as NVIDIA `--gpus all`, and recreates
Oracle when Docker inspect shows the requested GPU runtime or device request is missing. Explicit `/dev/nvidia*` device
bindings are opt-in with `SCRIPTARR_NVIDIA_DEVICE_BINDINGS=true` for hosts that require and expose those paths. Install,
start, remove, and generation probe jobs are Oracle-owned and brokered through Sage. If Oracle lands on an NVIDIA host
with an old CPU-only LocalAI backend cached under `/data/backends`, Oracle rejects that backend and prepares a
GPU-capable runtime instead.
