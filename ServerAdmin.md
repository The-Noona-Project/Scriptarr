# Scriptarr Server Admin Guide

## Bulk download interruption recovery

Use the same `/downloadall continue runid:<id>` run after a broker interruption. Preserve its canonical CBZs,
ready reader pages and durable task history; a content reset is unnecessary. The queue and Noona summary show
late outcomes even while the run is paused. Paused reconciliation observes accepted work without approving
another execution, and Noona edits its accepted pause message instead of generating duplicate prompts.

Sage uses an explicitly pinned outbound HTTP client to avoid the bundled Node paused-parser socket-close crash.
Raven's idempotent checkpoint transport waits up to two minutes for transient broker outages. Authentication,
ownership and validation rejections do not enter that recovery loop. Worker recovery remains fenced by its lease.
After recovery is exhausted, investigate the specific task or conversion stage before continuing unresolved work.

Only a validated source page explicitly reporting unavailability, without chapter links or a full-list control,
qualifies for the separately reported unavailable-source skip. Network errors, challenges, rate limits and empty
lists without that evidence stay unresolved. Completion requires all accepted title work to pass archive, catalog
and WebP readiness verification, with policy skips counted separately.

This guide is for the supported Docker image install path.

## Required First-Boot Environment

- `SUPERUSER_ID`: Discord user id allowed to sign in as the first admin during bootstrap
- `DISCORD_TOKEN`: Discord bot token used by Portal and admin setup surfaces

Recommended environment:

- `SCRIPTARR_PUBLIC_BASE_URL`: public root URL for Moon, for example `https://scriptarr.example.com`
- `SCRIPTARR_DISCORD_CLIENT_ID`: Discord OAuth application client id
- `SCRIPTARR_DISCORD_CLIENT_SECRET`: Discord OAuth application client secret
- `SCRIPTARR_APPA_DISCORD_TOKEN`: optional second Discord bot token for Appa, the admin/reviewer identity
- `SCRIPTARR_APPA_DISCORD_CLIENT_ID`: optional Discord application client id for Appa
- `SCRIPTARR_DATA_ROOT`: host path used for persistent stack data
- `SCRIPTARR_MYSQL_URL`: `SELFHOST` for Warden-managed MySQL or `mysql://[user[:password]@]host[:port]/database` for
  an external database
- `SCRIPTARR_MYSQL_USER`: managed MySQL app user, or the username fallback when the external MySQL URL omits one
- `SCRIPTARR_MYSQL_PASSWORD`: password shared by the managed MySQL root and app user, or the password fallback when the
  external MySQL URL omits one
- `SCRIPTARR_DISCORD_UPDATE_CHANNEL_ID`: optional default Discord channel for Noona GitHub update summaries
- `SCRIPTARR_GITHUB_TOKEN`: optional GitHub API token for higher update-check rate limits; Scriptarr never stores it
  in Vault or posts it to Discord

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
- optional env: `SCRIPTARR_PUBLIC_BASE_URL`, Discord OAuth vars, Appa Discord vars, MySQL fallback vars
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
Warden also mounts Moon's derived browser asset folders from this tree, including `moon/cover-cache` and
`moon/reader-page-cache`, so successful revisioned reader pages can survive Moon container replacements.
The reader route also bootstraps the signed-in user's first session and page chunk through Moon on the server before
hydration, so reloads should show real reader content instead of waiting on an empty shell.

## Install Shape

### Distributed placement and authenticated agents

The default remains a single-host installation. Distributed mode uses one local Warden per participating application
host and one shared `SCRIPTARR_WARDEN_TOPOLOGY` JSON value. Each Warden sets its own `SCRIPTARR_WARDEN_HOST_ID`,
reconciles only the assigned services, and leaves containers on other hosts alone. The primary aggregates runtime
status and forwards update requests to the owning host. A remote host outage must not prevent the core host from
serving the reader.

Example placement:

```json
{
  "primaryHostId": "core",
  "hosts": [
    {
      "id": "core",
      "address": "192.168.50.6",
      "agentUrl": "https://192.168.50.6:4401",
      "services": ["scriptarr-mysql", "scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven"]
    },
    {
      "id": "ai",
      "address": "192.168.50.7",
      "agentUrl": "https://192.168.50.7:4401",
      "services": ["scriptarr-oracle", "scriptarr-portal"]
    }
  ]
}
```

Both hosts receive the same topology. Keep Warden's HTTP port `4001` on its local Docker bridge; `/api` requests use
`SCRIPTARR_WARDEN_SERVICE_TOKEN`. The separate agent listener uses TLS certificates from
`SCRIPTARR_WARDEN_TLS_CA_FILE`, `SCRIPTARR_WARDEN_TLS_CERT_FILE`, and `SCRIPTARR_WARDEN_TLS_KEY_FILE`. Certificates
must contain the host id as the subject common name and the host address as an IP subject alternative name. The
worker accepts only the primary's trusted certificate and configured peer address. Bind the agent port `4401` to
the intended host address and restrict it to the primary. Never publish an unauthenticated Docker API.
Provide explicit non-development tokens for Warden, Vault, Sage, Moon, Raven, Portal, and Oracle on both hosts;
multi-host planning refuses missing or known development defaults. Oracle also refuses a development token when its
service-authentication requirement is enabled directly.

The core publishes Sage `3004` to the private LAN for Portal/Oracle calls. The AI host publishes Portal `3003` and
Oracle `3001` only for the core host. These APIs require service bearer tokens in distributed mode. MySQL and Vault
remain on the core's local Docker network. Only Moon is a public first-party surface. Each service keeps local
storage: core database/library/caches on the core host; Oracle models/runtime on the AI host.
Topology validation requires Vault and Raven to share Sage's primary host. Warden image checks return an asynchronous
job (HTTP `202`); poll the updates endpoint for results while image transfers continue in the background.
An install submitted during a check receives HTTP `409`; retry it once the check completes.

For the example AI host, start with `SCRIPTARR_ORACLE_CPUS=4`, `SCRIPTARR_ORACLE_MEMORY=8g`, one quantized model fitting
the available VRAM, a 4096-token context, and `SCRIPTARR_ORACLE_MAX_CONCURRENT_GENERATIONS=1`. Resource limits are
initial budgets; verify them alongside existing game and CI workloads. Oracle's embedded LocalAI readiness gate
still requires an installed model and a successful generation probe.

With a topology configured, manage LocalAI through Oracle's embedded runtime in Moon admin. Warden's legacy
standalone LocalAI configuration, install, start, and remove controls return HTTP `409`; they cannot create a sidecar
outside the declared service ownership. Read-only diagnostics and legacy single-host controls remain available.

### WebP coordinator and ingestion worker

Keep the Raven coordinator on the storage host. Warden can place the optional `scriptarr-raven-worker` on a separate
host using the same immutable Raven image with the `ingest-worker` role. Worker mode does not restore downloads, scan
the library, run a VPN, or publish catalog entries. It receives chapter jobs through Sage and uses its own scratch
storage; only the coordinator validates and publishes the resulting reader pages.

The initial worker uses two CPU cores, 4 GiB of memory, two encoding threads, one chapter job, and one page at a time.
The conversion pool grants only one encoding lease at once. New output is WebP quality 85/method 4. GPU access is not
required, and Oracle's GPU/model settings are independent. Keep the existing six-title download limit unchanged.
`/admin/ingest` shows worker readiness, queued conversions, active encoding and results awaiting publication. Jobs
wait durably when the worker is unavailable. Warden-managed WebP requires a worker even when none is assigned;
it reports degraded ingestion while core platform health remains available, and never falls back to storage-host encoding.

Workers use a dedicated restricted service token and a verified HTTPS Sage URL. The optional worker-only Sage listener
defaults to port 3444 and accepts the worker protocol only. Supply a dedicated server certificate/key using
`SCRIPTARR_SAGE_WORKER_TLS_CERT_FILE` and `SCRIPTARR_SAGE_WORKER_TLS_KEY_FILE`, and mount only the trusted CA file into
the worker using `SCRIPTARR_RAVEN_WORKER_CA_FILE`. Existing Sage HTTP port 3004 and existing service/TLS settings remain
unchanged. Never disable certificate verification or share the coordinator token with a worker.
Apply the current `scripts/deployment/lan-policy.sh core` policy before publishing the new listener: TCP 3444 on the
primary LAN address accepts only the assigned worker host. The existing 3004 and 4401 rules remain in place; the
worker publishes no inbound port.
Chapter and result transfers have a 15-minute window; control requests retain their shorter two-minute limit.
New conversions bind their frozen page order into both job identity and reader revision. If changed page naming
settings change that order, a requested conversion creates separate output; existing saved revisions remain readable.

