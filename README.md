# Scriptarr

Scriptarr is a self-hosted manga and comics stack rebuilt for 3.0. `Noona` now only refers to the Discord bot and AI
persona while the product, services, storage, images, and docs all use Scriptarr naming.

Warden bootstraps the stack, Moon is the user and admin surface, Sage is the browser-safe and first-party internal
broker, Vault owns shared MySQL-backed state plus cache or job brokerage, Raven handles downloads plus metadata, Portal
handles Discord, and Oracle provides optional AI chat plus bounded Sage-governed assistance.

## Service Map

- `scriptarr-warden`: bootstraps the stack, parses the URL-first MySQL contract, owns `scriptarr-network`, and exposes
  manual LocalAI install, start, or remove actions
- `scriptarr-mysql`: durable shared datastore for Scriptarr when `SCRIPTARR_MYSQL_URL=SELFHOST`
- `scriptarr-vault`: auth, permissions, settings, secrets, cache, requests, sessions, progress, and generic job broker
- `scriptarr-sage`: Moon-facing auth plus the only supported first-party internal HTTP broker
- `scriptarr-moon`: same-origin installable user app at `/`, type-scoped native reader routes under `/reader/<type>/<title>/<chapter>`, and Arr-style admin app at `/admin`
- `scriptarr-raven`: Spring Boot Java 24 downloader, library, metadata, and PIA/OpenVPN-aware download engine
- `scriptarr-portal`: Discord onboarding, requests, notifications, subscriptions, Noona trivia, and Oracle bridge
- `scriptarr-oracle`: FastAPI Python service that starts disabled, defaults to OpenAI config, and can optionally use
  LocalAI later

## Docker Images

Scriptarr no longer ships a compose-based deployment path in this repo. Each first-party service has its own
`Dockerfile`, and the supported helper scripts are:

- `npm run docker:list`
- `npm run docker:build`
- `npm run docker:push`
- `npm run docker:publish`

Published images target `docker.darkmatterservers.com/the-noona-project/scriptarr-<service>:<tag>`.

The supported runtime install path is to manually start only `scriptarr-warden`. Warden runs as its own container with
the Docker socket bind plus its `warden/logs` and `warden/runtime` mounts, then reconciles Moon, Vault, Sage, Raven,
Portal, Oracle, and optional managed MySQL for you. On Linux and Unraid hosts, also bind the full
`SCRIPTARR_DATA_ROOT` path back into the container at the same absolute path so Warden can prepare the storage tree
directly while it reconciles the sibling containers. See [ServerAdmin.md](ServerAdmin.md) for the full container
contract and the recommended `docker run` shape.

