# Scriptarr Server Admin Guide

This guide is for the supported Docker image install path.

## Required First-Boot Environment

- `SUPERUSER_ID`: Discord user id allowed to sign in as the first admin during bootstrap
- `DISCORD_TOKEN`: Discord bot token used by Portal and admin setup surfaces

Recommended environment:

- `SCRIPTARR_PUBLIC_BASE_URL`: public root URL for Moon, for example `https://scriptarr.example.com`
- `SCRIPTARR_DISCORD_CLIENT_ID`: Discord OAuth application client id
- `SCRIPTARR_DISCORD_CLIENT_SECRET`: Discord OAuth application client secret
- `SCRIPTARR_DATA_ROOT`: host path used for persistent stack data
- `SCRIPTARR_MYSQL_URL`: `SELFHOST` for Warden-managed MySQL or `mysql://[user[:password]@]host[:port]/database` for
  an external database
- `SCRIPTARR_MYSQL_USER`: managed MySQL app user, or the username fallback when the external MySQL URL omits one
- `SCRIPTARR_MYSQL_PASSWORD`: password shared by the managed MySQL root and app user, or the password fallback when the
  external MySQL URL omits one

## Docker Helpers

The repo publishes one image per first-party service. Use the root helpers when building or publishing:

- `npm run docker:list`
- `npm run docker:build`
- `npm run docker:push`
- `npm run docker:publish`
- `npm run docker:healthcheck`

Published images use `docker.darkmatterservers.com/the-noona-project/scriptarr-<service>:<tag>`.

## Start Warden

The supported install path is to manually start only `scriptarr-warden`. Do not manually start Moon, Sage, Vault,
Raven, Portal, Oracle, or managed MySQL containers one by one.

Recommended container contract:

- container name: `scriptarr-warden`
- required bind: `/var/run/docker.sock:/var/run/docker.sock`
- required persistent mounts:
  - `<data-root>/warden/logs:/var/log/scriptarr`
  - `<data-root>/warden/runtime:/var/lib/scriptarr`
- recommended Linux/Unraid bind: `<data-root>:<data-root>`
- required env: `SCRIPTARR_DATA_ROOT`, `SUPERUSER_ID`, `DISCORD_TOKEN`, `SCRIPTARR_MYSQL_URL`
- optional env: `SCRIPTARR_PUBLIC_BASE_URL`, Discord OAuth vars, MySQL fallback vars
- normal installs should not publish the Warden port; Moon remains the default public first-party surface

Example shape:

```bash
docker run -d \
  --name scriptarr-warden \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v <data-root>:<data-root> \
  -v <data-root>/warden/logs:/var/log/scriptarr \
  -v <data-root>/warden/runtime:/var/lib/scriptarr \
  -e SCRIPTARR_DATA_ROOT=<data-root> \
  -e SCRIPTARR_PUBLIC_BASE_URL=https://scriptarr.example.com \
  -e SCRIPTARR_MYSQL_URL=SELFHOST \
  -e SUPERUSER_ID=<discord-user-id> \
  -e DISCORD_TOKEN=<discord-bot-token> \
  docker.darkmatterservers.com/the-noona-project/scriptarr-warden:latest
```

If you run Docker Desktop on Windows, `SCRIPTARR_DATA_ROOT` can still be a Windows host path such as
`C:\ScriptarrData`. Warden translates that host path when it reconciles sibling containers from inside its Linux
container.

On Linux and Unraid, binding `<data-root>` back into the Warden container at the same absolute path lets Warden create
the full storage tree directly before it starts the sibling services. Unraid installs can also save this container as a
user template after the first successful boot if you want to reuse the same contract later.

## Install Shape

Warden now boots an almost full Scriptarr stack on first install:

- MySQL
- Vault
- Sage
- Moon
- Raven
- Portal
- Oracle

There is no setup wizard. The stack should reach a minimal usable state with sensible defaults, and the remaining work
is finished in Moon admin. Warden's first-boot logs now call out when it creates, recreates, or auto-pulls the managed
service images so you can follow reconciliation progress from one place. Warden and the managed containers also publish
Docker health checks so Docker Desktop, `docker ps`, and Unraid can show `healthy` once each service finishes booting.

