# Raven

Selected chapter repair is available in admin Missing Content for chapters with saved source identities.
It retries only the selected damaged chapters and requires the configured WebP worker. Unsupported local AVIF
repair is rejected before conversion, preserving existing reader revisions. The current readable version stays published until the complete
source archive, WebP output, and catalog acknowledgement are verified. Unavailable source pages remain unresolved;
repairs do not switch sources automatically. Library rescans preserve unavailable chapter rows and their source evidence.

Bulk downloads preserve completed archives and ready WebP chapters across broker interruptions. Short outages
wait for recovery; unresolved work remains visible and can be retried by continuing the same run through Noona.
Paused runs keep observing previously accepted work without starting new work. A source page that explicitly
reports an unavailable series with no chapters is reported as an unavailable-source skip, separately from
successful downloads. An empty, challenged, or rate-limited response still requires recovery.
Chapter page-list timeouts and image transport/server failures also remain retryable failures. They do not create
missing-content catalog rows or generated missing-page artwork. Verified image 404s and damaged image bytes retain
their explicit source-quality handling.
Retained placeholder archives preserve their missing-page information across retries. Staged pages are reused only
for the same ordered source page list, so a refreshed list cannot mix old and replacement images.

Raven is Scriptarr's Spring Boot Java 24 download, library, and metadata engine.

It owns the built-in metadata stack that replaces Komf, keeps MangaDex enabled by default, enables Anime-Planet ahead
of MangaUpdates for scrape-based enrichment, and supports optional PIA/OpenVPN-backed downloads using the simplified
Moon admin VPN settings.

Fresh installs now expose an empty library instead of demo titles. Moon stays empty until Raven has real imported
titles to surface.

Raven now reaches shared settings and durable catalog state through Sage's internal broker routes. Sage owns the
first-party hop to Vault, while Raven stays responsible for download execution, source scraping, provider calls, and
reader-ready library projection.

Completed downloads now use Raven's managed storage layout under the existing `/downloads` mount:

- `/downloads/downloading/<type-slug>/<title-folder>`
- `/downloads/downloaded/<type-slug>/<title-folder>` for canonical CBZ archives
- `/downloads/ingested/<type-slug>/<titleId>/<chapterId>/<webp-revision>` for immutable WebP reader pages and `manifest.json`

Manual library import and normal downloads converge on the same canonical CBZ layout. `/v1/imports` accepts
Raven-visible CBZs from `import-staging` or existing downloaded storage, copies approved archives into
`downloaded/<type-slug>/<title-folder>`, catalogs the title or chapter rows, and queues reader-page processing.
A chapter needs acknowledged ready metadata, its logical page count, and a complete manifest before Moon can serve it.
Existing AVIF chapters remain readable while new WebP pages are prepared.
Retrying a damaged WebP chapter can restore its validated completed artifact from the canonical CBZ workflow without
encoding again. The catalog repair is fenced to the unchanged current chapter and keeps source-quality history.
A lost chapter manifest can be restored from that accepted artifact while retaining matching reader files and the
original completion time. Recovery rejects foreign, linked, or differing retained files instead of replacing them.
Before Raven creates or catalogs a title, it resolves the logical catalog identity of library type plus normalized title
against Vault's compact title-card projection. Downloads, manual imports, startup rescans, and AVIF ingest setup should
therefore reuse the canonical title id even when the same title appears under a different source or filesystem folder.
The distributed setup runs Raven as `coordinator` on the canonical-storage host and an `ingest-worker` on the assigned
worker host. Selecting `SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT=webp` implies remote-only processing, even without an
assigned worker. `SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED=true` also selects that policy. It waits when the worker is unavailable
and never falls back to local encoding. The worker uses FFmpeg WebP quality `85`, method `4`, two encoder threads, one
page at a time and one chapter at a time. Its container is limited to two CPUs and 4 GiB; the durable pool permits one
active encoding lease across all workers. The worker has disposable scratch only and reaches Sage over verified TLS.
Chapter input and result-upload requests use Sage's fifteen-minute binary transfer budget, including result validation.
Control requests retain their two-minute deadline; lease expiry and cancellation still stop stale work.
New conversion jobs and reader revisions also bind the frozen logical page order. Changing page naming settings can
produce a separate ordered revision when conversion is requested; existing WebP and AVIF output remains readable.

Source images are split into exact two-dimensional WebP segments, each at most 16383 pixels per side and 64 Mi pixels.
Native header and sequential region processing avoid decoding the full oversized image in Java or passing an image
beyond FFmpeg's decoder limit. New output uses a distinct segmentation profile; earlier WebP and AVIF stay readable.
Reader navigation and saved progress still count original logical pages. The reader composes every segment, and cover
fallback uses a thumbnail of the whole first page. Source archives and source-quality evidence remain unchanged.

