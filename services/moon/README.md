# Moon

Moon serves Scriptarr's native user app at `/` and the admin app at `/admin`.
The user app is now installable as a same-origin PWA with a rolling recent-chapter cache for reader pages.

The admin side now owns Raven VPN settings, Raven metadata provider order, and Oracle or LocalAI configuration while
still proxying everything through Sage instead of sending the browser directly to internal services.
Moon admin also owns the Raven download-provider settings so admins can decide which site-specific Raven scrapers are
enabled as more providers land later. WeebCentral stays first by default, MangaDex is now available as a second normal
download provider, and the Discord `downloadall` command remains intentionally pinned to WeebCentral for the
configured owner account.
Moon admin now also includes a dedicated Discord page at `/admin/discord` for guild workflow settings, slash-command
role gates, onboarding template or channel management, and Portal runtime visibility without exposing Discord
credentials in the browser.
That Discord page now distinguishes connected command runtime, command-sync health, onboarding capability, and the last
meaningful Portal runtime error instead of collapsing everything into one disconnected status.

Moon 3.0 also includes a native reader flow with:

- browse and library routes at `/browse` and `/library`
- typed library routes at `/library/<type>`
- typed series detail routes at `/title/<type>/<titleId>`
- a typed native reader at `/reader/<type>/<titleId>/<chapterId>`
- request and following views at `/myrequests` and `/following`
- a signed-in profile route at `/profile`

Moon still accepts the older untyped title and reader URLs as backward-compatible shims, but the typed paths above are
the canonical links emitted by the user app.
Moon's request and admin add-title flows now share the same metadata-first intake engine. Readers pick metadata only,
and Scriptarr saves that metadata snapshot with the request so moderators can review the upstream metadata site and
choose the exact Raven source later. Admin add-title uses the same intake base but lets staff pick a concrete source
and queue immediately when one exists.
Web request creation now lives only in `/myrequests`. That page runs an inline wizard: search raw metadata provider
rows first, choose the exact metadata match, review its provider link if needed, then submit the request with optional
notes. If no source exists yet, Moon saves the request as `unavailable` and still shows it in the same page's tabbed
status list. Admins later choose sources from `/admin/requests`, unless Sage auto-approves one high-confidence source.
The forward-facing user app itself now runs through an embedded Next.js App Router program using Once UI shells. Moon
keeps the same public routes and same-origin APIs, but the user experience now uses a single-row megamenu header with
plain site-name branding, a minimal avatar dropdown, a simple footer, and a dedicated `/profile` page for local
StylePanel preferences and install actions. The older plain-JS user shell has been removed, and Library type links now live only under
the `Library` mega menu, and `/browse` now uses A-Z shelf rows with the same Once UI scroller pattern as the home page.
It keeps a quick-jump index rail on the left and tighter search against titles, aliases, types, and tags while browse
cards clamp long copy until the reader opens the full title page. The home route is intentionally simpler too: it
starts with a personalized "Your Bookshelf" continue-reading shelf, then stacks cover-led scroller rows for recently
added titles by library type and tag-driven suggestions based on the titles the current reader has already opened.
Moon's reader is now a full-page immersive workspace that defaults to seamless infinite chapter scroll while keeping
fit-width paged mode as a secondary preference. It still uses Moon's typed reader routes plus the existing progress
and bookmark APIs.
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
`/admin/users` now acts as the full access-control surface: a dense user directory, reusable permission-group editor,
group assignment panel, and recent auth or access event feed in one place. The bootstrap owner remains protected, and
all other admin access is now derived from one or more permission groups with per-route-family `read`, `write`, or
`root` grants.
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
scrapes and metadata enrichment instead of only showing a flat task-style table.

Fresh installs intentionally show empty library states until Raven has real imported titles to surface, and the admin
program now ships in a dark-only theme by default.

Moon no longer exposes a dev-session claim path. Discord login is the supported first-owner and admin sign-in flow, and
Moon serves versioned CSS or JS asset URLs with `no-store` HTML responses so new publishes invalidate stale browser
bundles automatically.
Moon's admin event history now comes from the shared Vault-backed durable event log, and the admin SPA subscribes to
same-origin `/api/moon-v3/admin/events*` feeds for live updates instead of page-specific ad hoc polling.
Moon admin also owns the brokered `moon.branding` setting so admins can rename the site in headers, document titles,
and install metadata without changing the underlying Scriptarr service names.
The signed-in admin shell now also uses the Discord-backed user avatar when one is available, with an initials fallback
so the top-right identity surface stays readable even without profile art.
Moon admin also owns the trusted public API settings at `/admin/system/api`, including enable state, admin key
rotation, and links to the same-origin Swagger docs and raw OpenAPI payload.

Moon now serves the public automation API under `/api/public/*`:

- `GET /api/public/docs`
- `GET /api/public/openapi.json`
- `GET /api/public/v1/search?q=...`
- `POST /api/public/v1/requests`
- `GET /api/public/v1/requests/<requestId>`

Search stays public. Write and polling calls require `X-Scriptarr-Api-Key`, and the external API rejects NSFW titles,
already-imported titles, already-active requests or downloads, and results without an enabled download target before
queueing the surviving request at the lowest priority.

Moon now treats title art as first-class metadata too. Cover images from Raven intake and library state are rendered in
admin Add Title, requests, queue or history, and library surfaces as well as the user browse and title views.
