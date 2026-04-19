# Warden

Warden bootstraps Scriptarr, owns the shared internal `scriptarr-network`, parses the URL-first MySQL contract, derives
the Discord callback URL, and selects the appropriate LocalAI image profile for the host hardware.

The supported install shape is to run Warden as its own Docker container and let it reconcile the other first-party
containers through the Docker socket. Outside test mode, Warden should not be published publicly; Moon remains the
default public first-party surface.

Warden no longer pulls or starts LocalAI on first boot. It exposes manual LocalAI configuration, install, and start
actions so Moon admin can opt into the slower AI setup later.

The supported database inputs are:

- `SCRIPTARR_MYSQL_URL=SELFHOST`
- `SCRIPTARR_MYSQL_URL=mysql://[user[:password]@]host[:port]/database`
- `SCRIPTARR_MYSQL_USER` for the managed app user or as the username fallback when the URL omits one

Warden also ships the Docker-backed test stack used by repo contributors:

- `npm run docker:test`
- `npm run docker:test:teardown`

## Container Contract

- default container name: `scriptarr-warden`
- required bind: `/var/run/docker.sock:/var/run/docker.sock`
- required persistent folders:
  - `warden/logs -> /var/log/scriptarr`
  - `warden/runtime -> /var/lib/scriptarr`
- supported runtime: start Warden, let Warden create and reconcile Moon, Vault, Sage, Raven, Portal, Oracle, and
  optional managed MySQL
- test runtime: `npm run docker:test` starts a containerized Warden first and only publishes the Warden API so the
  helper can verify health

## Runtime APIs

- `/api/bootstrap`: static service plan, install mode, callback URL, and storage contract
- `/api/runtime`: Warden self status plus live managed-service runtime details
- `/health`: service health, Docker socket availability, and latest reconcile summary