Whole-library WebP migration is opt-in and initially paused. The protected operator controls can start, pause, resume,
or retry it without restarting Raven. Background work yields after each chapter; fresh/user work takes priority.
Pausing lets the current chapter checkpoint finish. A failed migration preserves an existing valid AVIF chapter.
Whole-library WebP scheduling reads a complete canonical catalog snapshot. An unavailable or malformed catalog fails
preparation instead of reporting an empty or partially enumerated library as complete; retry it after catalog recovery.
Verified chapters avoid repeated full reads as migration advances. Completion still checks every canonical archive
and reader file again; changed or missing content cannot be hidden by earlier progress.

Legacy standalone AVIF encoding remains available for compatibility. Set `SCRIPTARR_RAVEN_AVIF_ENCODER` to:

- `auto` (default): encode a real test page with `av1_nvenc`, then use `libaom-av1` when NVIDIA AV1 encoding is unavailable.
- `nvenc`: require a working NVIDIA AV1 encoder; unsupported GPUs and driver failures block ingest with an actionable status.
- `cpu`: use `libaom-av1` without requiring NVIDIA hardware or drivers.

The selected backend stays fixed until Raven restarts, so a chapter never changes encoder halfway through conversion.
Changing the encoder does not invalidate already-ready AVIF chapters whose source archive has not changed. New manifests
record the actual encoder and keep the existing AVIF filenames and reader contract. Ingest status reports `cpu-avif` or
`nvidia-avif`; unavailable encoders block ingest without making Raven's overall health fail. Legacy NVIDIA-required flags
do not override the explicit encoder policy.

Raven converts pages with a bounded per-chapter window (`SCRIPTARR_RAVEN_AVIF_PAGE_CONCURRENCY`, default `4`, max `8`)
and a shared global encoder pool (`SCRIPTARR_RAVEN_AVIF_ENCODER_SLOTS`, default `6`, max `8`). For CPU encoding on a
shared media server, set both concurrency values to `1` and use `SCRIPTARR_RAVEN_AVIF_THREADS=2` (default `2`, range
`1`–`16`). The image build verifies CPU encoding and decoding of JPEG, PNG, odd-sized, and tall pages; it does not require a GPU.

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
enable/region/credentials admin contract, but the runtime now refreshes stale PIA profiles, validates downloaded
profile archives before replacing the cache, reconnects on region changes or a dead tunnel, and uses short-lived
credential files with `--auth-nocache`. Raven health includes `runtimeCapable`, `settingsFresh`, `protected`, and
`lastError` so Moon can show whether direct downloads are intentionally blocked. An enabled idle VPN reports `armed`
until a download or admin test starts OpenVPN; the brokered `/v1/vpn/test` path uses the same fail-closed guard and
leaves a successful enabled tunnel connected.

Raven's request intake is now provider-based on the download side. Enabled metadata providers run first, Raven expands
aliases from those results, then the enabled download-provider registry checks site-specific scrapers for a concrete
match. WeebCentral stays first by default, MangaDex is now a second normal download-provider option, and the registry
contract is in place for future sites after those two.
Raven intake is also edition-aware and grouped by concrete provider target, so metadata variants that resolve to the
same download URL collapse into one requestable result while plain vs colored editions stay separate when the provider
exposes different series URLs.
The DM-only Discord `downloadall` flow uses the same metadata-aware path for each bulk-browsed provider title. It
only queues titles with one confident metadata match and reports already-active, adult-content, no-metadata,
and ambiguous-metadata exclusions instead of bulk-queueing metadata-less library entries. When the
command uses `nsfw:false`, Raven verifies the concrete WeebCentral title page and only queues titles with an explicit
`Adult Content: No`; adult or unverified titles are skipped. That command is intentionally locked to the WeebCentral
provider and fails when WeebCentral is disabled rather than falling back to MangaDex.
Raven also exposes durable async bulk-run orchestration under `/v1/downloads/bulk-runs` for owner flows that need
mega `downloadall` runs. A run can target one type/group or expand `type:all` and `titlegroup:all` into A-Z batches
ordered group-first, then type. Run and batch state persist through Sage's generic job broker. Each batch records its
owned title tasks and keeps completed outcomes across restarts and local history pruning. Started runs recover only
after the download queue has fully restored; paused runs and deliberately unstarted runs wait for the owner.

`groupsize`/`batchesPerApproval` controls how many **type-and-letter batches** run before the next approval; it does not
limit titles. For example, `type:Manhua nsfw:False titlegroup:t groupsize:20` creates one T/Manhua batch and considers
every matching title. Download worker concurrency remains a separate setting.

