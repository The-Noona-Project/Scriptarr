# Moon

Moon serves Scriptarr's native user app at `/`, dedicated reader app at `/reader`, and admin app at `/admin`.
The user and reader surfaces are installable through the same-origin PWA shell with a rolling recent-chapter cache for
reader pages.

The admin side now owns Raven VPN settings, Raven metadata provider order, and the dedicated `/admin/system/ai`
surface for Oracle or LocalAI configuration while still proxying everything through Sage instead of sending the browser
directly to internal services.
Moon admin also owns the Raven download-provider settings so admins can decide which site-specific Raven scrapers are
enabled as more providers land later. WeebCentral stays first by default, MangaDex is now available as a second normal
download provider, and the Discord `downloadall` command remains intentionally pinned to WeebCentral for the
configured owner account.
Moon admin now also includes a dedicated Discord page at `/admin/discord` for guild workflow settings, slash-command
role gates, onboarding template or channel management, release-channel posts, GitHub update-summary posts, Noona
mention chat, Noona memory review or clear actions, and Portal runtime visibility without exposing Discord credentials
in the browser.
That Discord page now distinguishes connected command runtime, command-sync health, onboarding capability, and the last
meaningful Portal runtime error instead of collapsing everything into one disconnected status. It also surfaces Noona
mention-chat status, last channel/user, and last error so public chat problems can be diagnosed without reading Portal
logs.

Moon 3.0 also includes a native reader flow with:

- the canonical catalogue at `/library`
- compatibility catalogue entrypoints at `/browse` and `/library/<type>`
- typed series detail routes at `/title/<type>/<titleId>`
- a typed native reader at `/reader/<type>/<titleId>/<chapterId>`
- request and following views at `/myrequests` and `/following`
- a signed-in profile route at `/profile`

Moon still accepts the older untyped title and reader URLs as backward-compatible shims, but the typed paths above are
the canonical links emitted by the user app.
The catalogue and home shelves use compact paginated title-card APIs so large catalogs do not send chapter arrays to
the browser. Moon also owns a derived WebP cover cache: cards prefer Sage-provided `coverThumbUrl` values, cache files are
stored outside authoritative catalog state, and `/admin/system/tasks` includes a safe `Optimize cover images` action.
Moon's request and admin add-title flows now share the same metadata-first intake engine. Readers pick metadata only,
and Scriptarr saves that metadata snapshot with the request so moderators can review the upstream metadata site and
choose the exact Raven source later. Admin add-title uses the same intake base but lets staff pick a concrete source
and queue immediately when one exists.
Web request creation now lives only in `/myrequests`. That page runs an inline wizard: search raw metadata provider
rows first, choose the exact metadata match, review its provider link if needed, then submit the request with optional
notes. If no source exists yet, Moon saves the request as `unavailable` and still shows it in the same page's tabbed
status list. Admins later choose sources from `/admin/requests`, unless Sage auto-approves one high-confidence source.
The forward-facing user app itself now runs through an embedded Next.js App Router program using lightweight local
shell primitives. Moon keeps the same public routes and same-origin APIs, but the user experience now uses a
single-row megamenu header with plain site-name branding, a compact anchored avatar dropdown, a simple footer, and a
dedicated `/profile` page for local StylePanel preferences and install actions. That profile route is now a tabbed
account hub with `Overview`,
`Stats`, and `Preferences` sections instead of one long settings sheet. The older plain-JS user shell has been
removed, and Library type links now live under the `Library` mega menu and canonical `/library?type=...` URL state.
Discord login now also preserves the same-origin route where the user started whenever possible, so signing in from a
title, reader, browse, request, or admin page returns to that page instead of always dropping into one fixed surface.
If the remembered path is missing, unsafe, or not allowed for the signed-in user, Moon falls back to `/`.
Chrome startup uses `/api/moon/chrome/bootstrap?returnTo=...` to collapse branding, auth state, user identity, and
first-owner bootstrap into one same-origin call. Moon only asks Sage for the Discord OAuth URL when a signed-out
surface actually needs to render a login link.
The catalogue keeps a quick-jump index rail on the left, tighter search against titles, aliases, types, and tags, a
remembered Grid/Rows view toggle, and paged InfiniteScroll with a manual fallback button. The home route is
intentionally simpler too: it starts with a personalized "Your Bookshelf" continue-reading shelf, then stacks cover-led
scroller rows for recently added titles by library type and tag-driven suggestions based on explicit tag likes or hides
plus inferred taste from read history, follows, and the active bookshelf.
Moon's reader is now a dedicated fullscreen app at `/reader/<type>/<titleId>/<chapterId>` with isolated
`/reader/_next` assets, own auth/loading/error states, overlay controls, progress controls, settings drawer, and
layout preferences for webtoon, single page, double page, manga double, LTR/RTL direction, and width/height/contain
fit. It still uses Moon's same-origin typed reader APIs for progress, bookmarks, preferences, manifest payloads, and
page images.
The reader also keeps a bounded local debug telemetry buffer at `window.__scriptarrReaderTelemetry`. Session fetch,
page chunk fetch, image load/decode, preload queue depth, retry counts, decoded pages ahead/behind, and caught-buffer
waits are measured before preload policy changes; only redacted slow/retry/caught-buffer summaries are brokered through
Moon -> Sage as durable reader events.
Reader page images now auto-retry transient load failures before showing a manual retry panel, and Moon caches only
successful revisioned page-image responses under its bounded Warden-mounted derived reader page cache. Failed image responses
stay `no-store`, and the same-origin page probe classifies failures without exposing archive paths, tokens, or raw
image URLs.
Moon title pages now paint from chunked same-origin reads: the cover-led hero and action strip call the lightweight
`/api/moon-v3/user/title/<titleId>/summary` route first, chapter rows stream through the paged
`/chapters?cursor=&pageSize=&sort=&filter=&q=` route, and request history waits until the Requests tab opens. The
chapter list is a dense InfiniteScroll surface with "Select loaded" bulk semantics, so bulk read/unread/reset actions
only touch rows already loaded into the page. Marking a title unread is still a reset-off-shelf action: it clears title
read state, chapter read state, reader progress, and title bookmarks while preserving follows. Individual chapter
mark-unread remains non-destructive; selected chapter `reset` is the bookmark/progress-clearing bulk action.
`/admin/system` now also exposes a root-only content reset preview plus execute flow. That maintenance action clears
content-side requests, follows, bookmarks, progress, Raven catalog state, Raven task state, and managed Raven download
folders while keeping users, permission groups, settings, secrets, sessions, and durable events.
Moon now renders those intake results one row per concrete download target instead of one row per metadata row, so
duplicate metadata matches collapse cleanly while real edition targets such as plain vs colored remain visibly
distinct.
When a user tries to request a duplicate title, Moon no longer creates a second visible request row. If the title is
already in the library, Moon links directly to the title page. If the title is already queued or running, Moon blocks
the duplicate row, shows the existing state, and Sage attaches the user to a hidden ready-notify waitlist so Portal
can DM them later.
Unavailable requests stay visible in `/myrequests`, are re-checked every 4 hours by Sage, and move to `expired` after
90 days if no stable source appears.
Moon's title, browse, admin review, and home surfaces now consume one merged canonical tag set per library title.
Raven builds those tags from both metadata providers and download providers, with case-insensitive dedupe and
human-readable display casing.
Moon admin settings now also surface Anime-Planet as a scrape-based metadata provider ahead of MangaUpdates so admins
can keep lifecycle or alias enrichment on without relying only on API-backed sources.

