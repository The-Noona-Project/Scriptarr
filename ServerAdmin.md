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
Moon requests and admin add-title now run through one intake flow: search query, enabled metadata providers, saved
metadata snapshot, then either admin source approval or immediate queueing depending on who submitted it.
That intake is now grouped by concrete provider target so duplicate metadata rows that land on the same download URL
only create one requestable result, while real separate variants such as plain vs colored editions stay distinct when
the provider exposes different series URLs.
Moon web request creation now lives in `/myrequests` as an inline wizard. Readers pick an exact metadata match,
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
without forcing a re-download.
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

## Discord Callback Setup

The first boot contract is Discord-first. Warden and Sage derive the exact callback URL from the configured public base
URL. Use the callback URL surfaced by the stack when configuring the Discord application.

Example callback shape:

`https://your-scriptarr-host.example.com/api/moon/auth/discord/callback`

Moon's bootstrap surface should also show the configured first-owner Discord id before the first claim. If it does not,
double-check that `SUPERUSER_ID` was passed into Warden correctly.
Moon no longer exposes a dev-session claim path, so Discord login is the supported bootstrap and admin sign-in flow.
When login starts from a same-origin Moon page, Scriptarr now remembers that route and returns the user there after
Discord OAuth completes. If the original route is missing, invalid, or no longer allowed for the signed-in user,
Moon falls back to the user home page at `/`.

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
override and then manually trigger install, start, or remove flows later. Warden runs those flows as asynchronous
LocalAI lifecycle jobs, mirrors progress into the shared broker, and lets the Moon admin page show Docker pull,
container, and model-readiness progress without timing out the browser request.

Warden mounts the persistent LocalAI models and data folders, passes the matching hardware flags for the selected
preset, and waits for LocalAI readiness before it reports startup success. This can take 5 to 20 minutes depending on
the host, and the first AIO warm-up may take a bit longer. Warden now boots the official AIO images with the
Oracle-safe text-generation preload set instead of the full default AIO bundle so startup does not block on optional
speech, image, or other bundled models. When a lifecycle job completes or fails, Portal sends one Discord DM to the
admin who requested it when that admin has a Discord-backed user id.

Readiness means the LocalAI HTTP runtime and model catalog are available. CPU-only generation may still take tens of
seconds per prompt, so Oracle uses a longer provider-call timeout and Moon's admin test broker waits long enough for a
small LocalAI response before reporting the selected provider as degraded.

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
- Admins can later switch Oracle to LocalAI from Moon admin and then manually install, start, or remove LocalAI through
  Warden.
- When the provider is `localai` and no model is set explicitly, Scriptarr falls back to the LocalAI-friendly `gpt-4`
  alias instead of the OpenAI default model name.
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
  superuser id, release notification channel, Noona mention chat, Noona memory controls, trivia channel and scoring,
  and per-command role mapping
- configure Raven VPN credentials and region for PIA/OpenVPN-backed downloads
- review Raven metadata providers, with MangaDex enabled by default, Anime-Planet enabled ahead of MangaUpdates, and
  AniList, MyAnimeList, or ComicVine available for wider coverage
- review Raven download providers, with WeebCentral first by default and MangaDex available as a second normal source
- set Raven's active title-download limit from `/admin/settings`; the value defaults to `2`, accepts `1` through `6`,
  applies live when Raven can reload it, and otherwise persists for the next Raven restart
- manage Moon branding from `/admin/settings`, including site name and a PNG, JPEG, or WebP logo that Scriptarr stores
  as WebP variants for user/admin chrome and install metadata
- review database size and table counts from `/admin/settings`, then open the grant-protected DB explorer at
  `/admin/settings/database` when you need redacted table browsing or safe settings JSON edits
- manage global and per-admin toast notification preferences for admin actions, async jobs, live events, and failures
- manage Moon API keys from `/admin/system/api`, including enable state, system keys with permission-group assignment,
  user-key audit, and Swagger/OpenAPI links