A failed source scan, unresolved title, missing owned task, or exhausted retry allowance pauses the run with the exact
recovery identities. Failed task records and partial files remain available for inspection. A long queue wait does
not expire healthy work. Each owner approval allows up to three attempts per unresolved title, while total attempts
remain visible. Restarts and lost retry responses do not grant extra attempts. Continue retries unresolved work and
preserves completed titles and policy exclusions. Retried
Discord commands and approval actions reuse their existing run or accepted decision rather than advancing another
window. Reading status never starts work.
If a broker outage prevents a failed title from saving its terminal state, background recovery saves that failure
after the broker returns. It retains partial files and attempt history; a paused run still waits for owner approval.
After a restart, healthy canonical CBZs can finish reader-page processing without fetching those chapters again.
Append recovery keeps earlier readable chapters, and failed work still waits for its approved retry.
Startup catalog scans also retain valid ready-page metadata when the underlying archives have not changed.
Archive metadata such as `ComicInfo.xml` does not increase page counts. Older inflated counts can be corrected without
rebuilding validated ready pages.

Completion requires finished discovery and successful owned work, including canonical CBZ files, saved catalog state,
and all ready reader pages and segments. A source publication marked completed does not skip an empty or damaged local
title; missing chapters are queued after source and metadata ownership are verified. Distinct provider editions cannot
write the same canonical identity. Source-quality markers and generated missing-page placeholders remain visible through the
existing quality and missing-content screens; completion does not erase them.

Scoped content reset is a separate, guarded operator workflow. Preview resolves exact durable plan ownership, deduplicates
canonical identities, and records the reviewed file inventory. Apply fences actual writers and removes only that inventory;
an interrupted apply can resume without accepting new or changed files. It retains stable title identities, metadata,
covers, follows, reading progress and all run/task/job history. The broad global reset is not used for this operation.
`/v1/library?view=card` returns the compact Moon shelf projection without chapter arrays or filesystem roots. It
accepts `q`, `type`, `letter`, `cursor`, `pageSize`, `sort`, and exact `ids`, forwards those filters through Sage to
Vault's title-only projection, preserves requested exact-id ordering for activity cards, and keeps full title and
reader routes as the detail paths.
Raven now also treats cover art as first-class title metadata, carries it through intake, queue state, and library
records, and exposes the same imagery Moon and Portal reuse in their UIs and embeds.
Recovery also restores missing cover metadata from the saved download request, including source-only artwork,
while preserving existing covers, canonical archives and ready reader pages. Append requests retain artwork already
found during source browsing when no cover was selected earlier.
Cover repairs also survive ongoing ingest and rescan checkpoints. A background update with no artwork keeps a cover
that was saved while the work was running; explicit nonblank artwork updates remain supported.
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

Download completion now waits for file promotion, brokered catalog persistence, and AVIF ingest before a task can reach
`100%`. If catalog persistence or ingest fails, Raven marks the task failed instead of leaving it stuck at `90%`.
Ingest failures keep the CBZ and publish retryable `Needs attention` work; cleanup removes only staged or derived ingest
files. On boot, Raven also rescans the existing `downloaded/<type>/...` tree to backfill missing catalog rows from
already-finished archives. Startup recovery indexes saved canonical paths in the background and skips unchanged folders.
The scan resolves a folder's saved canonical path before
matching its display name, so metadata renames retain the title and chapter identities. Multiple titles claiming the
same path remain untouched and appear in the durable rescan recovery diagnostics; resolve ownership before rescanning.
The scan keeps its in-memory catalog context current as it repairs folders, which prevents two folders discovered in the
same pass from creating duplicate durable rows for the same logical title.
During AVIF ingest, Raven checkpoints each chapter's terminal `ready`, `missing`, or `failed` state through Sage's
single-chapter broker route instead of replacing the full chapter list after every chapter. Full chapter-list
replacement remains for catalog creation, imports, rescans, and merge repairs, while hot ingest progress writes are
throttled and ready chapters with the current AVIF revision are reused so large retries do not flood Vault/MySQL.