Fresh installs no longer include seeded demo series. Moon's user and admin library views stay empty until Raven has
real imported titles to expose.
Vault now fronts shared MySQL state with its own cache-first broker layer, and first-party service-to-service HTTP is
expected to flow through Sage instead of bypassing the broker topology.
Moon requests and admin add-title now run through one intake flow: search query, enabled metadata providers, enabled
download providers, saved match snapshot, then moderation or immediate queueing depending on who submitted it.
That intake is now grouped by concrete provider target so duplicate metadata rows that land on the same download URL
only create one requestable result, while real separate variants such as plain vs colored editions stay distinct when
the provider exposes different series URLs.
Raven now only marks download work complete after the promoted files also persist into the brokered catalog, and it
rescans the existing `downloaded/<type>/...` tree on boot so already-finished archives can repopulate Moon's library
without forcing a re-download.

## MySQL Contract

Warden is now URL-first for database setup:

- `SCRIPTARR_MYSQL_URL=SELFHOST` means Warden creates `scriptarr-mysql`, stores its data under `SCRIPTARR_DATA_ROOT`,
  and injects the split MySQL env vars required by Vault and the rest of the internal services.
- `SCRIPTARR_MYSQL_URL=mysql://...` means Warden does not manage MySQL. It parses the URL and still derives
  `SCRIPTARR_MYSQL_HOST`, `SCRIPTARR_MYSQL_PORT`, `SCRIPTARR_MYSQL_DATABASE`, `SCRIPTARR_MYSQL_USER`, and
  `SCRIPTARR_MYSQL_PASSWORD` for the managed services.
- `SCRIPTARR_MYSQL_USER` is only used for `SELFHOST` or when the external URL does not include a username.
- `SCRIPTARR_MYSQL_PASSWORD` remains the shared password for the managed root plus app user in `SELFHOST` mode.

## Discord Callback Setup

The first boot contract is Discord-first. Warden and Sage derive the exact callback URL from the configured public base
URL. Use the callback URL surfaced by the stack when configuring the Discord application.

Example callback shape:

`https://your-scriptarr-host.example.com/api/moon/auth/discord/callback`

Moon's bootstrap surface should also show the configured first-owner Discord id before the first claim. If it does not,
double-check that `SUPERUSER_ID` was passed into Warden correctly.
Moon no longer exposes a dev-session claim path, so Discord login is the supported bootstrap and admin sign-in flow.

## Network Topology

Warden manages one shared internal Docker network named `scriptarr-network`.

- Warden attaches itself to `scriptarr-network` after boot so the managed services can reach `http://scriptarr-warden:4001`.
- Vault, Sage, Raven, Portal, Oracle, and managed MySQL stay internal to that network.
- Moon also joins `scriptarr-network`, but it is the only first-party service Warden publishes publicly by default.
- LocalAI joins the same internal network when an admin installs or starts it later from Moon admin.
- Outside the Docker test flow, Warden itself should stay unpublished unless you are doing a deliberate internal debug
  session.
- First-party services should not reach across the stack directly. Sage is the supported internal HTTP broker, with
  direct exceptions limited to Vault -> MySQL, Warden -> Docker or host runtime, Oracle -> OpenAI or LocalAI, and
  Raven -> external source, metadata, or VPN providers.

## LocalAI Behavior

Warden inspects the host and selects a LocalAI AIO image by hardware class:

- NVIDIA: `localai/localai:latest-aio-gpu-nvidia-cuda-12`
- Intel: `localai/localai:latest-aio-gpu-intel`
- AMD: `localai/localai:latest-aio-gpu-hipblas`
- CPU fallback: `localai/localai:latest-aio-cpu`

LocalAI is not installed or started on first boot. Moon admin lets the server admin choose a preset image or custom
override and then manually trigger the install or start flow later. Warden now mounts the persistent LocalAI models and
data folders, passes the matching hardware flags for the selected preset, and waits for LocalAI readiness before it
reports startup success. This can take 5 to 20 minutes depending on the host, and the first AIO warm-up may take a bit
longer. Warden now boots the official AIO images with the Oracle-safe text-generation preload set instead of the full
default AIO bundle so startup does not block on optional speech, image, or other bundled models.