- inspect server-redacted managed-service logs from `/admin/system/logs`
- search durable audit and runtime events from `/admin/system/events`
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

## Moon Route Model

Moon now serves three distinct programs from one runtime:

- the forward-facing user app at `/`
- the fullscreen reader app at `/reader`
- the admin app at `/admin`

The reader and admin programs run through separate Next.js App Router runtimes with isolated `/reader/_next` and
`/admin/_next` assets. The legacy plain-JS admin bundle and `/admin-assets` fallback have been removed, and browser
routes continue to use Moon same-origin APIs plus the Discord-backed guard where needed.

Common user routes:

- `/browse`
- `/library/<type>`
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
double, manga double, LTR/RTL, and page-fit controls. `/profile` is now a tabbed account
hub with `Overview`, `Stats`, and `Preferences` instead of one long mixed settings panel. Library type links now live
only inside the `Library` mega menu, and `/browse` now renders as A-Z shelf rows with the same lightweight scroller
behavior used on the home page. It keeps a quick-jump letter rail on the left and tighter search against titles,
aliases, types, and tags while browse cards clamp long copy until the user opens a title page. Its home route now
favors a simpler media-library feel too, with a personalized "Your Bookshelf" continue-reading row followed by
cover-led scrollers for recently added titles by type and tag-driven shelves based on explicit tag likes or hides plus
inferred taste from read history, follows, and the active bookshelf.
Moon chrome now starts from one same-origin bootstrap call for branding, auth state, user identity, and first-owner
setup status; the Discord OAuth URL is fetched only when a signed-out page actually needs a login link.
`/myrequests` is now both the request-creation surface and the personal status page. The top of the page runs the
metadata-first request wizard, while the list below is split into `Active`, `Completed`, and `Closed` tabs. Readers
can edit notes or cancel only while the request is still active.
Title pages now also expose a cover-led detail view, continue/read action strip, tabs, and a dense selectable chapter
table. Marking a title unread now means reset it off the bookshelf: title read state, chapter reads, progress, and
title bookmarks are cleared while follows stay. Individual chapter mark-unread is non-destructive, and selected
chapter `reset` is the destructive bulk action that can clear bookmarks and current progress.

Common admin routes:

- `/admin/library`
- `/admin/library/<type>/<titleId>`
- `/admin/add`
- `/admin/import`
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
`/admin/users` is now the access-control workspace: a dense user directory, reusable permission-group editor, group
assignment panel, and recent auth or access events in one page. Staff access is no longer a flat role toggle. Moon now
evaluates unioned permission groups with route-family `read`, `write`, or `root` grants, while the bootstrap owner
stays visible but protected from deletion or demotion.
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
`/admin/calendar` is a month or agenda release view fed by Sage's calendar payload. Completed titles appear through
dated chapter entries when available and get one title-level completion marker when Raven only has title or chapter
update timestamps. Titles with no usable date are counted as undated completed instead of being dropped.
`/admin/activity/queue` is now a live queue board. It groups Raven work into `Running`, `Queued`, and recovery-only
`Needs attention`, subscribes to the shared admin SSE stream so it refreshes without a manual page reload, and
exposes card-level controls for retry, retry-all, cancel, priority changes, and queued-task move up/down actions.
Section bulk buttons can cancel all queued work, cancel all running work for `activity.root` admins, retry all
recovery items, or remove all removable recovery items.
Queued cards intentionally do not show ETA values. Running cards show live transfer speed and active ETA only when
Raven and Sage have credible progress data, and `Needs attention` cards can remove failed or stale queued tasks while
deleting only the incomplete managed working folder. Service update and restart jobs stay out of `Needs attention`;
track them under System, Updates, and Events instead.
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
- Noona public mention-chat enable state, allowed channels, memory toggle, conservative proposal mode, and memory clear
  actions
- trivia channel id, optional leaderboard channel id, scoring, cooldowns, hints, and AI borderline matching
- per-command enable toggles and required Discord role ids