WebP's dimension limit is handled by lossless geometric segmentation, not shrinking text: oversized images become
ordered WebP tiles, with the original logical page index retained for bookmarks and reading progress. All tiles must
be validated before a page becomes ready. The first-page cover fallback uses a thumbnail of the full logical page.
Single, double, and manga-double layouts fit segmented pages while preserving their source proportions.
Existing AVIF chapters remain readable while low-priority migration jobs rebuild WebP from canonical CBZs. A missing
or invalid CBZ needs repair; converting an already-lossy AVIF file is not a substitute for the original archive.
Remote WebP migration starts disabled when there is no saved migration intent, so an initial deployment can finish
scoped cleanup first. Warden-authenticated POSTs to Sage's
`/api/internal/warden/raven/webp-migration/{start,pause,resume,retry,status}` control and inspect the durable migration.
Start or resume only after cleanup; fresh downloads and user work take priority over migration between chapter jobs.
Pausing retains canonical archives, readable revisions, and recorded outcomes.
Whole-library scheduling requires a complete canonical catalog snapshot. An unavailable or malformed catalog fails
preparation instead of reporting an empty or partial library as complete; recover the catalog before retrying.
Migration avoids rehashing unchanged earlier chapters after each yield. Completion requires a fresh full check of
canonical archives and reader files; restarts rebuild verification, and missing or corrupt content cannot be skipped.

### Legacy software AVIF compatibility

These settings apply to explicit legacy AVIF mode. Warden-managed deployments use the remote WebP policy above.
Use `SCRIPTARR_RAVEN_AVIF_ENCODER=cpu` on a host whose GPU does not encode AV1. `auto` tests usable NVIDIA AV1 encoding
before choosing software; `nvenc` is strict and does not silently fall back. CPU mode does not require NVIDIA devices
or driver capabilities. Start with `SCRIPTARR_RAVEN_AVIF_ENCODER_SLOTS=1`,
`SCRIPTARR_RAVEN_AVIF_PAGE_CONCURRENCY=1`, and `SCRIPTARR_RAVEN_AVIF_THREADS=2`.

The Raven image must include the software AV1 encoder and AVIF muxer and pass a real encode/decode check. Encoder
selection affects background ingest speed, not a separate encoding operation per reader. Existing AVIF files remain
readable, and changing the encoder must not trigger an immediate whole-library rebuild.

### Migrating and preserving an existing installation

Before replacing an older split-host installation, preserve its stopped MySQL datadir, private deployment settings,
container metadata, and image references. Start an isolated copy with the matching MySQL version and test the new
Vault schema against that copy. Set `SCRIPTARR_MYSQL_DATABASE` to the preserved schema name when it differs from the
default. Do not infer compatibility from image version numbers or reuse old worker environment flags as a topology.

Keep encrypted database/configuration recovery points and canonical CBZ backups on a different host. The operations
helpers under `scripts/operations` support verified recovery data and independent monitoring. Retain seven daily and
four weekly recovery points and test restoration in an isolated environment. A second host holding backups is recovery
capacity, not automatic database failover; keep one writable production MySQL instance.

The sender reuses one private SSH connection per backup run so large libraries do not trip the receiver's
new-connection rate limit. Preserve the pinned host key, dedicated sender identity and firewall rules; a failed
upload should be diagnosed instead of weakening those protections.

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

Fresh installs no longer include seeded demo series. Scriptarr's user and admin library views stay empty until the
library importer has real titles to expose.
Vault now fronts shared MySQL state with its own cache-first broker layer, and first-party service-to-service HTTP is
expected to flow through Sage instead of bypassing the broker topology.
Scriptarr also bounds long-running background work across the managed services. Under stalled upstreams or very busy
admin, reader, Discord, AI, Docker, or downloader flows, services should cancel stale requests, close streams, evict old
cache or job entries, and surface normal timeout or retry states instead of growing memory indefinitely.
Moon requests and admin add-title now run through one intake flow: search query, enabled metadata providers, saved
metadata snapshot, then either admin source approval or immediate queueing depending on who submitted it.
That intake is now grouped by concrete provider target so duplicate metadata rows that land on the same download URL
only create one requestable result, while real separate variants such as plain vs colored editions stay distinct when
the provider exposes different series URLs.
Web request creation now lives in `/myrequests` as an inline wizard. Readers pick an exact metadata match,
review the upstream metadata site if needed, optionally leave notes, and submit a moderated full-title request.
Admins then choose the concrete download-provider target from `/admin/requests`, unless the optional `Auto approve and
download` setting lets Sage queue one high-confidence source automatically. If no source exists yet, Sage stores the
request as `unavailable`, re-checks it every 4 hours, DMs the requester when the title moves back into admin review,
and expires it after 90 days if it still cannot be matched.
Moon admin `/admin/users` now owns access control too. The bootstrap owner stays protected outside normal edits, while
all other staff access is group-based: reusable permission groups with per-route-family `read`, `write`, or `root`
grants plus baseline user capabilities. New and returning Discord users land in the current default onboarding group,
and admin activity now comes from one shared durable event log instead of page-local summaries.
Raven now only marks download work complete after the promoted files also persist into the brokered catalog, and it
rescans the existing `downloaded/<type>/...` tree on boot so already-finished archives can repopulate Moon's library
without forcing a re-download. Startup recovery reads one complete catalog snapshot in the background and skips unchanged
folders rather than repeating full-catalog reads for each folder. Browser and backlog lists remain compact. Raven and Vault also share a
logical catalog identity of library type plus normalized title, so downloads, imports, rescans, and ingest setup reuse
the existing canonical title instead of creating a new visible row. Startup scans also match each saved canonical path
before the display name, so a metadata rename keeps the original title and chapter identities. Vault keeps existing
raw catalog IDs authoritative over retained aliases or a matching display name on another title; an
alias whose original row was removed still redirects normally. No alias or reading-history rows are rewritten by this rule.
Background scanning retains only a small identity index from that snapshot; display-name-deduplicated cards are insufficient to detect all
folder owners. If multiple titles claim one path, Raven leaves them and
their files untouched, records a failed rescan with recovery diagnostics, and continues scanning unrelated folders.
Resolve that ownership conflict before retrying the scan; it is not a reason to delete or merge records automatically.
Raven's WeebCentral chapter scraper now follows the live source's HTMX full-chapter-list flow for long-running
series, which is required for titles such as Tomb Raider King that hide older chapters behind a show-all request.

## MySQL Contract

Warden is now URL-first for database setup:

- `SCRIPTARR_MYSQL_URL=SELFHOST` means Warden creates `scriptarr-mysql`, stores its data under `SCRIPTARR_DATA_ROOT`,
  and injects the split MySQL env vars required by Vault and the rest of the internal services.
- `SCRIPTARR_MYSQL_URL=mysql://...` means Warden does not manage MySQL. It parses the URL and still derives
  `SCRIPTARR_MYSQL_HOST`, `SCRIPTARR_MYSQL_PORT`, `SCRIPTARR_MYSQL_DATABASE`, `SCRIPTARR_MYSQL_USER`, and
  `SCRIPTARR_MYSQL_PASSWORD` for the managed services.
- `SCRIPTARR_MYSQL_USER` is only used for `SELFHOST` or when the external URL does not include a username.
- `SCRIPTARR_MYSQL_PASSWORD` remains the shared password for the managed root plus app user in `SELFHOST` mode.
Vault creates the auth/session indexes it needs on both new and existing databases, including session creation-time
indexes and the user role index used by bootstrap/admin flows. Expired sessions are checked during token lookup but are
deleted by Vault's startup and periodic pruning pass, keeping warm auth checks on the indexed token path.
Vault also keeps external MySQL pools warm with a guarded health probe (`SCRIPTARR_MYSQL_KEEPALIVE_INTERVAL_MS`,
default `45000`; set `0` to disable) and logs slow `health` or settings reads when they exceed
`SCRIPTARR_VAULT_SLOW_STORE_OPERATION_MS` (default `2000`). The keepalive skips overlapping probes so a stalled cold
connection does not create its own backlog.

## Discord Callback Setup

The first boot contract is Discord-first. Warden and Sage derive the exact callback URL from the configured public base
URL. Use the callback URL surfaced by the stack when configuring the Discord application.