If GPU-specific startup is unavailable, the rest of Scriptarr should stay healthy while AI features remain disabled or
temporarily unavailable.

## Oracle Defaults

- Oracle starts in an off state on install.
- Oracle defaults to provider `openai`.
- Oracle now runs as a FastAPI Python service while keeping the same internal HTTP contract for Sage, Moon, and Portal.
- The OpenAI API key can be entered in Moon admin before Oracle is enabled.
- Admins can later switch Oracle to LocalAI from Moon admin and then manually install or start LocalAI through Warden.
- When the provider is `localai` and no model is set explicitly, Scriptarr falls back to the LocalAI-friendly `gpt-4`
  alias instead of the OpenAI default model name.

## Core Admin Tasks In Moon

- sign in as the first admin through Discord
- verify Discord auth and callback settings
- configure libraries and storage paths
- manage request moderation
- review metadata-first request matches, re-resolve unavailable requests, and approve concrete Raven download targets
- manage the Discord bot workflow in `/admin/discord`, including guild id, onboarding channel or template, DM
  superuser id, and per-command role mapping
- configure Raven VPN credentials and region for PIA/OpenVPN-backed downloads
- review Raven metadata providers, with MangaDex enabled by default
- review Raven download providers, with WeebCentral enabled by default
- set the Moon site name branding that powers headers, document titles, and install metadata
- manage the trusted public Moon automation API from `/admin/system/api`, including enable state, admin key rotation,
  and Swagger/OpenAPI links
- check or install managed Scriptarr service updates from `/admin/system/updates`
- configure Oracle and optional LocalAI runtime settings
- manage users, roles, and permissions
- inspect Warden service health and runtime config

## Moon Route Model

Moon now serves two distinct programs from one runtime:

- the forward-facing user app at `/`
- the admin app at `/admin`

Common user routes:

- `/browse`
- `/library/<type>`
- `/title/<type>/<titleId>`
- `/reader/<type>/<titleId>/<chapterId>`
- `/myrequests`
- `/following`

Moon still accepts the older untyped `/title/<id>` and `/reader/<titleId>/<chapterId>` paths as compatibility shims,
but the typed routes are the canonical links Moon now emits.

Moon's user app also serves a same-origin `manifest.webmanifest` and `service-worker.js` so the reader can be
installed like an app and keep a rolling cache of recently opened chapters on the current device.

Common admin routes:

- `/admin/library`
- `/admin/add`
- `/admin/import`
- `/admin/calendar`
- `/admin/mediamanagement`
- `/admin/activity/*`
- `/admin/wanted/*`
- `/admin/requests`
- `/admin/users`
- `/admin/settings`
- `/admin/discord`
- `/admin/system/*`

Legacy Moon paths such as `/downloads`, `/settings`, and `/setupwizard` now redirect into the new admin routes.

## Discord Bot Workflow

Moon admin now owns the Discord workflow settings that Portal uses at runtime:

- guild id for slash-command scoping
- DM superuser id for the private `downloadall` command
- onboarding channel id and message template
- per-command enable toggles and required Discord role ids

The current Discord command set is:

- `/ding`
- `/status`
- `/chat`
- `/search`
- `/request`
- `/subscribe`
- DM-only `downloadall`

Blank role ids mean any member in the configured guild can use that slash command. `downloadall` ignores guild roles
and only checks the configured DM superuser id.
`downloadall` now bulk-browses the provider first, then metadata-resolves each matched title before queueing it. Only
titles with one confident metadata match are queued. Portal's DM summary now breaks skipped titles out as already
active, no-metadata, ambiguous-metadata, or failed instead of silently queueing metadata-less library entries.
Portal also sends requester DMs when a moderated request is approved, denied, or finishes downloading, and dedupes
those notifications by request id plus decision state so retries and restarts do not spam Discord.
Portal now prefers a minimal Discord runtime when privileged intents are unavailable. Slash commands and DM handling
can stay online while onboarding is marked degraded, and `/admin/discord` will show the last meaningful runtime or
command-sync error instead of only a generic disconnected state.

