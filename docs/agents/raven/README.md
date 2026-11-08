# Raven AI Notes

- Raven stays Java-first and now runs on Spring Boot with a Java 24 toolchain.
- Raven owns downloader, library, metadata, PIA/OpenVPN download support, and provider orchestration.
- Raven must not call Vault directly anymore. Shared settings, secrets, titles, chapters, metadata matches, and task
  snapshots all flow through Sage's internal broker routes.
- Raven's internal Sage broker client should use plain HTTP/1.1. Do not let Java's default HTTP version negotiation
  stall Raven-to-Sage calls against Sage's Node HTTP server.
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
- Cover retention is independent of metadata-match eligibility. `DownloaderService.persistSelectedMetadata` first
  retains an existing saved request cover when the catalog has none, so both canonical ingest recovery and
  already-ready completion recovery preserve source-only artwork. `LibraryService.retainCoverUrl` writes the title
  summary only, leaves chapter/AVIF state untouched, and never replaces nonblank catalog art. Metadata application
  may also fill missing art. Bulk append plans use already-browsed cover URLs only when earlier selected download or
  metadata art is absent; do not change frozen requests during status reads or recovery.
- `LibraryService.upsertTitle` serializes blank-cover checkpoints with artwork repairs and uses only the existing
  exact-id compact-card lookup (`ids`, `pageSize=1`). `LibraryCoverCheckpoint` accepts complete zero-row responses for
  new titles and retains stored art from one correctly scoped card. Vault resolves aliases and echoes canonical ids
  in `filters.ids`; validate card ownership against that scope rather than rejecting a legitimate renamed identity.
  Failed, malformed or incomplete lookups must not reach the title PUT. Do not use `findTitleById` for this decision:
  its reader-friendly error handling returns null on broker failures. Nonblank incoming covers bypass preservation,
  and chapter checkpoint APIs remain unchanged.
- Keep full JavaDoc on Raven main and test Java sources and let `gradlew check` fail when doc coverage regresses.
- Fresh installs must not reintroduce demo titles; Raven's default library state is empty until real ingest exists.
- Raven library storage now uses dynamic source-backed type labels and the managed folder lifecycle:
  - `/downloads/downloading/<type-slug>/<title-folder>`
  - `/downloads/downloaded/<type-slug>/<title-folder>` for canonical CBZ archives
  - `/downloads/ingested/<type-slug>/<titleId>/<chapterId>` for derived AVIF reader pages
- Manual imports and normal downloads must converge on the same canonical CBZ layout before ingest. `/v1/imports`
  should only accept Raven-visible CBZ files under import-staging or downloaded storage, then queue AVIF ingest.
- Library-type reingest runs live at `/v1/ingest/runs` for Sage/Appa. They rebuild only derived AVIF pages from
  existing canonical CBZ archives, create durable per-title tasks, continue through individual title failures, and
  return the existing run id when the same type already has a queued or running rebuild. Startup recovery and duplicate
  same-type requests must reattach detached queued/running runs, preserve already failed title tasks, and continue only
  unfinished queued or stale-running tasks. Legacy WebP-format active runs should be marked `superseded` before the
  AVIF run starts. If duplicate active same-type durable runs are found at startup or scheduling time, keep the
  preferred run and mark the rest `superseded` before any title work can run for both.
- Keep type-wide AVIF rebuilds on bounded fair title lanes (`SCRIPTARR_RAVEN_AVIF_TITLE_LANES`, default `2`, max `3`).
  Only leased run/tasks should be marked `running`; unfinished runs beyond the lane count should remain queued or
  waiting with a bounded queue position. Summaries may expose scheduler state, current title text, last progress, and
  ETA, but never full child task arrays or storage paths. Resume, cancel, restart-active, and clean-restart controls
  should change durable run state without creating duplicate active runs. Clean restart must be ingest-only: supersede
  AVIF run jobs quickly, hide superseded run noise from normal summaries, and start fresh runs OEL-first without
  deleting catalog rows, child task history, or CBZ archives.
  Restart actions should return bounded preparing run summaries quickly and materialize large per-title task sets in
  the background before queueing them onto the fair scheduler.
- If the canonical title set changes because Vault merged duplicate catalog rows, a same-type ingest request should
  supersede the stale active run and queue a fresh AVIF rebuild over canonical title ids only.
