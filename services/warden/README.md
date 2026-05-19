# Warden

Warden bootstraps Scriptarr, owns the shared internal `scriptarr-network`, parses the URL-first MySQL contract, derives
the Discord callback URL, and selects the appropriate LocalAI AIO image profile for the host hardware.

Warden is also responsible for injecting the internal service topology that keeps first-party HTTP behind Sage. Raven,
Portal, and Oracle now receive Sage broker settings instead of direct first-party base URLs.

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
- `/api/updates/check`: pull-first update check for the managed sibling services
- `/api/updates/install`: asynchronous managed-service install or restart flow for the sibling services
- `/api/localai/*`: legacy standalone LocalAI sidecar controls kept for compatibility only; Moon's current AI page
  reaches Oracle's embedded LocalAI routes through Sage
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

## LocalAI

Oracle embeds the LocalAI runtime in the `scriptarr-oracle` image. Warden mounts the persistent `localai/models` and
`localai/data` folders into Oracle, passes profile-specific runtime flags such as NVIDIA `--gpus all`, and recreates
Oracle when Docker inspect shows the requested GPU device binding is missing. Install, start, remove, and generation
probe jobs are Oracle-owned and brokered through Sage.
