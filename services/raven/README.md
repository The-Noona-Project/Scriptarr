# Raven

Raven is Scriptarr's Spring Boot Java 24 download, library, and metadata engine.

It owns the built-in metadata stack that replaces Komf, keeps MangaDex enabled by default, enables Anime-Planet ahead
of MangaUpdates for scrape-based enrichment, and supports optional PIA/OpenVPN-backed downloads using the simplified
Moon admin VPN settings.

Fresh installs now expose an empty library instead of demo titles. Moon stays empty until Raven has real imported
titles to surface.

Raven now reaches shared settings and durable catalog state through Sage's internal broker routes. Sage owns the
first-party hop to Vault, while Raven stays responsible for download execution, source scraping, provider calls, and
reader-ready library projection.

Completed downloads now use Raven's managed two-stage layout under the existing `/downloads` mount:

- `/downloads/downloading/<type-slug>/<title-folder>`
- `/downloads/downloaded/<type-slug>/<title-folder>`

Raven stores dynamic library type labels and slugs from the source when available, uses opaque durable title ids for
new catalog entries, and keeps route shapes stable for Moon. The current metadata set includes MangaDex, AniList,
MangaUpdates, optional MyAnimeList, and optional ComicVine, with provider matching filtered by the title's stored
library type.

Raven also supports a Sage-backed `raven.naming` setting for the safe subset of the old download naming schema:

- `chapterTemplate`
- `pageTemplate`
- `chapterPad`
- `pagePad`
- `volumePad`

Title-folder naming stays unchanged so rescans remain compatible with Raven's current durable catalog and managed
storage roots. Chapter archives default to Scriptarr-style `c001` naming with optional volume omission when no
volume data exists, and page names default to padded numeric files like `001.jpg`.
That naming contract is now profile-based by library type, so Moon admin can save different archive and page formats
for manga, manhwa, manhua, webtoon, comic, and OEL downloads while Raven keeps one shared rescan and parser flow.

When Raven VPN is enabled through Moon admin, downloads now fail closed if Raven cannot safely load the settings,
resolve the requested PIA profile, or complete the OpenVPN handshake. Raven still uses the existing simplified
enable/region/credentials admin contract, but the runtime now refreshes stale PIA profiles, reconnects on region
changes, and uses short-lived credential files with `--auth-nocache`.

Raven's request intake is now provider-based on the download side. Enabled metadata providers run first, Raven expands
aliases from those results, then the enabled download-provider registry checks site-specific scrapers for a concrete
match. WeebCentral stays first by default, MangaDex is now a second normal download-provider option, and the registry
contract is in place for future sites after those two.
Raven intake is also edition-aware and grouped by concrete provider target, so metadata variants that resolve to the
same download URL collapse into one requestable result while plain vs colored editions stay separate when the provider
exposes different series URLs.
The DM-only Discord `downloadall` flow now uses the same metadata-aware path for each bulk-browsed provider title. It
only queues titles with one confident metadata match and reports already-active, adult-content, no-metadata,
ambiguous-metadata, and failed skips back to Portal instead of bulk-queueing metadata-less library entries. When the
command uses `nsfw:false`, Raven verifies the concrete WeebCentral title page and only queues titles with an explicit
`Adult Content: No`; adult or unverified titles are skipped. That command is intentionally locked to the WeebCentral
provider and fails when WeebCentral is disabled rather than falling back to MangaDex.
Raven now also treats cover art as first-class title metadata, carries it through intake, queue state, and library
records, and exposes the same imagery Moon and Portal reuse in their UIs and embeds.
Raven now also preserves chapter release dates from provider chapter scrapes and blends in richer title-level release
labels from metadata providers, which Moon admin reuses for its library and calendar views.
Raven now also normalizes lifecycle status from both source scrapes and metadata providers, including completed or
finished series states, so Moon's admin library, title-detail, and calendar views can distinguish active titles from
completed, hiatus, cancelled, or upcoming work without guessing from chapter gaps alone.
Raven now also participates in Moon admin's root-only content reset flow. Sage previews and triggers that reset, and
Raven clears its managed Raven catalog rows, Raven task state, and managed `downloading/<type>` plus
`downloaded/<type>` folders without touching users, settings, or the shared durable event log.
Raven now also exposes repair candidates per library title so Moon admin can compare alternate concrete provider
targets, review chapter coverage, and queue a staged replacement download without deleting the current title first.
Replacement downloads stage into a fresh working and downloaded root, then only swap the live files after the
replacement succeeds.

Download completion now waits for both file promotion and brokered catalog persistence before a task can reach `100%`.
If catalog persistence fails, Raven marks the task failed instead of leaving it stuck at `90%`. On boot, Raven also
rescans the existing `downloaded/<type>/...` tree to backfill missing catalog rows from already-finished archives.

Raven still runs one title at a time for provider and VPN safety, but page fetches inside a title now use bounded
concurrency, preserve archive ordering, skip already-written files on retry, and collapse duplicate restorable tasks
for the same logical request during recovery.
For long-running WeebCentral series, Raven now follows the source page's HTMX full-chapter-list flow instead of only
the initial visible subset, which fixes partial-history titles such as Tomb Raider King.