Fresh installs no longer seed demo titles into Moon or Raven. The user and admin library views stay empty until Raven
has real imported titles to surface.
Moon admin now uses a denser Arr-style series index at `/admin/library` and exposes a dedicated
`/admin/mediamanagement` page for Raven naming profiles instead of burying file-management controls inside the generic
settings screen.
Raven now stages active work under `downloading/<type>/...` and promotes completed library content into
`downloaded/<type>/...` inside the Raven downloads tree.
Raven also supports old-style chapter and page naming templates behind the internal `raven.naming` setting while
keeping the current title-folder layout stable for rescans.
Those naming settings are now profile-based by library type, so manga, manhwa, manhua, webtoon, comic, and OEL
downloads can each use their own archive and page format while still sharing the same Raven rescan logic.
Moon requests and admin add-title now use a metadata-first intake flow. Readers pick one exact metadata result first,
Scriptarr stores that metadata snapshot with the request, and staff choose the concrete Raven source later during
approval unless Sage auto-approves a high-confidence match.
That intake is now edition-aware and grouped by concrete download target, so duplicate metadata rows collapse into one
requestable result while real variants such as plain vs colored editions stay separate when the provider exposes
different series URLs.
Moon web request creation now lives only in `/myrequests`, where signed-in readers search raw metadata rows, pick the
exact metadata result they want, optionally leave notes, and submit a moderated full-title request. Admins then choose
the concrete download source from `/admin/requests`, unless the optional `auto approve and download` setting lets Sage
queue one high-confidence source automatically. If Scriptarr cannot find a source yet, it saves the request as
`unavailable`, re-checks it every 4 hours, DMs the requester when the title moves back into admin review, and expires
it after 90 days if it still cannot be matched.
Moon admin `/admin/users` now also runs on a group-based access model instead of a flat role toggle. The bootstrap
owner stays protected outside normal reassignment, while everyone else receives one or more reusable permission groups
with admin route-family `read`, `write`, or `root` grants plus baseline user capabilities. Scriptarr seeds `Member`,
`Moderator`, and `Admin`, keeps exactly one default onboarding group for new or returning Discord sign-ins, and now
backs admin activity feeds with a shared durable event log plus same-origin SSE updates. The Users page is a dedicated
access-control console with search, filters, a protected owner state, group assignment drawers, and a grant matrix
editor instead of a generic records view.
Raven now keeps WeebCentral first by default, exposes MangaDex as a second normal download-provider option, and enables
Anime-Planet ahead of MangaUpdates as a scrape-based metadata source for aliases, summaries, and lifecycle hints.
Moon admin also exposes a dedicated Discord page at `/admin/discord` for guild workflow settings, onboarding template
or channel management, per-command role gates, release-channel posts, Noona trivia settings, and Portal runtime
visibility without exposing Discord credentials.
Moon's user app now runs as an embedded Next.js App Router frontend with Once UI shells, a megamenu header, avatar
profile controls, a simple footer, and an immersive full-page reader.
That reader now defaults to seamless infinite chapter scroll while keeping a secondary fit-width paged mode, and it
still persists Moon-native progress plus bookmarks behind the same typed reader routes.
Moon admin calendar is now backed by Raven chapter release dates captured from provider scrapes plus metadata
enrichment, and completed catalog titles get a dated completion marker when chapter dates are missing so finished
series are not silently dropped from the calendar.
Moon admin also exposes `/admin/system/api` for trusted automation settings, system-level API keys with assigned
permission groups, personal-key audit, and same-origin Swagger or OpenAPI links. Signed-in readers can create their
own user-level API keys from `/profile` when they want external readers or trackers to sync only their account data.
Moon admin `/admin/settings` is now the general settings hub for site branding, WebP logo upload, database size
summary, toast notification preferences, credits, support links, and compact inline essentials such as Raven VPN,
metadata providers, download providers, request workflow, and Discord basics. The database summary links to
`/admin/settings/database`, a Settings-only database explorer that requires database grants, redacts sensitive values,
and limits edits to validated settings JSON instead of exposing arbitrary SQL. Settings-owned saves now use explicit
Moon v3 settings routes, preserve dirty section drafts during background refreshes, and keep AI controls isolated under
`/admin/system/ai`.
Moon admin's System area now has purpose-built Next pages for operational automation too: `/admin/system/tasks`
manages allowlisted cron schedules and manual runs, `/admin/system/status` shows the grouped endpoint matrix with safe
read probes, and `/admin/system/ai` owns Oracle plus optional LocalAI settings, long-running LocalAI progress, test
prompts, and Sage-governed AI tools that require admin confirmation before operational actions run.