Example callback shape:

`https://your-scriptarr-host.example.com/api/moon/auth/discord/callback`

Scriptarr's browser bootstrap surface shows first-owner setup readiness before the first claim without exposing the raw
owner Discord id. If first-owner setup does not appear ready, double-check that `SUPERUSER_ID` was passed into Warden
correctly.
Scriptarr no longer exposes a dev-session claim path, so Discord login is the supported bootstrap and admin sign-in
flow. When login starts from a same-origin Scriptarr page, Scriptarr now remembers that route and returns the user there
after Discord OAuth completes. If the original route is missing, invalid, or no longer allowed for the signed-in user,
Scriptarr falls back to the user home page at `/`.
Signed-out user, reader, and admin HTML navigations redirect to `/login?returnTo=...`. The dedicated login page renders
the Discord action immediately, then calls Moon's same-origin `/api/moon/auth/discord/start?returnTo=...` route so the
OAuth state cookie and Discord redirect do not wait for the broader chrome bootstrap. Discord returns to Moon's callback
loader at `/api/moon/auth/discord/callback`; that loader removes the OAuth query from the address bar, calls
`POST /api/moon/auth/discord/complete` same-origin, and then redirects to the sanitized target after Moon sets the
HttpOnly session cookie. After Discord returns to `/login?prepare=1`, Moon runs a two-second-capped warmup only for the
exact safe user payload the target needs: home for `/`, the returned catalogue URL for `/library` or `/browse`, and
profile data for `/profile`; admin and reader return targets skip that user warmup so staff or readers land on their
target first. The login page and the user, reader, and admin client shells repeat this rule for
stale service-worker navigations or client-side transitions, replacing signed-out protected pages with `/login`
instead of showing in-app sign-in fallback panels. If the auth broker is temporarily slow, Moon keeps any already-known
signed-in chrome visible, retries bootstrap with bounded backoff, and shows a delayed-session state only when there is
no trusted signed-in chrome to render; `/login` also retries that delayed chrome check instead of offering a second
Discord login button after a successful callback. Sage keeps the callback bounded and diagnosable with phase-level
timings for Discord token exchange, Discord profile lookup, Vault bootstrap, existing-user lookup, profile refresh,
Vault session creation, and auth-event persistence. Existing users create sessions from the already-loaded Vault user;
their Discord username/avatar refresh runs fail-soft after the session exists. First-owner claim and new auto-provision
still block until Vault has created durable user state. Warden now passes Sage an explicit
`SCRIPTARR_VAULT_AUTH_TIMEOUT_MS` value, defaulting to `8000` ms, so cold Vault/MySQL auth reads have a wider production
budget than the old 3-second fallback.

## Network Topology

Warden manages one shared internal Docker network named `scriptarr-network`.

- Warden attaches itself to `scriptarr-network` after boot so the managed services can reach `http://scriptarr-warden:4001`.
- Vault, Sage, Raven, Portal, Oracle, and managed MySQL stay internal to that network.
- Moon also joins `scriptarr-network`, but it is the only first-party service Warden publishes publicly by default.
- Embedded LocalAI runs inside `scriptarr-oracle` when an admin enables it later from Moon admin; there is no
  standalone LocalAI sidecar in the default runtime plan.
- Outside the Docker test flow, Warden itself should stay unpublished unless you are doing a deliberate internal debug
  session.
- First-party services should not reach across the stack directly. Sage is the supported internal HTTP broker, with
  direct exceptions limited to Vault -> MySQL, Warden -> Docker or host runtime, Oracle -> OpenAI or LocalAI, and
  Raven -> external source, metadata, or VPN providers.

## LocalAI Behavior

LocalAI is not installed or started on first boot. When an admin selects LocalAI, Oracle starts its embedded
OpenAI-compatible LocalAI runtime inside `scriptarr-oracle`; the default model is
`Hermes-3-Llama-3.1-8B-Q4_K_S.gguf`, with Hermes Q4_K_M and Qwen3 8B Q4_K_M available as alternates.

Moon admin still exposes install, start, remove, status, and probe controls through the existing AI page, but those
actions now flow Moon -> Sage -> Oracle. Oracle owns the private embedded model cache/runtime: it writes the GGUF YAML,
downloads the selected model once into persistent storage, starts LocalAI during the explicit lifecycle action, and
only reports ready after a tiny OpenAI-compatible generation probe succeeds.

After a deploy or container restart, Oracle also runs a background auto-start check for embedded LocalAI. It starts the
runtime only when Oracle is enabled, the provider is `localai`, the selected model is already installed, no remove job
is active, and a real generation probe can pass. If the model is missing or LocalAI is still warming, `/health` remains
healthy and `/admin/system/ai` shows the startup phase, gate reason, and last error instead of blocking the stack. If
Oracle starts before its saved settings can be read, later health, status, model-list, or chat requests retry the
embedded startup after the LocalAI settings become available.
Oracle `/api/status` is intentionally quick: it reports cached embedded generation readiness instead of starting a
fresh generation probe on normal status reads. Manual lifecycle actions and explicit readiness probes still perform the
real generation check before marking LocalAI ready.

Warden plans the `scriptarr-oracle` container instead of a `scriptarr-localai` sidecar. It mounts persistent
`localai/models` and `localai/data` folders into Oracle and passes hardware flags for the selected profile. NVIDIA
hosts should run Oracle with `--runtime nvidia --gpus all`, `NVIDIA_VISIBLE_DEVICES=all`, and compute/utility driver
capabilities. Explicit `/dev/nvidia*` device bindings are optional and should only be enabled on hosts that require and
expose those paths to Docker. CPU-only hosts can still use LocalAI, but generation may be slow.

If GPU-specific startup is unavailable, the rest of Scriptarr should stay healthy while AI features remain disabled or
temporarily unavailable.

## Oracle Defaults

- Oracle starts in an off state on install.
- Oracle defaults to provider `openai`.
- Oracle now runs as a FastAPI Python service while keeping the same internal HTTP contract for Sage, Moon, and Portal.
- The OpenAI API key can be entered in Moon admin before Oracle is enabled.
- Oracle also exposes a structured assist endpoint through Sage for bounded helper text, trivia borderline matching,
  and AI tool planning. It never executes mutations directly; Sage turns operational prompts into confirmable admin
  proposals.
- Admins can later switch Oracle to LocalAI from Moon admin and then manually install, start, probe, or remove the
  embedded model/runtime through Oracle-brokered actions.
- Restarts can auto-start LocalAI only for an already installed selected model; Oracle never downloads a model during
  background startup.
- When the provider is `localai` and no model is set explicitly, Scriptarr falls back to
  `Hermes-3-Llama-3.1-8B-Q4_K_S.gguf` instead of the OpenAI default model name.
- Moon's AI page loads available model ids through Moon -> Sage -> Oracle and renders the model control as a
  provider-specific dropdown. Browsers never call OpenAI or LocalAI directly for model discovery.
- The AI page loads saved Oracle settings, tool toggles, and proposals first, then hydrates Oracle health and LocalAI
  runtime state from a secondary brokered runtime payload. Slow optional AI providers should not block the page from
  opening.
- `SCRIPTARR_ORACLE_LLM_TIMEOUT_SECONDS` can tune Oracle's provider call timeout. The default is `60` seconds so slow
  CPU LocalAI responses have room to complete.

## AI Tooling

Sage owns the AI tool registry and the `ai` admin access domain. Owners bypass as usual, and the seeded Admin group is
repaired with `ai:root`. Read tools are enabled by default for stack status, events, queue, requests, library search,
Missing Content, Discord runtime, trivia status, and LocalAI status. Operational tools such as status checks, request
source refreshes, queue retries, LocalAI lifecycle actions, maintenance jobs, and trivia start/stop are disabled by
default until an AI root admin enables them.

Operational prompts in `/admin/system/ai` create proposals first. A permitted admin must confirm a proposal before Sage
executes the allowlisted action. Oracle may help summarize or plan the request, but Oracle never performs mutations or
sends arbitrary Discord broadcasts.

Public Noona mention chat uses a separate conservative Sage allowlist. From Discord, Noona can only read lightweight
stack, Discord, trivia, and library context, and can only draft low-risk proposals such as status checks or trivia
start/stop. Root/system, LocalAI lifecycle, destructive, and arbitrary broadcast actions stay excluded from public
chat even if an admin enabled them on the AI page.

