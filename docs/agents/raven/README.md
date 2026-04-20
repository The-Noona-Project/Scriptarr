# Raven AI Notes

- Raven stays Java-first and now runs on Spring Boot with a Java 24 toolchain.
- Raven owns downloader, library, metadata, PIA/OpenVPN download support, and provider orchestration.
- Raven must not call Vault directly anymore. Shared settings, secrets, titles, chapters, metadata matches, and task
  snapshots all flow through Sage's internal broker routes.
- Launch defaults keep MangaDex enabled first, with AniList, MangaUpdates, MyAnimeList, and ComicVine following the
  configured priority and credential gates.
- Download-provider selection is now explicit. Raven intake should search enabled metadata providers first, expand
  aliases from those matches, then run enabled site-specific download providers in registry order.
- Keep full JavaDoc on Raven main and test Java sources and let `gradlew check` fail when doc coverage regresses.
- Fresh installs must not reintroduce demo titles; Raven's default library state is empty until real ingest exists.
- Raven library storage now uses dynamic source-backed type labels and the managed folder lifecycle:
  - `/downloads/downloading/<type-slug>/<title-folder>`
  - `/downloads/downloaded/<type-slug>/<title-folder>`
- Raven VPN should fail closed when enabled, and reconnect logic must honor the configured region instead of assuming
  an existing tunnel is still valid.
- Raven chapter and page filenames now come from the brokered `raven.naming` template settings while title-folder
  naming stays stable for rescan compatibility.
- The brokered `raven.download.providers` setting controls which download providers are enabled and their priority.
  This release only registers WeebCentral, but new sites should arrive as discrete provider implementations under the
  registry contract instead of by growing one generic scraper class.
- New Raven catalog entries should use opaque durable ids instead of title slugs. Treat title ids as opaque route
  parameters everywhere outside Raven's internals.
- Download tasks should only reach `100%` after file promotion and brokered catalog persistence both succeed. When a
  persist step fails, fail the task loudly instead of leaving it running at `90%`.
- Startup recovery should rescan finished `downloaded/<type>/...` content, backfill missing catalog rows, and collapse
  duplicate restorable tasks so Moon queue views only see one logical download.
- Raven parity notes from the old Noona services:
  - keep WeebCentral search, title detail scrape, chapter scrape, and page image resolution
  - keep download task persistence across restarts
  - keep filesystem import scanning so existing archives can backfill the reader catalog
  - keep metadata identify as a real apply-and-persist flow, not a "record for later" stub
  - use old Noona Raven and old Komf as reference inputs only; do not restore Selenium, Kavita coupling, or Komf as a runtime dependency