Scriptarr is maintained by [The Noona Project](https://github.com/The-Noona-Project/Scriptarr), with community support
available on [Discord](https://discord.gg/HMYHT8KD5v).

For end-to-end Docker verification, use:

- `npm run docker:healthcheck`
- `npm run docker:test`
- `npm run docker:test:teardown`

## First Boot

1. Start the `scriptarr-warden` container with the Docker socket bind, `SUPERUSER_ID`, and the host data root Warden
   should use for managed service storage. On Linux and Unraid, also bind that host data root back into the container
   at the same path.
2. Provide the Discord bot token as `DISCORD_TOKEN`.
3. Set `SCRIPTARR_MYSQL_URL` to `SELFHOST` for managed MySQL or to `mysql://...` for an external database.
4. Optionally set `SCRIPTARR_MYSQL_USER` if you want to override the managed app user or supply a username that is
   missing from the external MySQL URL.
5. Watch the Warden logs while it reconciles the sibling containers. First boot now surfaces when Docker is creating or
   downloading the managed images.
   Docker health checks now report `healthy` for Warden plus the managed services once each container settles.
6. Open Moon, confirm the bootstrap surface shows the configured first owner id, and use Discord login to claim the
   first owner session.
7. Copy the callback URL surfaced by Warden or Moon into the Discord developer portal.
8. Finish branding, logo, notification, integrations, library, metadata, Raven download-provider, VPN, Oracle,
   moderation, and managed-service update settings in Moon admin.
   If you use the Discord bot runtime, finish the guild id, onboarding, superuser id, and per-command role mapping in
   `/admin/discord` before syncing slash commands.

## Key Contracts

- Browser traffic stays behind Moon. Browsers should not call Warden, Vault, Raven, Portal, Oracle, or LocalAI
  directly.
- Users can create and track requests in Moon and Discord, but Raven only receives approved work.
- Moon user requests and Moon admin add-title now share one metadata-first intake engine. User and Discord requests
  persist the selected metadata first, admins pick download sources during approval, and unavailable requests can be
  re-resolved later instead of being dropped.
- Web request creation now lives in `/myrequests`, and Discord `/request` now uses the same metadata-only requester
  flow instead of a single fuzzy picker or a requester-side source choice.
- Vault now enforces one active request per concrete work identity, so duplicate submissions that resolve to the same
  provider target cannot create parallel active requests.
- Vault now also persists reusable permission groups, user-group assignments, and the shared durable event log that
  powers `/admin/users`, `/admin/requests`, `/admin/system/events`, and other live admin timelines.
- Moon admin Wanted now has dedicated Missing Content and Metadata pages. `/admin/wanted/metadata` is the canonical
  metadata repair route, while the old `/admin/wanted/metadata-gaps` path redirects there. Metadata applies through
  Sage into Raven's identify flow. `/admin/wanted/missing-content` is canonical for chapter gaps, damaged pages,
  partial chapters, and bad-source summaries; the old `/admin/wanted/missing-chapters` path redirects there.
- The admin permission model includes a `database` domain. Owners bypass it, while non-owner admins need database
  grants before they can open the redacted DB explorer under `/admin/settings/database`.
- Duplicate request attempts now attach the requester to a hidden waitlist instead of creating a second visible row.
  If the title is already in the library, Scriptarr links directly to the title page. If the title is already queued,
  Scriptarr blocks the duplicate row and sends a Discord DM when the title becomes ready.
- Portal now owns a real Discord command runtime again. The supported command set is `/ding`, `/status`, `/chat`,
  `/search`, `/request`, `/subscribe`, `/trivia`, plus the owner-only DM `/downloadall` command for the configured Discord
  superuser.
- The DM-only `downloadall` flow now stays provider-browse first but resolves metadata before queueing each title. It
  now uses a global DM slash command as the supported path: `/downloadall run ...`, `/downloadall status ...`,
  `/downloadall continue ...`, `/downloadall cancel ...`, and `/downloadall help`. Every run is durable now, including
  single concrete type plus single `titlegroup` requests, so Portal can DM delayed summaries and continuation prompts.
  Multi-batch selections pause after the configured `groupsize` batch count; paused summary DMs get check/cross
  reactions so the owner can continue or cancel without typing the command. Portal still keeps the old raw DM text
  form as a legacy best-effort fallback, but that path also creates a durable run.
- The bulk flow only queues titles with one confident metadata match and reports already-active, completed,
  already-current, adult-content, no-metadata, ambiguous-metadata, invalid-source, appended, and failed outcomes back
  in the Discord DM summary. Completed library titles are skipped, in-progress titles append only missing or new
  chapters, and `nsfw:false` still requires explicit WeebCentral `Adult Content: No`. That owner-only command is
  intentionally locked to WeebCentral and will fail fast if WeebCentral is disabled.
- Moon browse and library shelves use compact paginated title-card APIs instead of loading every chapter row. Cover art
  is converted into a derived Moon WebP cache on demand, and `/admin/system/tasks` includes a rerunnable cover
  optimization action to prebuild missing or stale cached covers.
- Portal now prefers a minimal Discord runtime over going fully dark when privileged intents are unavailable, so slash
  commands and DMs can stay online while onboarding is shown as degraded in Moon admin.
- Discord `/subscribe` reuses Moon's shared follow store, so Moon and Discord notifications stay aligned instead of
  creating parallel subscription data.
- Portal now sends requester Discord DMs when a moderated request is approved, denied, or completed, reusing the same
  title art and Moon links the rest of the stack exposes.
- Portal can also post completed Raven downloads to the configured Discord release channel from `/admin/discord`.
  Those release posts use stable `release:<taskId>` notification ids and are acknowledged only after Discord accepts
  the channel message, so restarts do not repost successful releases.
- Noona trivia is configured from `/admin/discord`. Portal posts sanitized title-summary clues in the configured
  channel, accepts public guesses, awards XP for exact, alias, URL, and tolerant fuzzy matches, and posts leaderboards
  after rounds plus scheduled daily, weekly, and monthly windows. Oracle can advise only borderline guesses when AI
  matching is enabled; deterministic matching keeps rounds moving when AI is offline.
- Portal also sends DMs when duplicate blockers attach a user to the ready-notify waitlist, when an unavailable
  request later finds a source, and when an unavailable request expires after 90 days.
- Sage and Moon now treat admin events as a first-class brokered contract. Browsers read event history and SSE updates
  only through Moon-owned `/api/moon-v3/admin/events*` routes, while async service state changes append immutable
  summaries into Vault instead of building page-specific ad hoc timelines.
- Moon admin uses one shared toast provider for action results, async jobs, and live admin event stream updates. Global
  defaults live in Vault settings and individual admins can keep personal notification overrides.
- Raven now merges metadata-provider tags plus download-provider tags into one canonical tag set for library titles,
  admin review, browse/search, and personalization surfaces while preserving internal source attribution for debugging.
- Moon home personalization now blends explicit tag likes or dislikes with inferred taste from read history, follows,
  and the active bookshelf. Bookshelf membership is driven by durable title and chapter read state, so readers can mark
  a full title or one chapter read or unread and let completed series fall off the shelf until new chapters appear.
- Moon admin now exposes a root-only content reset preview plus execute flow under `/admin/system`. That reset clears
  requests, work locks, progress, follows, bookmarks, Raven catalog state, Raven task state, and managed
  `downloading/<type>` plus `downloaded/<type>` content while preserving users, permission groups, sessions, settings,
  secrets, and durable events.
- Vault is the only supported broker to the shared MySQL database.
- Sage is the supported internal HTTP hop between first-party services. Direct internal exceptions are limited to
  Vault -> MySQL, Warden -> Docker or host runtime, Oracle -> OpenAI or LocalAI, and Raven -> external source,
  metadata, or VPN providers.
- Warden owns one shared internal Docker network named `scriptarr-network`. Moon is the only first-party service
  exposed publicly by default.
- Warden is not published publicly by default outside the test stack. Admins should talk to the stack through Moon
  unless they are debugging from inside the managed Docker network.
- LocalAI is optional for overall stack health and is not installed on first boot.
- Oracle starts disabled and OpenAI-first. LocalAI is enabled later from Moon admin when the admin is ready for a slow
  install or start cycle.
- Warden-managed LocalAI presets now use the LocalAI AIO image family and only report startup success once the LocalAI
  runtime is actually ready. Warden now starts those AIO images with the Oracle-safe text-generation preload set
  instead of the full bundled model list so first startup does not get stuck on optional speech or media models.
- CPU LocalAI can still take tens of seconds to answer even after readiness succeeds. Oracle keeps provider-specific
  degraded replies and waits longer for brokered admin test prompts before treating the selected AI provider as down.
- Moon's AI page now discovers provider models through Moon -> Sage -> Oracle and constrains the Oracle model field to
  a dropdown for the selected provider instead of letting browsers or admins type arbitrary model ids.
- Sage owns the AI tool registry. Safe read tools can inspect stack status, events, queue, requests, library, Missing
  Content, Discord, trivia, and LocalAI state; mutation or message-affecting tools stay disabled until an admin enables
  them and always create a proposal that must be confirmed before execution.
- LocalAI install, start, and remove actions are asynchronous Warden lifecycle jobs. Moon shows Docker pull, container,
  and model-readiness progress, and Portal DMs the requesting admin when the job completes or fails.
- Raven VPN should fail closed when VPN-backed downloads are enabled and the tunnel cannot be established. Warden now
  launches Raven with `NET_ADMIN` and `/dev/net/tun` by default so OpenVPN can run on Linux hosts with TUN support, and
  Raven health reports runtime capability, settings freshness, and whether the tunnel is `armed` idle or actively
  `protected`. The Settings page can run a brokered VPN test that starts OpenVPN and leaves the tunnel connected when
  VPN remains enabled.
- Raven should only report download completion after promote plus catalog persistence succeed, and it now rescans the
  `downloaded/<type>/...` tree on boot to recover missing catalog records from finished files.
- Moon admin's live queue keeps ETA on active downloads only, shows recovery actions for failed or stale Raven title
  tasks, excludes service update/restart jobs from Needs attention, and can remove incomplete working folders without
  deleting promoted library content. Section bulk actions can cancel all queued work, cancel all running work for root
  admins, retry all recovery items, or remove all removable recovery items.
- Moon admin System Tasks are allowlisted maintenance jobs only, not arbitrary shell execution. Sage persists their
  cron schedules in Vault, prevents overlapping runs, and emits durable job or event history for scheduled and manual
  runs.
- Moon admin System Status lists known Moon, Sage, Vault, Raven, Warden, Portal, Oracle, and LocalAI endpoints. It
  checks GET/read endpoints, reports auth-gated reads as protected, and keeps mutation routes visible but not probed.
- Oracle and LocalAI controls now live under `/admin/system/ai`; the main Settings page no longer carries AI controls.
- Moon branding now includes a brokered site name plus optional uploaded logo. Moon converts PNG, JPEG, or WebP uploads
  to stored WebP variants for user/admin chrome and install manifest icons.
- Raven admin repair now exposes concrete alternate provider targets per title and can queue a staged replacement
  download that keeps the current catalog row and files intact until the replacement succeeds.
- Raven's WeebCentral scraper now follows the live source's HTMX full-chapter-list flow for long-running series, so
  titles such as Tomb Raider King can recover earlier chapters instead of silently stopping at the visible subset.
- Moon admin stays dark by default, serves versioned browser assets, and exposes the managed-service updates flow for
  Vault, Sage, Moon, Raven, Portal, and Oracle.
- Moon's user app is now installable as a PWA, keeps HTML uncached, and uses a rolling recent-chapter reader cache on
  the current device instead of bulk offline sync.
- Moon also serves trusted API surfaces under `/api/public/*` and selected `/api/moon-v3/*` routes. Search is public,
  protected calls use `X-Scriptarr-Api-Key`, Swagger lives at `/api/public/docs`, system keys inherit assigned
  permission-group grants, and user keys stay scoped to the owning reader's sync data and requests.

## Docs

- [ServerAdmin.md](ServerAdmin.md)
- [AGENTS.md](AGENTS.md)
- [AI docs index](docs/agents/README.md)