## Core Admin Tasks In Moon

- sign in as the first admin through Discord
- verify Discord auth and callback settings
- configure libraries and storage paths
- manage request moderation
- review metadata-first request matches, re-resolve unavailable requests, and approve concrete Raven download targets
- manage reusable permission groups, user-group assignments, protected-owner visibility, and access audit feeds in
  `/admin/users`
- manage the Discord bot workflow in `/admin/discord`, including guild id, onboarding channel or template, DM
  superuser id, release notification channel, GitHub update notification channel, Noona mention chat, Noona memory
  controls, Appa admin/review controls, trivia channel and scoring, and per-command role mapping
- configure Raven VPN credentials and region for PIA/OpenVPN-backed downloads
- review Raven metadata providers, with MangaDex enabled by default, Anime-Planet enabled ahead of MangaUpdates, and
  AniList, MyAnimeList, or ComicVine available for wider coverage
- review Raven download providers, with WeebCentral first by default and MangaDex available as a second normal source
- set Raven's active title-download limit from `/admin/settings`; the value defaults to `2`, accepts `1` through `6`,
  applies live when Raven can reload it, and otherwise persists for the next Raven restart
- import existing CBZ files into a library from `/admin/import`, then track the required reader-page ingest pass from
  `/admin/ingest`
- manage Moon branding from `/admin/settings`, including site name and a PNG, JPEG, or WebP logo that Scriptarr stores
  as WebP variants for user/admin chrome and install metadata
- review database size and table counts from `/admin/settings`, then open the grant-protected DB explorer at
  `/admin/settings/database` when you need redacted table browsing or safe settings JSON edits
- manage global and per-admin toast notification preferences for admin actions, async jobs, live events, and failures
- manage Moon API keys from `/admin/system/api`, including enable state, system keys with permission-group assignment,
  user-key audit, and Swagger/OpenAPI links
- inspect server-redacted managed-service logs from `/admin/system/logs`
- search durable audit and runtime events from `/admin/system/events`, including the redacted reader telemetry report
  for caught-buffer waits, slow chunk/image/decode events, retry spikes, and target/page hotspots
- check or install managed Scriptarr service updates from `/admin/system/updates`; installs require `system.root` and
  the typed confirmation `UPDATE SCRIPTARR`
- manage allowlisted maintenance schedules from `/admin/system/tasks`; cron expressions are free-form, but the jobs
  are Scriptarr-defined only, runs are non-overlapping, and every manual or scheduled run is brokered through Sage with
  durable job history. The `Stale queue cleanup` task inspects Raven title tasks and durable `downloadall` runs
  together, reattaches detached running bulk runs when Raven can recover them, and records exact recovery actions when
  an admin needs to cancel a stale title task or continue a paused run.
- inspect the grouped endpoint matrix from `/admin/system/status`; Scriptarr lists Moon, Sage, Vault, Raven, Warden,
  Portal, Oracle, and LocalAI routes quickly on first load, then checks GET/read endpoints only when you run the
  explicit check action. Auth-gated reads report as protected, and mutation routes remain not probed.
- configure Oracle and optional LocalAI runtime controls from `/admin/system/ai`, including provider, model dropdown,
  temperature, masked OpenAI key state, LocalAI image profile, manual install, start, or remove actions, lifecycle
  progress hydrated after first paint, completion toasts, Sage-governed AI tool toggles, confirmed action proposals,
  and prompt tests
- preview or execute the root-only content reset flow from `/admin/system` when you need to wipe content-side state
  and managed files without deleting users, settings, or durable events
- manage users, roles, and permissions
- inspect Warden service health and runtime config
- monitor the live Raven queue board and reprioritize, retry, or cancel work from `/admin/activity/queue`; the active
  slot total shown there reflects the configured Raven title-download limit

Moon live updates use a same-origin WebSocket first, then the older SSE stream, then backup refresh polling. The browser
only connects to Moon; Moon validates the existing session cookie plus a short-lived live ticket before bridging to
Sage on the internal Docker network. Sage authorizes the event domains, sanitizes live/history event payloads, and keeps
durable state in Vault.

## Moon Route Model

Moon now serves three distinct programs from one runtime:

- the forward-facing user app at `/`
- the fullscreen reader app at `/reader`
- the admin app at `/admin`

The reader and admin programs run through separate Next.js App Router runtimes with isolated `/reader/_next` and
`/admin/_next` assets. The legacy plain-JS admin bundle and `/admin-assets` fallback have been removed, and browser
routes continue to use Moon same-origin APIs plus the Discord-backed guard where needed.

Common user routes:

- `/library`
- `/browse` and `/library/<type>` as compatibility catalogue entrypoints
- `/title/<type>/<titleId>`
- `/reader/<type>/<titleId>/<chapterId>`
- `/myrequests`
- `/following`
- `/profile`

Moon still accepts the older untyped `/title/<id>` and `/reader/<titleId>/<chapterId>` paths as compatibility shims,
but the typed routes are the canonical links Moon now emits.

Moon also serves a same-origin `manifest.webmanifest` and `service-worker.js` so the user and reader surfaces can be
installed like an app and keep a rolling cache of recently opened chapters on the current device.
That same user app now runs through an embedded Next.js App Router frontend with lightweight local shell primitives, a
single-row megamenu header with plain site-name branding, a compact avatar dropdown for Profile, conditional Admin,
and Logout, a dedicated `/profile` page for local StylePanel preferences and install actions, and a simple footer.
The dedicated reader app is fullscreen, has its own overlays and settings drawer, and supports webtoon, single,
double, manga double, LTR/RTL, and page-fit controls. Reader performance diagnostics keep detailed timings in the
browser-local `window.__scriptarrReaderTelemetry` buffer and persist only redacted slow/retry/caught-buffer summaries
as `reader` events for admin review. `/admin/system/events` aggregates those summaries into caught-buffer, slow
load/decode, and retry hotspot reports without exposing raw image URLs or filesystem paths. Revisioned page images are
cached only after successful same-origin loads through
Moon in a bounded derived cache, failed page-image responses remain `no-store`, and redacted page probes distinguish
stream failures from missing or corrupt archive entries without exposing filesystem paths or raw image URLs. `/profile` is now a tabbed account
hub with `Overview`, `Stats`, and `Preferences` instead of one long mixed settings panel. Library type links now live
inside the `Library` mega menu and canonical `/library?type=...` URL state, while `/browse` still opens the same
catalogue for old links. The catalogue keeps a quick-jump letter rail on the left, tighter search against titles,
aliases, types, and tags, a remembered Grid/Rows view toggle, paged InfiniteScroll, and stable Skeleton loading states.
Its home route now favors a simpler media-library feel too, with a personalized "Your Bookshelf" continue-reading row followed by
cover-led scrollers for recently added titles by type and tag-driven shelves based on explicit tag likes or hides plus
inferred taste from read history, follows, and the active bookshelf.
Moon chrome now starts from one same-origin bootstrap call for branding, auth state, user identity, and first-owner
setup status. Signed-out shells render Moon's local Discord start route immediately, and the individual bootstrap
broker calls use short timeouts so branding, auth, or first-owner status can degrade separately.
User, admin, and reader apps show a small non-blocking loading indicator while initial auth or page JSON is in flight.
It uses `pointer-events: none`, so navigation and settings controls remain clickable while cards or admin payloads
continue hydrating.
`/myrequests` is now both the request-creation surface and the personal status page. The top of the page runs the
metadata-first request wizard, while the list below is split into `Active`, `Completed`, and `Closed` tabs. Readers
can edit notes or cancel only while the request is still active.
Title pages now paint in chunks. The hero and continue/read action strip load from a lightweight summary first, chapter
rows load through paged InfiniteScroll with search/filter/sort, and request history loads only after the Requests tab
opens. Bulk chapter actions intentionally operate on "loaded" rows, not every matching row that may exist on later
pages. Marking a title unread now means reset it off the bookshelf: title read state, chapter reads, progress, and
title bookmarks are cleared while follows stay. Individual chapter mark-unread is non-destructive, and selected
chapter `reset` is the destructive bulk action that can clear bookmarks and current progress.

Common admin routes:

- `/admin/library`
- `/admin/library/<type>/<titleId>`
- `/admin/add`
- `/admin/import`
- `/admin/ingest`
- `/admin/calendar`
- `/admin/mediamanagement`
- `/admin/activity/*`
- `/admin/wanted/*`
- `/admin/requests`
- `/admin/users`
- `/admin/settings`
- `/admin/settings/database` (opened from Settings, not shown as a left-nav item)
- `/admin/discord`
- `/admin/system/*`