Admin routes follow the Arr-style operations model, including library, add/import, calendar, activity, wanted,
requests, users, Discord, settings, and system sections under `/admin`.
Moon now serves `/admin` through the embedded Next.js App Router admin app with isolated `/admin/_next` assets and
lightweight local shell providers. The old plain-JS admin fallback and `/admin-assets` bundle are gone; every admin
route now renders inside the Next shell and continues to use Moon's same-origin Sage-backed APIs.
`/admin/users` now acts as the full access-control surface: a dense user directory, reusable permission-group editor,
group assignment panel, and recent auth or access event feed in one place. The bootstrap owner remains protected, and
all other admin access is now derived from one or more permission groups with per-route-family `read`, `write`, or
`root` grants.
`/admin/requests` is the dedicated moderation inbox instead of a generic data page. It defaults to requests needing
review, keeps saved metadata and source snapshots visible in a drawer, and calls the Sage-backed approve, resolve,
refresh-source, override, and deny routes without resetting active edits during live refreshes. It supports safe bulk
refresh-source and bulk deny actions, but keeps approval and source resolution per request.
Picked resolver sources now immediately affect the available actions, and Moon auto-selects exactly one concrete
source candidate for review without auto-approving it. Admin request actions include the request revision so stale
drawer actions return a clear conflict instead of overwriting newer request state.
`/admin/wanted/metadata` is the dedicated metadata repair page. The old `/admin/wanted/metadata-gaps` path redirects
there, and staff can search provider matches and apply one to the selected library title through Sage.
`/admin/wanted/missing-content` is the dedicated coverage and quality repair page, showing missing counts, damaged
chapters, possible missing pages, bad-source summaries, and Raven repair candidates that queue safe staged replacement
downloads through the existing library repair route. `/admin/wanted/missing-chapters` redirects there.
`/admin/library` now uses a denser Sonarr-inspired series index with live filtering, coverage bars, latest chapter,
last release date, metadata state, and direct open or source actions.
Each library row now opens a Sonarr-style admin title detail page at `/admin/library/<type>/<titleId>` with a
backdrop hero, dense status and release stats, related requests, active or recent Raven task visibility, and a
chapter table that keeps release dates and archive paths in one operational view.
That admin title page now also shows provider repair candidates with chapter-coverage previews and warning chips, and
it can queue a safe staged replacement download without deleting the current library files first.
`/admin/mediamanagement` is now the dedicated Raven file-management page. It exposes a fallback naming profile plus
per-type naming profiles for manga, manhwa, manhua, webtoon, comic, and OEL so admins can preview and save archive or
page formats without digging through the broader settings surface.
`/admin/calendar` now renders a month or agenda view backed by Raven chapter release dates captured from source
scrapes and metadata enrichment instead of only showing a flat task-style table. Completed titles get one dated
completion marker when chapter dates are incomplete, while fully undated completed titles remain visible in the
summary count.
`/admin/activity/queue` is now a live SSE-backed queue board instead of a static table. It splits Raven work into
`Running`, `Queued`, and recovery-only `Needs attention` sections, refreshes without a manual page reload, and
exposes card-level controls for retry, retry-all, cancel, priority changes, and queued-task reordering. Live refresh
now defers while queue controls are being edited, running cards show live download speed plus an active ETA when Sage
can estimate one credibly, and recovery cards can remove failed or stale queued tasks with their incomplete working
folders. The active slot total is display-only here and comes from the configured Raven title-download limit. Section
bulk controls can cancel all queued work, cancel all running work for root admins, retry all recovery items, or remove
all removable recovery items.