Raven's global title-download concurrency is now controlled by the Sage-backed `raven.download.runtime` setting. The
default remains two active title downloads, admins can choose `1` through `6` from Moon Settings, and Raven reloads the
value live through `/v1/downloads/runtime/reload` without cancelling already-running titles. Lower limits pause new
starts until enough active work finishes. Page fetches inside a title still use their existing fixed two-worker
concurrency, preserve archive ordering, skip already-written files on retry, and collapse duplicate restorable tasks
for the same logical request during recovery.
Raven task snapshots now also preserve a real `startedAt` for active download and AVIF-ingest attempts so Moon can show
queue ETA once Sage has enough progress data. When a chapter download yields credible timing data, Raven also records a
live `downloadSpeedBytesPerSecond` value that Moon can show on running queue cards. Recovery or needs-attention views
should still stay limited to Raven title-task state instead of pulling in unrelated service events. Failed or stale
queued tasks can be removed from recovery, which clears the persisted task and deletes only the incomplete managed
`downloading/<type>` working folder.
When an upstream page image returns `404`, Raven now skips same-URL image retries, refreshes the chapter page list on
the next chapter attempt, and leaves a clearer source-image failure if the refreshed source still points at missing
images.
Reader page serving reads saved AVIF or segmented WebP manifests instead of extracting CBZ pages on demand. New ingest
converts ordered archive pages into WebP segments and stores their logical-page mapping in an immutable chapter manifest.
The existing Moon/Sage reader routes serve `image/webp` for those segments and retain `image/avif` for legacy output.
Raven also exposes a redacted page probe
for Moon and keeps Missing Content quality fields available for damaged source detection.
Raven also accepts `POST /v1/ingest/runs` for Appa/Sage-owned library-type reingest jobs. These jobs rebuild only the
derived reader pages from existing canonical CBZ archives, create one durable task per ready title, continue after
per-title failures, and reuse the active queued or running run id when the same library type is already being rebuilt.
`GET /v1/ingest/runs` returns bounded active, recent, or all run summaries for admin surfaces without returning every
child title task, including the scheduler state, current title, queue position, last progress time, and conservative
ETA when Raven has credible timing. `/v1/ingest` includes active and recent run summaries alongside the per-title
backlog. Type-wide rebuilds use balanced fair title lanes (`SCRIPTARR_RAVEN_AVIF_TITLE_LANES`, default `2`, max `3`).
The legacy AVIF setting remains supported; `SCRIPTARR_RAVEN_INGEST_TITLE_LANES` is used only when it is unset or blank.
Legacy mode processes one title per leased library type; WebP migration checkpoints one chapter, then rotates to the next active type instead of
marking waiting runs as fake-running. A per-title lock still serializes duplicate attempts for the same title id.
The clean restart/admin flow (`POST /v1/ingest/runs/clean-restart`) supersedes active AVIF runs without deleting
catalog data or CBZ archives, compacts old superseded run noise, then starts fresh runs in OEL, Manhua, Manhwa, Manga,
Webtoon, Comic order. It creates lightweight preparing run summaries first, then materializes the per-title durable
tasks in the background so the browser request does not wait on thousands of broker writes.
If Raven restarts or loses its broker connection mid-run, startup recovery and duplicate same-type requests reattach the
durable run, preserve already failed title tasks, and continue unfinished queued or stale-running tasks. Active legacy
WebP-format runs are marked `superseded` before a new AVIF run is accepted for that type.
Admins can resume, cancel, or restart active type runs through Raven's run-control endpoints, which Sage exposes through
Moon-safe admin routes.
When a duplicate merge changes the active type's canonical title set, the next same-type ingest request supersedes the
stale run and starts a new one with one task per canonical title.
Raven keeps `/v1/ingest` and Appa preview paths on compact title-card projections so backlog and count views do not
hydrate full chapter arrays; full title payloads stay reserved for single-title, reader, and actual ingest work.
For long-running WeebCentral series, Raven now follows the source page's HTMX full-chapter-list flow instead of only
the initial visible subset, which fixes partial-history titles such as Tomb Raider King.

### Source-verified metadata recovery

Metadata providers remain the first choice. Bulk intake checks the exact source, complete aliases and edition facts before accepting a provider match. Complete, explicitly non-adult source metadata can serve as a clearly labelled fallback. A verified admin correction is saved against its source and reused during bulk recovery. Conflicting editions or adult classifications pause for attention.

From the admin queue, the configured Noona owner can inspect a paused run and recheck its metadata skips. This preserves completed downloads and prior decisions and does not start the run. Continue the same run through Noona after repair.

Rechecking metadata skips also prepares their parent batches, including previously completed batches. Prior results remain in history. Supported MangaDex downloads retain their source identity for metadata repair.

Source metadata reads one title heading even when the provider repeats it for mobile and desktop layouts. Linked creator and tag fields remain attached to their original source provenance.

Original and reboot editions can share translated aliases while retaining separate source identities. Shared aliases do not merge those editions or authorize writing into another edition's folder.

Recovery also rejects CBZ pages with empty or zero-filled headers, even when the ZIP checksum is valid. Healthy chapter archives remain reusable; damaged chapters return to download repair before reader conversion.