Legacy Moon paths such as `/downloads`, `/settings`, and `/setupwizard` now redirect into the new admin routes.
The dense `/admin/library` index now links into a Sonarr-style admin title detail page where you can inspect one title
at a time with its cover, backdrop, lifecycle status, source and metadata identity, related requests, active Raven
tasks, and per-chapter release or archive details.
That title page now also exposes repair candidates with concrete provider URLs, chapter-coverage previews, warning
chips, and a safe replacement queue action that stages the replacement download before it swaps the live files.
`/admin/import` is reserved for manual library intake. Admins point Raven at CBZ files that are already visible under
the Raven downloads mount, confirm title and chapter metadata, and Raven copies the accepted archives into the canonical
`downloaded/<type>/<title-folder>` library tree before queueing ingest.
CBZ page counts include supported images and exclude metadata such as `ComicInfo.xml`. Valid ready pages are retained
when older inflated catalog counts are corrected. Startup scans preserve known chapter identities even when series
names contain numbers or archive naming settings change.
`/admin/ingest` is the WebP backlog and recovery surface. It shows per-title ingest status, worker readiness,
completion counts, and retry controls. Failed ingest keeps the CBZ in place and appears as retryable work instead of
making the title readable. Its `Start / rebuild all` action asks Raven for a clean ingest restart: active rebuild runs are
superseded quickly, old superseded run noise is hidden from normal summaries, and fresh runs start in OEL, Manhua,
Manhwa, Manga, Webtoon, Comic
order without deleting catalog rows, CBZ archives, requests, read state, follows, bookmarks, or user data. Raven uses
balanced fair title lanes for those type runs (`SCRIPTARR_RAVEN_AVIF_TITLE_LANES`, default `2`, max `3`): one title per
leased library type converts at a time, then the scheduler rotates to the next active type so OEL, manga, manhwa, and
other backlogs can all make progress. The legacy AVIF variable keeps priority; `SCRIPTARR_RAVEN_INGEST_TITLE_LANES`
is the fallback only when it is unset or blank. Restart-all may briefly show a run as preparing while Raven writes the durable
title-task list in the background; after that, the run moves into the normal waiting/running fair-scheduler states. The
page also shows active and recent durable type-run summaries with state labels, current title, queue position, last
progress, title counts, resume/cancel controls, and ETA when Raven has enough data, without loading every child title
task into the browser. If Raven recovers duplicate active durable runs for the same library type, it keeps the preferred
run and marks the others superseded before the scheduler can work both.
Appa can also start a type-wide reader-page rebuild from Discord with
`/ingest type:<manga|manhwa|manhua|webtoon|comic|oel>`. The command previews title count from Raven's compact
title-card projection plus Raven hardware state,
requires a confirm button within five minutes, and then Sage asks Raven to create a durable `raven-library-ingest` run.
The run rebuilds derived WebP pages from existing canonical CBZ archives without redownloading chapters or changing
metadata. Appa DMs the confirming admin at 25%, 50%, 75%, and final completion or failure; missed milestones are not
replayed once the run is already terminal. If a run was created without a saved Discord requester, Sage falls back to
the configured owner DM for those updates. If Discord says the saved requester can no longer receive DMs, Portal marks
that specific notification undeliverable instead of retrying it every poll. If Raven restarts or temporarily loses the
Sage/Vault broker during a type-wide rebuild, Raven reattaches the durable run, keeps already failed title tasks failed,
resets stale running tasks, and continues unfinished title tasks instead of starting a duplicate run. Waiting runs are
not fake-running; admin pages show them as waiting for the conversion worker slot until the fair scheduler rotates to them.
Per-title progress checkpoints one chapter row at a time through Sage and Vault, so large titles do not rewrite
their entire chapter list after every converted chapter. Raven also skips unchanged ready chapters during retry and
throttles progress updates so large titles do not spam the queue store. Remote page conversion uses the worker's
bounded two-thread, single-page policy and the durable pool-wide encoding lease. If a
checkpoint still exhausts its retry budget, the title appears in Needs attention with a retryable reader-page progress
message instead of raw broker timeout text.
Legacy run records and readable AVIF files remain available during the WebP transition; they are not deleted to
make a new run appear successful.
If a catalog duplicate merge changes the canonical title set for an active type run, Raven supersedes that stale run and
starts a fresh run against canonical titles only.
`/admin/users` is now the access-control workspace: a dense user directory, reusable permission-group editor, group
assignment panel, and recent auth or access events in one page. Staff access is no longer a flat role toggle. Moon now
evaluates unioned permission groups with route-family `read`, `write`, or `root` grants, while the bootstrap owner
stays visible but protected from deletion or demotion. `Member-AI` is the default non-owner group and grants Noona
chat through `use_noona_chat`; `Member` remains the no-AI opt-out group.
`/admin/requests` is the moderation inbox. It opens on requests needing review, lets staff search or filter by status,
and keeps request details in a drawer with saved metadata, selected source snapshots, duplicate waitlist state,
timeline, linked Raven ids, and approve, resolve, refresh-source, override, or deny actions. Denying a request requires
a moderator comment so the durable audit event and requester notification have a useful reason. It also supports safe
bulk refresh-source and bulk deny actions; approvals remain per request so moderators can inspect each source choice.
When a source lookup returns exactly one concrete Raven target, Moon selects it for the moderator but still waits for
the explicit approve or resolve action. Each admin action carries the request revision, so stale drawers fail with a
clear refresh-and-review conflict instead of overwriting another admin or background update.
`/admin/wanted/metadata` replaces the old Metadata Gaps page and lets staff search provider matches and apply one to an
existing library title through Sage and Raven. `/admin/wanted/metadata-gaps` redirects to the new canonical route.
`/admin/wanted/missing-content` shows coverage gaps, bad chapters, possible missing pages, and bad-source quality
summaries. It uses the existing library repair candidates to queue a safe staged replacement download when a better
source is selected. `/admin/wanted/missing-chapters` redirects to this canonical page.
If a saved reader image disappears, its logical page is recorded in the chapter's quality diagnostics. Missing WebP
segments also leave a failed ingest that can be retried from the canonical CBZ in `/admin/ingest`.
Retries can reuse a validated completed conversion artifact. Repairs retain quality history and the saved conversion time.
The source, chapter and saved output identity must match; superseded content remains a diagnosed recovery condition.
This also repairs a missing saved manifest while retaining validated page files. Damaged older reader files do not
block an append or import from reaching its ingest repair stage.
`/admin/calendar` is a month or agenda release view fed by Sage's calendar payload. Completed titles appear through
dated chapter entries when available and get one title-level completion marker when Raven only has title or chapter
update timestamps. Titles with no usable date are counted as undated completed instead of being dropped.
`/admin/activity/queue` is now a live queue board. It groups Raven work into `Running`, `Queued`, and recovery-only
`Needs attention`, subscribes to the shared admin live stream, and keeps backup refresh active so Raven progress
refreshes without a manual page reload even when WebSocket or SSE transport is degraded. It exposes card-level controls for
retry, retry-all, cancel, priority changes, and queued-task move up/down actions.
Section bulk buttons can cancel all queued work, cancel all running work for `activity.root` admins, retry all
recovery items, or remove all removable recovery items.
Type-wide reader-page rebuilds appear in a separate library-run panel on the queue page; they are not counted as normal Raven
title tasks and do not use the title-task retry/remove controls. The panel mirrors the ingest page states: Running
current title, Waiting for worker slot, Needs recovery, Cancelling, or terminal, with resume and cancel controls where
the run can accept them.
Queued cards intentionally do not show ETA values. Running cards reserve ETA space immediately, show `measuring` while
Raven gathers enough progress data, then show the active ETA from Sage. Download cards can also show live transfer
speed when Raven has credible telemetry. `Needs attention` cards can remove failed or stale queued tasks while deleting
only the incomplete managed working folder. Service update and restart jobs stay out of `Needs attention`; track them
under System, Updates, and Events instead.
If a `downloadall` bulk run pauses after stale title-task cleanup, check `/admin/system/tasks` for the latest
`Stale queue cleanup` result and `/admin/activity/queue` for the listed Raven title task. Cancel the exact stale task
when needed, then continue the run from the owner DM reaction or `/downloadall continue runid:<id>`.

