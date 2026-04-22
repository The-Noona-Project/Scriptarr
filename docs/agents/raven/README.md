# Raven AI Notes

- Raven stays Java-first and now runs on Spring Boot with a Java 24 toolchain.
- Raven owns downloader, library, metadata, PIA/OpenVPN download support, and provider orchestration.
- Raven must not call Vault directly anymore. Shared settings, secrets, titles, chapters, metadata matches, and task
  snapshots all flow through Sage's internal broker routes.
- Launch defaults keep MangaDex enabled first, Anime-Planet enabled ahead of MangaUpdates for scrape-based enrichment,
  and AniList, MyAnimeList, and ComicVine following the configured priority and credential gates.
- Download-provider selection is now explicit. Raven intake should search enabled metadata providers first, expand
  aliases from those matches, then run enabled site-specific download providers in registry order.
- Raven intake results should group by concrete `providerId + titleUrl` identity. Metadata variants that hit the same
  provider series should collapse into one requestable target, while true separate edition URLs should stay separate.
- Raven's DM-only bulk queue flow (`/downloadall`) should stay provider-browse first, then metadata-resolve each
  concrete provider target before queueing it. Only queue titles with one confident metadata match, persist that
  metadata snapshot into the queued download, and report already-active, no-metadata, ambiguous-metadata, and failed
  outcomes separately.
- Keep full JavaDoc on Raven main and test Java sources and let `gradlew check` fail when doc coverage regresses.
- Fresh installs must not reintroduce demo titles; Raven's default library state is empty until real ingest exists.
- Raven library storage now uses dynamic source-backed type labels and the managed folder lifecycle:
  - `/downloads/downloading/<type-slug>/<title-folder>`
  - `/downloads/downloaded/<type-slug>/<title-folder>`
- Raven VPN should fail closed when enabled, and reconnect logic must honor the configured region instead of assuming
  an existing tunnel is still valid.
- Raven chapter and page filenames now come from the brokered `raven.naming` template settings while title-folder
  naming stays stable for rescan compatibility.
- `raven.naming` is now profile-based by library type. Preserve the fallback profile plus the per-type profiles for
  manga, manhwa, manhua, webtoon, comic, and OEL when changing naming or parser code.
- The brokered `raven.download.providers` setting controls which download providers are enabled and their priority.
  WeebCentral should stay first by default, MangaDex is now a second normal provider option, and future sites should
  still arrive as discrete provider implementations under the registry contract instead of by growing one generic
  scraper class.
- `/downloadall` remains a special case even with multiple providers. That owner-only Discord bulk path must stay
  pinned to WeebCentral and fail fast if WeebCentral is disabled instead of browsing MangaDex.
- New Raven catalog entries should use opaque durable ids instead of title slugs. Treat title ids as opaque route
  parameters everywhere outside Raven's internals.
- Download tasks should only reach `100%` after file promotion and brokered catalog persistence both succeed. When a
  persist step fails, fail the task loudly instead of leaving it running at `90%`.
- Startup recovery should rescan finished `downloaded/<type>/...` content, backfill missing catalog rows, and collapse
  duplicate restorable tasks so Moon queue views only see one logical download.
- Raven now also supports staged source replacement for existing library titles. Keep replacement downloads isolated in
  fresh working and downloaded roots, then only swap the live folder and catalog identity after the replacement
  succeeds.
- WeebCentral chapter discovery must follow the provider's live continuation model, including HTMX-powered full list
  requests for long-running series. Do not regress back to scraping only the initially visible chapter subset.
- Preserve and enrich release-date data when Raven can observe it. Chapter release dates from provider scrapes and
  title-level release labels from metadata providers now feed Moon's dense admin library and calendar views.
- Preserve lifecycle completion data too. Provider `status` values such as completed, finished, ongoing, hiatus, or
  cancelled should be normalized once inside Raven so Moon admin can trust one canonical title status across its dense
  library, title-detail, and calendar views.
- Raven parity notes from the old Noona services:
  - keep WeebCentral search, title detail scrape, chapter scrape, and page image resolution
  - keep download task persistence across restarts
  - keep filesystem import scanning so existing archives can backfill the reader catalog
  - keep metadata identify as a real apply-and-persist flow, not a "record for later" stub
  - use old Noona Raven and old Komf as reference inputs only; do not restore Selenium, Kavita coupling, or Komf as a runtime dependency
