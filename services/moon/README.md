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
Moon's request and admin add-title flows now share the same metadata-first intake engine. Users search once, pick a
concrete match, and Scriptarr saves the selected metadata plus download snapshot with the request so moderation can
queue the exact Raven target later. Admin add-title uses the same intake results and queues immediately when a
download-ready match exists.
The forward-facing user app itself now runs through an embedded Next.js App Router program using Once UI shells. Moon
keeps the same public routes and same-origin APIs, but the user experience now uses a single-row megamenu header with
plain site-name branding, a minimal avatar dropdown, a simple footer, and a dedicated `/profile` page for local
StylePanel preferences and install actions instead of the older plain-JS shell. Library type links now live only under
the `Library` mega menu, and `/browse` is now a flat A-Z surface with a quick-jump index rail plus uniform art-first
cards that clamp long copy until the reader opens the full title page. The home route is intentionally simpler too: it
starts with a personalized "Your Bookshelf" continue-reading shelf, then stacks cover-led scroller rows for recently
added titles by library type and tag-driven suggestions based on the titles the current reader has already opened.
Moon's reader is now a full-page immersive workspace that defaults to infinite chapter scroll while keeping paged mode
as a secondary preference. It still uses Moon's typed reader routes plus the existing progress and bookmark APIs.
Moon now renders those intake results one row per concrete download target instead of one row per metadata row, so
duplicate metadata matches collapse cleanly while real edition targets such as plain vs colored remain visibly
distinct.
Moon admin settings now also surface Anime-Planet as a scrape-based metadata provider ahead of MangaUpdates so admins
can keep lifecycle or alias enrichment on without relying only on API-backed sources.

Admin routes follow the Arr-style operations model, including library, add/import, calendar, activity, wanted,
requests, users, Discord, settings, and system sections under `/admin`.
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