## Settings And Database Explorer

The main Settings page is the compact place for general site administration. It includes branding, uploaded logo
preview, database size summary, The Noona Project credit link, Discord support link, toast preferences, Raven VPN,
metadata providers, download providers, request workflow, and Discord basics. AI controls intentionally stay under
`/admin/system/ai`. Settings paints saved configuration first, then hydrates Raven VPN runtime, database overview, and
Portal Discord runtime in the background. Settings saves are section-scoped through Moon v3 routes, so background
refreshes should not wipe unsaved edits and blank Raven VPN password fields preserve the existing stored secret.

The DB explorer is reachable only from the Settings page and requires the `database` admin grant unless the signed-in
user is the protected owner. It can show a table overview, row counts, approximate table sizes, redacted rows, column
metadata, pagination, and safe search. It does not expose arbitrary SQL. The first edit path is intentionally limited
to validated JSON values in the `settings` table so auth, sessions, secrets, API key hashes, users, and durable events
remain read-only from the browser.

Toast preferences are also brokered through Settings. Root settings admins can adjust global defaults, while each
admin can keep personal overrides for action, job, live-event, and failures-only notifications.

Project credit: [The Noona Project](https://github.com/The-Noona-Project/Scriptarr). Support:
[Discord](https://discord.gg/HMYHT8KD5v).

## Discord Bot Workflow

Moon admin now owns the Discord workflow settings that Portal uses at runtime:

- guild id for slash-command scoping
- DM superuser id for the private `downloadall` command
- onboarding channel id and message template
- release and update channel ids. Release posts announce completed Raven downloads; update posts announce AI-written
  GitHub update summaries from `The-Noona-Project/Scriptarr` with raw commit details kept behind a quiet `View changes`
  link button instead of visible branch, SHA, repository, or admin fields.
- Noona public mention-chat enable state, allowed channels, memory toggle, conservative proposal mode, and memory clear
  actions
- Appa admin bot enable state, admin mention channels, review toggle, correction mode, review audit, and Appa command
  role gates
- trivia channel id, optional leaderboard channel id, scoring, cooldowns, hints, and AI borderline matching
- per-command enable toggles and required Discord role ids

Portal can run one Discord bot or two. If `SCRIPTARR_APPA_DISCORD_TOKEN`,
`SCRIPTARR_APPA_DISCORD_CLIENT_ID`, and the `/admin/discord` Appa toggle are present, Noona keeps reader-facing
commands and public chat while Appa owns admin commands, admin mentions, `downloadall`, and serious Noona corrections.
If Appa is disabled, missing, or fails to start, Noona keeps the existing single-bot admin fallback.

Portal also bundles default Discord avatars for the public bot identities. `SCRIPTARR_DISCORD_BOT_PERSONA` is now only
a legacy single-bot avatar fallback; split mode always applies the bundled Noona avatar to the primary bot and Appa to
the second bot. `SCRIPTARR_DISCORD_AVATAR_MODE` defaults to `missing`, which uploads the bundled avatar only when the
Discord bot has no custom avatar; use `off` to disable this or `force` for one deliberate avatar refresh. Sage passes
Noona and Appa's visual descriptions to Oracle as read-only context, so Noona can answer appearance questions without
storing image data in chat memory.

Noona mention chat is public by design in this version. With it enabled, users can mention the real bot user id in any
allowed guild channel, for example `@Noona Ai are you alive?`, and Portal replies to that message after sending the
request through Sage. Portal ignores bots, wrong guilds, empty mentions, channels outside the allowlist, and unmentioned
chatter. User eligibility is checked by Sage against Vault permission groups before memory, proposals, read context, or
Oracle are used. Manage access from `/admin/users` with `Member-AI` or another group containing `use_noona_chat`;
the saved `/chat` role id is ignored for Noona chat authorization. Portal now replies immediately with a requester-mentioned `Thinking...` placeholder, edits that same message with
the final answer, and reports how many request(s) are ahead when Noona or Appa is already answering another AI request.
Only the requester mention is allowed in AI replies. Leave the allowed-channel list blank to allow every channel in the
configured guild, or restrict it to known safe channel ids for a quieter rollout.
If an admin mentions both Noona and Appa in a configured Appa channel, Noona leads the public reply, Appa reviews it,
and Appa then posts its own answer. In other channels, Noona leads dual mentions and Appa stays quiet to avoid duplicate
bot replies. Status or presence prompts such as "are you online?", "are you connected?", and "are you there?" use
Sage's bounded live status path instead of waiting on the AI provider or Vault-backed Noona memory. Portal also keeps
an internal service-token guarded smoke route for operators that posts a one-shot Appa nonce mention in the configured
smoke channel; this is for production verification only and does not disable the normal bot-message loop guard.

Discord's Message Content intent must be enabled in the Discord developer portal for mention chat, trivia guesses, and
legacy DM text fallback handling. Scriptarr requests the intent in code, but Discord will not deliver message content
unless the application setting allows it.

The split Discord command set is:

- Noona: `/search`, `/request`, `/subscribe`, `/trivia status`, and `/trivia leaderboard`
- Appa: `/ding`, `/status`, `/ingest`, owner-only DM `/downloadall`, `/trivia start`, `/trivia stop`,
  `/discord inspect`, and `/discord testpost`

When Appa is disabled or unavailable, Noona registers the legacy single-bot command set, including `/ding`, `/status`,
`/chat`, `/search`, `/request`, `/subscribe`, `/trivia`, and owner-only DM `/downloadall`. Split mode does not
register `/chat`; natural Noona mention chat remains the public chat surface and uses `/admin/users` group access.
In fallback mode, legacy `/chat` shares Noona's AI queue, asks Sage's Noona chat route with the Discord user identity,
and edits its ephemeral placeholder once the response is ready.

Blank role ids mean any member in the configured guild can use that slash command. `downloadall` ignores guild roles,
is only supported in bot DMs, and only checks the configured DM superuser id.
`/discord inspect` is Appa's admin diagnostic for recent allowed-channel messages. It returns short redacted snippets
and metadata only, stores a redacted durable audit event through Sage, and should be used when troubleshooting Noona,
trivia, or notification delivery without copying full Discord transcripts into logs. `/discord testpost` sends a small
Appa-owned test message to an allowed channel and records the same redacted audit trail.
`/trivia` controls Noona's title-summary guessing game. Normal channel messages are the guesses; exact titles, aliases,
source links, Moon title links, and tolerant fuzzy matches count. Winners get XP with speed and streak bonuses, and
leaderboards can be posted after each round plus daily, weekly, and monthly at the configured server-time hour.
Portal reconciles trivia timers through Sage so reloads, repeated `/trivia start`, and settings refreshes keep one
active round clock. If a round is already active, the command reports that active round instead of reposting the clue
or arming duplicate hints and timeouts.
Noona memory for public chat is intentionally summarized. Durable memory lives in the `portal.noonaChat.memory` Vault
setting as capped user facts and server lore, not raw transcripts. Users can say `remember that ...`, `forget that`,
`forget me`, or `what do you remember about me?`; admins can review memory counts and clear one user, server lore, or
all Noona memory from `/admin/discord`. The memory helper rejects obvious tokens, secrets, passwords, API keys,
sessions, cookies, and credentials.
Use `/downloadall run type:<type> nsfw:<true|false> titlegroup:<prefix> groupsize:<count>` in a DM with Appa when the
split admin bot is enabled, or with Noona in single-bot fallback mode.
Every `downloadall` request creates a durable Raven run now, including single concrete type plus single `titlegroup`
requests, so Portal can deliver delayed summaries even if the batch takes hours. `type:all` or `titlegroup:all`
starts a multi-batch run that pauses after the configured group size. `groupsize` defaults to `1`, accepts `1-25`,
and means Raven will complete that many batch tasks one at a time before pausing for approval. Paused summary DMs get
check/cross reactions; the configured owner can react with the check mark to continue the next group or the cross to
cancel the remaining run. `/downloadall continue runid:<id>`, `/downloadall status runid:<id>`, and
`/downloadall cancel runid:<id>` remain the manual fallback.
`/downloadall help` returns the usage guide in DMs. Portal still keeps the old raw DM text form
(`downloadall type:... nsfw:... titlegroup:...`) as a legacy best-effort fallback, but that path depends on Discord
delivering normal DM message events and should not be treated as the primary interface.
Discord `/request` now uses the same metadata-first flow as Moon web: search raw metadata results first, then submit
one exact metadata choice for moderated review. Requesters no longer choose download providers in Discord; staff do
that from `/admin/requests`.
`downloadall` now bulk-browses the provider first, then metadata-resolves each matched title before queueing it. Only
titles with one confident metadata match are queued. For `nsfw:false`, Raven also verifies the concrete WeebCentral
detail page and only queues titles with an explicit `Adult Content: No`; adult or unverified titles are skipped.
Portal's DM summary now breaks skipped titles out as already active, completed, already current, adult-content,
no-metadata, ambiguous-metadata, invalid source, appended, or failed instead of silently queueing metadata-less library
entries. Raven skips completed catalog titles, appends only missing or new chapters for non-completed existing titles,
and ignores malformed bare source URLs such as a provider `/series` root.
That owner-only command is intentionally pinned to WeebCentral. If WeebCentral is disabled in Raven settings,
`downloadall` fails instead of falling back to MangaDex or another provider.

For `/downloadall run type:Manhua nsfw:False titlegroup:t groupsize:20`, select the registered slash command in the
owner's DM. This selects one Manhua/T batch containing every eligible matching title. `groupsize:20` is an approval
batch count, not a twenty-title limit; the separate title-download concurrency setting still controls active work.

A completed run requires complete discovery and successful publication of its queued chapters, including catalog
persistence and complete ready reader pages. Provider failures, unresolved title tasks, and exhausted retries pause the run with
recovery details. Continue retries unresolved work and preserves completed chapters. Cancel stops run-owned work while
preserving finished archives. Healthy work waiting in the queue or progressing through CPU ingest does not expire
merely because it has been waiting a long time.
Paused Discord summaries show unresolved title plans separately from failed title tasks, including failures whose
retry allowance has not been exhausted. They include the saved recovery reason and identify the paused batch;
an unfinished batch is not a completed batch. Already acknowledged summary messages are not resent after an update.

Startup recovery waits for title-task restoration before recovering bulk runs. Append recovery checks the planned
chapters and their actual archives/reader pages instead of treating an existing title as proof of completion. Status
reads inspect the run; explicit owner actions and background recovery schedule its work.
Healthy canonical CBZs can finish ingest while the source is unavailable, keeping their bytes and timestamps and
preserving earlier readable chapters. Failed owned tasks still wait for the approved retry; restarting does not grant
another attempt allowance.
If a broker interruption leaves a stopped title shown as running, Raven's background reconciliation saves the
failed task once the broker is healthy. The original files and retry history remain intact. A paused run still needs
the owner's normal continue action; status checks and failure reconciliation do not restart failed downloads.

Vault startup also handles preserved catalogs whose legacy `cataloged_at` timestamp is required but has no default.
It restores new-title publication while preserving the existing column and stored values. If publication reports that
timestamp error, deploy the compatible Vault image through Warden, wait for Vault readiness, then retry the existing
run. Retain the canonical CBZs so recovery can reuse them and finish reader-page ingest.

Discord interaction/message identifiers deduplicate retried run creation. Delivery records retain accepted summary
message identifiers so prompt-registration or acknowledgement retries reuse the same message. Each pause has an
approval identifier; an old or repeated reaction cannot approve a newer batch. Ambiguous deliveries that cannot be
safely reconciled surface an operator recovery condition instead of repeatedly sending DMs.
Moon user browse/library pages use compact paginated title-card reads, and title pages use summary plus paged chapter
reads, so large libraries do not send chapter arrays or Raven filesystem roots to the browser. Cover images are cached
by Moon as derived WebP files under the Moon cover-cache storage folder. The
Tasks page has an `Optimize cover images` action that scans Sage-approved artwork, converts missing or stale cache
entries, and is safe to rerun. Titles retain provider cover art when downloads resume from existing archives.
Filling a missing cover during reader processing preserves it through later checkpoints and library scans.
Reader live updates keep the active chapter, logical page and viewing preferences when its content revision is unchanged.
Changed chapter content reloads only that chapter, while route or account changes still initialize a new reader session.
If a cover is missing or cannot be loaded, Moon uses the first page of the earliest readable chapter as the cover.
That fallback becomes available after reader processing finishes for a chapter and follows the same sign-in checks
as reader pages; it does not modify reading progress or replace the canonical archives.
Vault deduplicates compact title cards before counts, letter totals, sorting, and pagination, and old duplicate title
ids resolve through catalog aliases so stale title or reader links land on the canonical title instead of 404ing.
Portal also sends requester DMs when a moderated request is approved, denied, or finishes downloading, and dedupes
those notifications by request id plus decision state so retries and restarts do not spam Discord.
If a release channel id is configured in `/admin/discord`, Portal also posts completed downloads to that channel with
Moon read or title links. Release channel notifications are grouped into one compact digest per poll, show up to ten
newest titles plus a `+N more` count, and are only acknowledged after Discord accepts the message.
If an update channel id is configured, Sage checks `The-Noona-Project/Scriptarr` after the managed image update refresh
inside the scheduled or manual `update-check` task. New commits since the last posted update are summarized by Oracle
in Noona's voice, stored durably, and posted by Portal with a stable `update:<latestSha>` id. If Oracle is unavailable
or returns degraded, disabled, fallback, or empty summary text, Sage keeps the commit range pending and retries on the
next update check instead of posting a weak fallback. Curated update-summary prompts bypass Oracle's generic status
shortcut so words like callback or availability do not turn an update announcement into a health-check reply.
Operators can intentionally skip a stuck pending range for
future-only posts; that clears `pending`, records `latestSkipped`, and moves the comparison baseline forward without
sending a backlog Discord post. The maintenance helper is
`services/sage/scripts/skip-github-update-digest.mjs --skip-pending-update-digest --reason=future-only --apply`. After
an update post is acknowledged, public Noona mention chat can answer questions like "what changed?" or "how do I use
it?" from the latest posted digest in any channel already allowed for Noona mention chat.
When a duplicate request is blocked because Scriptarr is already tracking the same concrete work, Sage now attaches the
user to a hidden notification waitlist instead of creating a second visible request row. Portal DMs those waitlisted
users when the title is ready. Portal also DMs requesters when an unavailable request later finds a source and moves
back into admin review, and DMs them again if that unavailable request expires after 90 days.
Portal now prefers a minimal Discord runtime when privileged intents are unavailable. Slash commands and DM handling
can stay online while onboarding is marked degraded, and `/admin/discord` will show the last meaningful runtime or
command-sync error instead of only a generic disconnected state. Appa diagnostics distinguish settings fetch failures,
the admin toggle being disabled, missing Appa env, login failures, intent failures, command-sync failures, and recent
mention-gate rejections; refreshing settings can retry the split runtime after brokered settings become available.
Cold Sage or Vault settings reads no longer leave Portal stuck after startup: Portal records the settings error,
reports command sync as connected-but-unconfigured, retries the settings load in the background with bounded backoff,
and automatically restarts/syncs the split runtime when the brokered `portal.discord` setting becomes available.
That runtime view now also surfaces the requested intents or partials, the most recent DM receive timestamp, the last
handled `downloadall`, the last `downloadall` error, Noona mention-chat status, Appa mention/review/correction status,
and recent redacted Appa review audit events so owner-only DM and public chat failures are easier to trace.
For admin dual mentions in configured Appa channels, Noona answers first, Appa reviews that reply, and Appa then posts
its own response from the Appa bot. If Noona hits a bounded AI failure and posts fallback copy, Appa still answers with
that safe context. Appa remains quiet on other Noona co-mentions to avoid duplicate public replies. Appa `/ingest`
previews disable confirmation when no titles are eligible and acknowledge button presses before starting Sage/Raven
work so Discord does not show an interaction timeout. Started ingest runs also DM the confirming admin with milestone
and final progress.

## Public Moon API

Moon now serves a trusted automation API and same-origin Swagger docs:

- docs: `/api/public/docs`
- raw OpenAPI: `/api/public/openapi.json`
- search: `GET /api/public/v1/search?q=...`
- create request: `POST /api/public/v1/requests`
- request status: `GET /api/public/v1/requests/<requestId>`

Search is public. Protected calls require `X-Scriptarr-Api-Key`, which Moon admin now manages from
`/admin/system/api`. Scriptarr stores only hashed key material in Vault and only reveals a plaintext key once when it
is created. System-level keys inherit the permission groups assigned to them, while user-level keys are created from
the reader profile page and can only access that Discord account's reader sync data and own requests.

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
- `warden/logs/`
- `warden/runtime/`

Warden's own container mounts are:

- `warden/logs -> /var/log/scriptarr`
- `warden/runtime -> /var/lib/scriptarr`

Raven's download tree keeps CBZ archives canonical and reader pages derived under `raven/downloads/`:

- `downloading/<type-slug>/<title-folder>/...` for active or incomplete work
- `downloaded/<type-slug>/<title-folder>/...` for completed promoted CBZ library content
- `ingested/<type-slug>/<titleId>/<chapterId>/webp-<revision>/...` for immutable WebP page segments and `manifest.json`
- existing AVIF revision folders for chapters that have not completed WebP migration

Raven also supports internal chapter and page naming templates through the brokered `raven.naming` setting. This pass
keeps title-folder naming unchanged so rescans remain compatible with the current library model.
Moon now exposes those controls at `/admin/mediamanagement`, with one fallback profile plus per-type naming profiles
for manga, manhwa, manhua, webtoon, comic, and OEL downloads. The saved formats apply to new Raven downloads and to
archive rescans so Moon, Raven, and the on-disk layout stay aligned.
Request records now persist the original search query, selected metadata snapshot, selected download snapshot, and any
linked Raven job or task ids so Moon admin can moderate or retry the exact saved target later.
Normal downloads and manual CBZ imports must finish reader-page ingest and catalog persistence before the chapter
is readable. New output carries a `webp-` ingest revision; existing healthy `avif-` revisions remain supported. WebP
readiness requires every segment of every logical page. Failed conversion keeps the CBZ for retry, and migration
keeps a previously readable revision available until the replacement is fully committed.
Vault now also stores a durable request work key derived from the concrete download target when one exists, or from the
metadata identity when no download match exists yet, and active duplicate work keys are rejected.
Vault also stores Raven catalog keys and title aliases. Maintenance operators can preview and merge safe duplicate
title groups through the service-only Sage/Vault route; the merge keeps the richest title data, chapter rows, reader
state, follows/bookmarks, and an audit mapping before retiring duplicate rows. On large libraries, run duplicate
cleanup in bounded batches so Vault previews title rows first and hydrates chapter rows only for groups being merged.
Vault now also stores reusable permission groups, user-group assignments, and immutable durable events. Deleting a user
from `/admin/users` clears local access plus active sessions, but preserves their requests, follows, bookmarks,
progress, and audit history. If that Discord user signs in again later, Scriptarr recreates them on the current
default onboarding group.
Vault now also stores durable title-level and chapter-level read state. `media_progress` remains the current reading
position signal, while bookshelf and completion state now derive from the read-state model so completed titles can fall
off the shelf until new chapters arrive.
Moon's content reset is content-only, not a factory reset. The root-only reset flow clears requests, work locks,
progress, follows, reader bookmarks, Raven catalog or task state, and managed Raven download folders, but keeps users,
permission groups, sessions, settings, secrets, and durable events.
For an approved restart of one cancelled bulk run, use the separate Warden-authenticated scoped reset through Sage's
`/api/internal/warden/raven/content-reset/preview` and `/apply` routes. The first preview requires the cancelled run ID,
a unique operation ID, and exactly its selected plan IDs. Review both the durable scope digest and filesystem inventory
digest before applying that operation. This path removes physical content for the selected plans, including existing
content, and clears their chapter availability while retaining title IDs, metadata, covers, user state, and operational
history. It rejects ambiguous ownership, shared unrelated paths, symlinks, changed inventory, and actual active writers.
An interrupted apply retains maintenance fences; resume the same reviewed operation after diagnosing the interruption.
Do not substitute the global content reset for a scoped restart.
Raven now also runs up to two title downloads at once globally. Higher-priority work still starts first, queued-task
reordering only affects work that has not started yet, and the live Moon queue reflects the two available running
slots. Raven also persists real task start times and, when it can measure them credibly, live download speeds that
Moon reuses in the running queue cards. Source-image 404 failures trigger a chapter page-list refresh first; if pages
are still missing, Raven writes generated "Possible missing page" placeholders, marks chapter/title quality, and keeps
the batch moving instead of failing the whole title for one bad image. If no usable pages remain, Raven records Missing
Content rather than blocking the run.
Vault stores title-level `qualityStatus`, clean/partial/missing counts, and summary text plus chapter-level expected
page counts, missing page numbers, and quality notes. Moon uses those fields in Missing Content to show partial
chapters, bad chapters, missing pages, and bad-source summaries such as `3/256 clean downloads`.

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
  portal. Scriptarr now tries to send the user back to the page they started from after Discord login, so a wrong
  callback or public base URL can also break the return-path handoff and drop users back to `/`.
- If Discord login works locally but fails behind a reverse proxy, confirm the proxy forwards HTTPS scheme headers.
  Moon binds OAuth callbacks to a short-lived browser cookie, and production HTTPS should mark that state cookie Secure.
- If Oracle is off, confirm the chosen provider and credentials in `/admin/system/ai` before treating the rest of the
  stack as unhealthy.
- If LocalAI actions are slow, let the Moon admin job continue instead of retrying immediately; the first GGUF download,
  runtime start, and generation probe are intentionally long-running. The progress card tracks model download, runtime,
  and readiness phases.
- If Raven VPN is enabled, failed settings reads, stale settings, missing `/dev/net/tun`, missing `NET_ADMIN`, or
  failed tunnel startup block downloads instead of silently falling back to direct traffic. Warden recreates Raven when
  its VPN device/capability flags drift; if your host cannot support TUN, leave VPN disabled or opt out of the runtime
  device flags with `SCRIPTARR_RAVEN_VPN_RUNTIME_DISABLED=true`.
- `Armed / idle` in Settings means the VPN is enabled and ready but OpenVPN is not currently running because Raven
  connects lazily before protected download traffic. Use `Test VPN` to force a brokered connection check; a successful
  enabled test leaves the tunnel connected.
- If source lookups work on the host but fail inside Raven after the VPN connects, check which route reaches the
  container's inherited DNS server. A LAN resolver can become unreachable through the VPN. Set
  `SCRIPTARR_RAVEN_DNS_SERVERS=1.1.1.1,8.8.8.8` in Warden's private environment only after verifying those resolvers
  work through the tunnel. Recreate Warden with that environment and let it reconcile Raven. Raven receives the
  explicit DNS servers while Docker's embedded resolver
  continues to resolve internal service names. Keep VPN protection enabled; do not add an unprotected DNS bypass.
  The optional `SCRIPTARR_<SERVICE>_DNS_SERVERS` setting accepts IP addresses separated by commas or whitespace,
  or a JSON IP array. Unset leaves DNS unchanged; an explicit `[]` returns that service to Docker's inherited DNS.
- If the Docker test stack is already running, tear it down with `npm run docker:test:teardown` before starting a new
  isolated run with the same stack id.

## Source metadata and bulk-run recovery

Use Wanted → Metadata to select a concrete provider edition. Identification validates current source facts before replacing a match; an original and a reboot keep separate canonical identities. Verified provider metadata is preferred, with complete non-adult source metadata as fallback. Adult classification conflicts and incomplete source pages require recovery. Saved bindings, original facts and tag origins remain durable through Sage/Vault.

In Activity → Queue, the configured Discord owner with activity root access can inspect a paused run and recheck metadata skips. The operation retains prior skip decisions, is retry-safe after an interrupted response, and never starts downloads. Continue the existing run through Noona. Do not recreate a run or retry historical cancelled attempts to clear their history. Queued age and encoder waiting do not make work stale; active stalls require meaningful progress evidence. Preserve the configured title concurrency and conversion budgets when preparing large runs, and check free storage plus download-to-ingest backlog before expanding intake.

Metadata rechecking reopens affected completed batches as paused recovery work while preserving accepted task receipts. Retrying a repair never advances the approval window or starts downloads.

Provider layouts can repeat headings across responsive views. Source verification uses one nonempty heading and gathers linked creators and tags from their labelled fields. Reapply a verified metadata match to refresh retained source facts after a scraper correction.

Different editions may legitimately share metadata aliases. Execution resolves explicit source identities and storage ownership before treating a shared alias as a collision; an unknown source or shared canonical folder still requires recovery.

Download recovery rejects empty or zero-filled page headers in saved archives and staged pages. Preserve damaged CBZs as diagnostic evidence before repairing affected chapters; valid archives continue to be reused. A successful ZIP checksum alone does not establish readable image content.