Fresh installs intentionally show empty library states until Raven has real imported titles to surface, and the admin
program now ships in a dark-only theme by default.

Moon no longer exposes a dev-session claim path. Discord login is the supported first-owner and admin sign-in flow, and
Moon serves versioned CSS or JS asset URLs with `no-store` HTML responses so new publishes invalidate stale browser
bundles automatically.
Moon's admin event history now comes from the shared Vault-backed durable event log, and the admin SPA subscribes to
same-origin `/api/moon-v3/admin/events*` feeds for live updates instead of page-specific ad hoc polling.
The admin System pages for Logs, Events, and Updates are now purpose-built Next surfaces rather than generic record
cards. Logs use Warden's server-redacted Docker tail through Sage, Events expose durable Vault filters plus a detail
drawer, and Updates restore check/install controls with typed confirmation for `system.root` admins.
Tasks, Status, and AI now follow the same Next pattern. Tasks renders the Sage-owned allowlisted scheduler with cron
editing, preview, manual run, and recent history; Status initially renders Sage's lightweight grouped endpoint
registry, then probes GET/read routes only when an admin runs the explicit check action. It shows auth-gated reads as
protected and leaves mutation routes unprobed. Warden bootstrap and runtime details hydrate from the secondary
same-origin status runtime payload; AI paints saved Oracle settings, tools, and proposals first, then hydrates Oracle
health, LocalAI lifecycle state, and asynchronous install/start/remove progress from brokered runtime calls while
keeping completion toasts and the admin test prompt in the same page.
Moon admin also owns the general Settings hub. It manages brokered `moon.branding` site name plus uploaded logo WebP
variants, database size summary with a Settings-only DB explorer link, toast notification preferences, project credit
and support links, and compact Raven VPN, provider, active title-download limit, request workflow, and Discord
essentials. Section drafts stay dirty locally until their save succeeds, and Settings-owned saves use explicit Moon v3
endpoints rather than older generic admin routes. The Raven download limit is a Settings-only numeric control for
title-level concurrency (`1` through `6`, default `2`) and shows when a save was persisted but Raven could not apply it
live. The VPN card shows persisted settings beside Raven runtime capability, settings freshness, protected tunnel
state, `armed / idle` lazy-connect state, and the latest tunnel or broker error. Its test action stays same-origin
through Moon and Sage, then asks Raven to start the same fail-closed OpenVPN path used by downloads. Settings paints
saved configuration first, then hydrates Raven VPN runtime, database overview, and Portal Discord runtime from the
secondary settings runtime payload without wiping dirty drafts.
The DB explorer stays same-origin through Moon -> Sage -> Vault, requires the `database` admin domain, redacts
sensitive values, and only allows validated settings JSON edits.
The signed-in admin shell now also uses the Discord-backed user avatar when one is available, with an initials fallback
so the top-right identity surface stays readable even without profile art.
Admin pages use one shared toast provider for action results, async jobs, and live admin event stream updates instead
of page-local stacks. The provider reads a toast-only settings endpoint and owns one shared admin SSE connection that
pages subscribe to by event domain, so page-level EventSource connections should not be reintroduced.
Moon admin also owns API management at `/admin/system/api`, including enable state, system-level keys assigned to
permission groups, user-key audit for root API admins, and links to the plain same-origin Swagger docs and raw OpenAPI
payload. Signed-in readers manage their own user-level API keys from `/profile`; those keys stay scoped to that
reader's profile, library, follows, bookmarks, progress, and own requests.

Moon now serves the public automation API under `/api/public/*`:

- `GET /api/public/docs`
- `GET /api/public/openapi.json`
- `GET /api/public/v1/search?q=...`
- `POST /api/public/v1/requests`
- `GET /api/public/v1/requests/<requestId>`

Search stays public. Protected calls require `X-Scriptarr-Api-Key`; system keys inherit assigned permission groups and
user keys are account-scoped. The external API rejects NSFW titles, already-imported titles, already-active requests or
downloads, and results without an enabled download target before queueing the surviving request at the lowest priority.

Moon now treats title art as first-class metadata too. Cover images from Raven intake and library state are rendered in
admin Add Title, requests, queue or history, and library surfaces as well as the user browse and title views.
