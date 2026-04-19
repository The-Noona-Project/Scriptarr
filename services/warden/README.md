# Warden

Warden bootstraps Scriptarr, owns the shared internal `scriptarr-network`, parses the URL-first MySQL contract, derives
the Discord callback URL, and selects the appropriate LocalAI image profile for the host hardware.

Warden no longer pulls or starts LocalAI on first boot. It exposes manual LocalAI configuration, install, and start
actions so Moon admin can opt into the slower AI setup later.

The supported database inputs are:

- `SCRIPTARR_MYSQL_URL=SELFHOST`
- `SCRIPTARR_MYSQL_URL=mysql://[user[:password]@]host[:port]/database`
- `SCRIPTARR_MYSQL_USER` for the managed app user or as the username fallback when the URL omits one

Warden also ships the Docker-backed test stack used by repo contributors:

- `npm run docker:test`
- `npm run docker:test:teardown`