- Keep `/v1/ingest` backlog and Appa preview/count paths lightweight. They should use compact title-card projections
  and must not pull full title records with chapter arrays just to count eligible library types.
- Reader serving is AVIF-first. A chapter is readable only after ingest writes stable `p000001.avif`-style page slugs,
  a `manifest.json`, and ready ingest metadata with a current `avif-` revision into the catalog.
- Ingest failures keep the CBZ, delete only staged or derived ingest output, and surface as retryable Needs attention
  work with `recoveryAction: retry-ingest`.
- Per-title AVIF ingest must checkpoint individual terminal chapter state through Sage's single-chapter Raven broker
  route. Do not call full chapter-list replacement from the hot loop; reserve full replacement for catalog creation,
  import, rescan, and merge flows. Avoid per-chapter `running` writes unless a future UI needs time-throttled
  long-chapter visibility.
- Keep AVIF conversion page-parallel but bounded. `SCRIPTARR_RAVEN_AVIF_PAGE_CONCURRENCY` defaults to `4` and
  `SCRIPTARR_RAVEN_AVIF_ENCODER_SLOTS` defaults to `6`; both should stay capped so Raven uses the NVIDIA encoder
  effectively without spawning unbounded FFmpeg processes.
- Before retrying a ready chapter, verify the existing AVIF revision, manifest, and page files. Reuse unchanged ready
  chapters instead of forcing the GPU to rebuild pages it already produced.
- The v1 ingest encoder is FFmpeg `av1_nvenc`. NVIDIA runtime checks are required for AVIF ingest when the profile or
  AVIF env requires it, but missing hardware should degrade the ingest surface with `hardware_missing` instead of
  failing the whole Raven service.
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
  maps to `batchesPerApproval`, never a title limit. `Manhua` / `false` / `t` / `20` is one batch covering all eligible
  T-prefix Manhua titles. Preserve the configured title and encoder concurrency independently.
- `BulkQueueCoordinator` owns strict discovery, title plans, and enqueue ownership. Persist stable run/batch/plan/task
  identities before queueing; incomplete browsing, challenges, repeated pagination, and unresolved owned work pause
  instead of completing. Validate the exact provider origin/series path, actual source type, visible title prefix,
  metadata confidence, and explicit non-adult classification for `nsfw:false`.
- Keyed creation repairs missing deterministic batch rows without resetting progress; conflicting owner/filter reuse
  returns 409. Status GETs are observational. Startup and 30-second reconciliation wait for full title-task restoration
  and recover only running or explicitly started queued runs, preserving paused and cancelled states.
- Before filtering run status, that restore-gated lifecycle pass calls the downloader's synchronized terminal
  reconciliation. `BulkTaskTerminalRecovery` accepts only failed dirty local bulk snapshots with no executor, queued
  runnable, dispatch reservation or pending cancellation. Match durable owner/plan, frozen request, queued timestamp
  and retry receipt; a blank durable start is valid when its first running write never committed. Reject another
  nonblank start, newer receipt/time or terminal result. Match Vault's millisecond timestamp conversion with either
  SQL whole-second rounding or explicit truncation. Redo all three broker checkpoints, including generic jobs,
  before clearing the dirty flag. Keep unpersisted failed evidence beyond the UI's 200-terminal history limit.
  This operation does not schedule downloads, change parent status, rotate approvals or reset attempt counters.
- Read terminal outcomes from durable records beyond the local 200-task history. Queue age is not a stall. Use actual
  download and per-page ingest progress, preserving encoder waits. Completion requires every planned chapter, healthy
  canonical CBZs, persisted catalog rows, and reusable ready AVIF manifests; reuse archives during interrupted append
  or ingest. Missing, exhausted, superseded, or unplanned legacy work pauses with IDs and reasons, retaining evidence.
  Each explicit approval grants unresolved titles three attempts while preserving cumulative history. Durable
  `approvalGeneration` on completed batches also accounts for a crash before the parent approval counter is saved.
- Owned retry acceptance persists `details.bulkRetryAttempt` with its stable identity and cumulative/current-approval
  ordinals before executor dispatch. Reconcile those child counters before allocating another retry; a lost parent
  checkpoint cannot grant extra attempts. The same accepted queued attempt can reattach a missing local worker once,
  while terminal receipt replay never executes again. Preserve the receipt through task restoration and details
  rebuilding, and do not spend an allowance on a definite rejection before acceptance.
