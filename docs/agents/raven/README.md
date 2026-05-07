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
  metadata snapshot into the queued download, and report already-active, adult-content, no-metadata,
  ambiguous-metadata, and failed outcomes separately. For `nsfw:false`, queue only concrete WeebCentral targets whose
  detail page explicitly says `Adult Content: No`; skip adult and unknown adult flags.
- `/downloadall` should skip already-completed catalog titles, append only missing or new chapters for existing
  non-completed titles, skip already-current titles, and reject invalid/bare provider URLs before queueing. Append
  downloads must merge new archives into the existing title without replacing clean chapters.
- Raven is the canonical tag merge point. Metadata-provider tags plus download-provider tags should be normalized and
  merged case-insensitively once inside Raven, preserved with clean display casing, and forwarded through Sage so Moon
  home, browse, title, and admin review all consume one canonical tag set.
- Keep full JavaDoc on Raven main and test Java sources and let `gradlew check` fail when doc coverage regresses.
- Fresh installs must not reintroduce demo titles; Raven's default library state is empty until real ingest exists.
- Raven library storage now uses dynamic source-backed type labels and the managed folder lifecycle:
  - `/downloads/downloading/<type-slug>/<title-folder>`
  - `/downloads/downloaded/<type-slug>/<title-folder>`
- Raven VPN should fail closed when enabled. Settings reads use only a short fresh-disabled cache grace, runtime checks
  must verify TUN/NET_ADMIN/OpenVPN support, and reconnect logic must re-check the tunnel before chapter/page-heavy
  phases instead of assuming an existing process is still valid. Enabled idle VPN state should be reported as `armed`
  rather than failed; the admin test route must reuse the same connection guard and leave a successful enabled tunnel
  connected for later protected downloads.
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
- Durable mega `/downloadall` runs live under Raven's `/v1/downloads/bulk-runs` API and must persist parent run plus
  batch state through Sage's generic job broker. Preserve group-first ordering for expanded runs (`A Manga`, `A
  Manhwa`, `A Manhua`, `A OEL`, then `B...`), preserve the caller's `nsfw` filter, keep each batch on the
  WeebCentral-only metadata confidence path, store the run-owned Raven title task ids in batch state, and resume by
  skipping completed batches instead of re-queueing them.
- Every `/downloadall` execution should create a durable run, not only expanded mega runs, so delayed completion,
  stale-task handling, summary DMs, reaction approvals, and continue prompts survive process restarts. `groupsize`
  maps to `batchesPerApproval`, so Raven should process that many batch tasks before pausing. Stale run-owned title
  tasks should count as failed after the timeout/retry budget and must not block the next batch forever.
- `/v1/library?view=card` is the compact Moon shelf projection. Keep chapter arrays, archive paths, working roots, and
  download roots out of that response; full title and reader routes remain the detail paths.
- New Raven catalog entries should use opaque durable ids instead of title slugs. Treat title ids as opaque route
  parameters everywhere outside Raven's internals.
- Download tasks should only reach `100%` after file promotion and brokered catalog persistence both succeed. When a
  persist step fails, fail the task loudly instead of leaving it running at `90%`.
- Raven-originated task, catalog, and request-lifecycle changes that matter to Moon admin should now be forwarded
  through Sage's internal broker routes so Vault can append them into the shared durable event log.
- Startup recovery should rescan finished `downloaded/<type>/...` content, backfill missing catalog rows, and collapse
  duplicate restorable tasks so Moon queue views only see one logical download. Keep this recovery after Spring's ready
  event and keep Sage broker calls explicitly timeout-bound so a large catalog or slow broker write cannot hold Raven
  below healthy.
- Raven now runs up to two title downloads globally. Preserve priority ordering across those two active slots and keep
  queued-task move up/down behavior limited to work that has not started yet.
- Preserve real task telemetry for Moon admin. Active title tasks should carry a true `startedAt` when the attempt
  begins, and Raven should only expose `downloadSpeedBytesPerSecond` when it can measure a credible live rate from the
  current work instead of inventing one.
- Keep queue recovery semantics tight. Failed or stale title tasks can feed Moon's `Needs attention` surface, but
  unrelated operational or service events should never be reclassified as Raven queue recovery items. Removing a failed
  or stale queued task may delete only its incomplete managed `downloading/<type>` working folder, never promoted
  library content.
- When upstream image URLs return 404, Raven should refresh the chapter page list first. True page failures should
  create generated "Possible missing page" placeholders, mark chapters as `possible_missing_page` or
  `missing_content` by deterministic thresholds, and keep the rest of the title or run moving. If too few chapters are
  clean, mark the title `bad_source` with a clean/total summary.
- Title status values persisted to Vault must stay bounded to `active`, `completed`, `hiatus`, `cancelled`,
  `upcoming`, or `unknown` so oversized upstream status labels cannot break catalog persistence.
- Raven now also supports staged source replacement for existing library titles. Keep replacement downloads isolated in
  fresh working and downloaded roots, then only swap the live folder and catalog identity after the replacement
  succeeds.
- Raven now also participates in Moon admin's root-only content reset. Keep the preview plus execute endpoints limited
  to Raven-owned managed scope: catalog rows, Raven task state, and managed `downloading/<type>` plus
  `downloaded/<type>` folders. Do not let Raven clear shared users, settings, secrets, or durable events.
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