Noona mention chat is public by design in this version. With it enabled, users can mention the real bot user id in any
allowed guild channel, for example `@Noona Ai are you alive?`, and Portal replies to that message after sending the
request through Sage. Portal ignores bots, wrong guilds, empty mentions, channels outside the allowlist, and unmentioned
chatter. It also reuses the `/chat` command gate, so setting a required role on `/chat` applies to natural mentions
too. Leave the allowed-channel list blank to allow every channel in the configured guild, or restrict it to known safe
channel ids for a quieter rollout.

Discord's Message Content intent must be enabled in the Discord developer portal for mention chat, trivia guesses, and
legacy DM text fallback handling. Scriptarr requests the intent in code, but Discord will not deliver message content
unless the application setting allows it.

The current Discord command set is:

- `/ding`
- `/status`
- `/chat`
- `/search`
- `/request`
- `/subscribe`
- `/trivia`
- owner-only DM `/downloadall`

Blank role ids mean any member in the configured guild can use that slash command. `downloadall` ignores guild roles,
is only supported in bot DMs, and only checks the configured DM superuser id.
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
Use `/downloadall run type:<type> nsfw:<true|false> titlegroup:<prefix> groupsize:<count>` in a DM with Noona as the supported bulk path.
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
Moon user browse/library pages use compact paginated title-card reads so large libraries do not send chapter arrays or
Raven filesystem roots to the browser. Cover images are cached by Moon as derived WebP files under the Moon
cover-cache storage folder. The
Tasks page has an `Optimize cover images` action that scans Sage-approved cover URLs, converts missing or stale cache
entries, and is safe to rerun.
Portal also sends requester DMs when a moderated request is approved, denied, or finishes downloading, and dedupes
those notifications by request id plus decision state so retries and restarts do not spam Discord.
If a release channel id is configured in `/admin/discord`, Portal also posts completed Raven downloads to that channel
with a Moon read or title link. Release channel notifications use stable `release:<taskId>` ids and are only
acknowledged after Discord accepts the message.
When a duplicate request is blocked because Scriptarr is already tracking the same concrete work, Sage now attaches the
user to a hidden notification waitlist instead of creating a second visible request row. Portal DMs those waitlisted
users when the title is ready. Portal also DMs requesters when an unavailable request later finds a source and moves
back into admin review, and DMs them again if that unavailable request expires after 90 days.
Portal now prefers a minimal Discord runtime when privileged intents are unavailable. Slash commands and DM handling
can stay online while onboarding is marked degraded, and `/admin/discord` will show the last meaningful runtime or
command-sync error instead of only a generic disconnected state.
That runtime view now also surfaces the requested intents or partials, the most recent DM receive timestamp, the last
handled `downloadall`, the last `downloadall` error, and the last Noona mention-chat time or error so owner-only DM and
public chat failures are easier to trace.

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
- If Oracle is off, confirm the chosen provider and credentials in `/admin/system/ai` before treating the rest of the
  stack as unhealthy.
- If LocalAI actions are slow, let the Moon admin job continue instead of retrying immediately; the initial pull and
  startup are intentionally long-running. The progress card tracks the Docker image, container, and readiness phases,
  and Portal DMs the requesting admin when the action completes or fails.
- If Raven VPN is enabled, failed settings reads, stale settings, missing `/dev/net/tun`, missing `NET_ADMIN`, or
  failed tunnel startup block downloads instead of silently falling back to direct traffic. Warden recreates Raven when
  its VPN device/capability flags drift; if your host cannot support TUN, leave VPN disabled or opt out of the runtime
  device flags with `SCRIPTARR_RAVEN_VPN_RUNTIME_DISABLED=true`.
- `Armed / idle` in Settings means the VPN is enabled and ready but OpenVPN is not currently running because Raven
  connects lazily before protected download traffic. Use `Test VPN` to force a brokered connection check; a successful
  enabled test leaves the tunnel connected.
- If the Docker test stack is already running, tear it down with `npm run docker:test:teardown` before starting a new
  isolated run with the same stack id.