- `CanonicalArchiveRecovery` verifies cataloged archives or reconstructs planned rows before source/VPN requests.
  Healthy canonical CBZs can resume ingest offline; `AppendChapterMerger` retains untouched chapter IDs and ready
  reader metadata. Replacements retain their full replacement semantics. Failed owned tasks remain failed on startup
  until the approved bulk retry or an explicit retry queues that same identity again.
- Startup catalog scans preserve each validated ready chapter when its archive path, number, page count, and AVIF
  revision still match. `LibraryTitleLocks` counts active and waiting title operations so scan writes cannot erase
  newer ingest checkpoints. Keep the service monitor out of the wait for a title lease to avoid lock inversion.
- `ArchiveImageEntries` defines supported CBZ image entries for import, scans, ingest, recovery, and completion.
  Metadata such as `ComicInfo.xml` is not a page. Correct legacy inflated counts only after validating existing ready
  manifests; preserve AVIF revisions, timestamps, files, and quality evidence. Prefer a persisted archive path's known
  chapter identity during scans, and keep filename parsing aware of optional volume fields and numeric series names.
- Continue/cancel consumes the captured `approvalId` before scheduling and retains a compact accepted receipt.
  Replays return that receipt; stale or opposite decisions cannot affect a later approval window. Cancellation closes
  the enqueue gate and reconciles owned tasks and batch checkpoints after in-flight discovery callbacks finish.
- `/v1/library?view=card` is the compact Moon shelf projection. Accept and forward `q`, `type`, `letter`, `cursor`,
  `pageSize`, `sort`, and exact `ids` through Sage to Vault's title-card endpoint, preserving requested exact-id
  ordering for activity hydration. Keep chapter arrays, archive paths, working roots, and download roots out of that
  response; full title and reader routes remain the detail paths.
- New Raven catalog entries should use opaque durable ids instead of title slugs. Treat title ids as opaque route
  parameters everywhere outside Raven's internals.
- Before creating a Raven title id in download completion, manual import, startup scan, or ingest setup, resolve the
  canonical catalog identity using library type plus normalized title. Keep the scan context updated as repaired folders
  are persisted so one startup pass cannot create two rows for the same logical title.
- Download tasks should only reach `100%` after file promotion, brokered catalog persistence, and AVIF ingest all
  succeed. When a persist or ingest step fails, fail the task loudly instead of leaving it running at `90%`.
- Raven-originated task, catalog, and request-lifecycle changes that matter to Moon admin should now be forwarded
  through Sage's internal broker routes so Vault can append them into the shared durable event log.
- Startup recovery should rescan finished `downloaded/<type>/...` content, backfill missing catalog rows, and collapse
  duplicate restorable tasks so Moon queue views only see one logical download. Keep this recovery after Spring's ready
  event, use compact title-card indexes before loading individual existing titles, skip unchanged folders, and keep
  Sage broker calls explicitly timeout-bound so a large catalog or slow broker write cannot hold Raven below healthy or
  starve auth/bootstrap traffic. The long startup rescan must not hold the same `LibraryService` monitor used by
  per-title AVIF ingest; fresh or recovered ingest runs need to write progress while the rescan is still walking the
  catalog.
- Raven title-download concurrency is brokered through `raven.download.runtime`. Keep the default at two active titles,
  allow only `1` through `6`, reload it live without cancelling running downloads, and preserve priority ordering plus
  queued-task move up/down behavior for work that has not started yet. Per-title page download concurrency stays fixed.
- Preserve real task telemetry for Moon admin. Active title tasks should carry a true `startedAt` when the attempt
  begins, including AVIF ingest retries, and Raven should only expose `downloadSpeedBytesPerSecond` when it can measure
  a credible live rate from the current work instead of inventing one.
- Durable AVIF type runs should expose bounded summaries through `/v1/ingest/runs` and `/v1/ingest`, not full child
  title-task arrays. Keep child task detail behind explicit status calls so Moon's queue and ingest pages can refresh
  quickly while large type-wide rebuilds are active. Summary reads should degrade to Raven's last recovered durable run
  snapshot during transient Sage/Vault timeouts instead of failing the admin page.
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
