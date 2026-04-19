# Warden

Warden bootstraps Scriptarr, owns the shared internal `scriptarr-network`, parses the URL-first MySQL contract, derives
the Discord callback URL, and selects the appropriate LocalAI AIO image profile for the host hardware.

Warden is also responsible for injecting the internal service topology that keeps first-party HTTP behind Sage. Raven,
Portal, and Oracle now receive Sage broker settings instead of direct first-party base URLs.

The supported install shape is to run Warden as its own Docker container and let it reconcile the other first-party
containers through the Docker socket. Outside test mode, Warden should not be published publicly; Moon remains the
default public first-party surface.

Warden no longer pulls or starts LocalAI on first boot. It exposes manual LocalAI configuration, install, and start
actions so Moon admin can opt into the slower AI setup later. Warden treats Sage's Oracle settings as the authoritative
LocalAI selection, caches the last Sage-synced profile in its runtime directory, reloads that selection on boot and
before LocalAI lifecycle actions, and waits for LocalAI readiness before reporting a successful start.

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
- `/api/updates`: current managed-service image state plus the latest broker-backed update job snapshot
- `/api/updates/check`: pull-first update check for the managed sibling services
- `/api/updates/install`: asynchronous managed-service install or restart flow for the sibling services
- `/api/localai/*`: manual LocalAI AIO selection, install, status, and readiness-gated start
- `/health`: service health, Docker socket availability, and latest reconcile summary

## LocalAI

Warden ships four LocalAI AIO presets:

- `cpu -> localai/localai:latest-aio-cpu`
- `nvidia -> localai/localai:latest-aio-gpu-nvidia-cuda-12`
- `amd -> localai/localai:latest-aio-gpu-hipblas`
- `intel -> localai/localai:latest-aio-gpu-intel`

When admins start LocalAI, Warden applies the matching runtime flags for the selected preset, mounts the persistent
`localai/models` and `localai/data` folders, and waits for `GET /readyz` with `GET /v1/models` as a fallback before it
reports the container as ready. Warden also constrains the AIO `MODELS` preload set to the Oracle-safe
`text-to-text.yaml` profile for the selected hardware so the official AIO image boots reliably instead of hanging on
optional bundled speech or media models.