## Public Moon API

Moon now serves a trusted automation API and same-origin Swagger docs:

- docs: `/api/public/docs`
- raw OpenAPI: `/api/public/openapi.json`
- search: `GET /api/public/v1/search?q=...`
- create request: `POST /api/public/v1/requests`
- request status: `GET /api/public/v1/requests/<requestId>`

Search is public. Create and status calls require `X-Scriptarr-Api-Key`, which Moon admin now manages from
`/admin/system/api`. Scriptarr stores only the hashed form of that key in Vault and only reveals the plaintext value
when the admin generates or regenerates it.

External API requests are intended for trusted automation. Scriptarr rejects them when the selected result is NSFW,
already present in the library, already pending or running, or lacks an enabled download target. Accepted external API
requests enter Raven at the lowest priority behind the normal browser and Discord request flows.

## Storage Layout

Recommended data folders under `SCRIPTARR_DATA_ROOT`:

- `mysql/data/`
- `vault/logs/`
- `sage/logs/`
- `moon/logs/`
- `portal/logs/`
- `oracle/logs/`
- `raven/downloads/`
- `raven/logs/`
- `localai/data/`
- `localai/models/`
- `localai/logs/`
- `warden/logs/`
- `warden/runtime/`

Warden's own container mounts are:

- `warden/logs -> /var/log/scriptarr`
- `warden/runtime -> /var/lib/scriptarr`

Raven's download tree now uses a two-stage layout under `raven/downloads/`:

- `downloading/<type-slug>/<title-folder>/...` for active or incomplete work
- `downloaded/<type-slug>/<title-folder>/...` for completed promoted library content

Raven also supports internal chapter and page naming templates through the brokered `raven.naming` setting. This pass
keeps title-folder naming unchanged so rescans remain compatible with the current library model.
Moon now exposes those controls at `/admin/mediamanagement`, with one fallback profile plus per-type naming profiles
for manga, manhwa, manhua, webtoon, comic, and OEL downloads. The saved formats apply to new Raven downloads and to
archive rescans so Moon, Raven, and the on-disk layout stay aligned.
Request records now persist the original search query, selected metadata snapshot, selected download snapshot, and any
linked Raven job or task ids so Moon admin can moderate or retry the exact saved target later.
Vault now also stores a durable request work key derived from the concrete download target when one exists, or from the
metadata identity when no download match exists yet, and active duplicate work keys are rejected.

Moon admin library and calendar are now denser operational views:

- `/admin/library` uses a Sonarr-inspired series index with search, type and status filters, latest chapter, last
  release date, file coverage, metadata state, and source or open actions in one table.
- `/admin/calendar` uses Raven chapter release dates captured from source scrapes plus metadata enrichment to render a
  month or agenda view for tracked chapter releases. Older titles may need a rescan before they show dated entries.

## Docker Test Workflow

The repo ships a Docker-backed end-to-end validation flow:

- `npm run docker:test`
- `npm run docker:test:teardown`

The test stack uses:

- `SELFHOST` MySQL by default
- an isolated suffixed Scriptarr network
- a temporary data root unless you override it
- a containerized Warden that reconciles the rest of the Docker-managed Scriptarr services
- Warden published to a host port only in test mode so the helper can poll health and report status
- Moon exposed on a dedicated test port so you can hit browser or API flows safely

## Recovery Notes

- If the first admin cannot sign in during bootstrap, confirm the Discord user id matches `SUPERUSER_ID`.
- If Moon shows Discord auth as incomplete, re-check the public base URL and callback URL in the Discord developer
  portal.
- If Oracle is off, confirm the chosen provider and credentials in Moon admin before treating the rest of the stack as
  unhealthy.
- If LocalAI actions are slow, let the Moon admin job continue instead of retrying immediately; the initial pull and
  startup are intentionally long-running.
- If Raven VPN is enabled, failed settings reads or failed tunnel startup now block downloads instead of silently
  falling back to direct traffic. Fix the VPN settings first, then retry the job.
- If the Docker test stack is already running, tear it down with `npm run docker:test:teardown` before starting a new
  isolated run with the same stack id.
