# Raven Agent Guide

Read this before editing `services/raven`.

## Role

Raven is Scriptarr's Java download, library, metadata, and VPN-aware download engine.

## Hard Rules

- Keep Raven Java-first.
- Keep Raven on the Spring Boot and Java 24 path.
- Organize downloader, library, metadata, and provider responsibilities into clear modules.
- Raven replaces Komf; do not add Komf or Kavita coupling back in.
- Keep Raven's durable catalog, download task state, and generic async jobs behind Sage-brokered Vault storage instead
  of reintroducing local-only or Komf-owned storage.
- Keep Raven on Sage's internal broker routes for first-party shared state. Raven should not call Vault directly.
- Keep Raven's dynamic library type labels and managed storage lifecycle intact: active work belongs under
  `downloading/<type>/...`, canonical CBZ archives under `downloaded/<type>/...`, and derived WebP reader pages under
  `ingested/<type>/<titleId>/<chapterId>/...`.
- Keep download intake metadata-first and provider-based. Metadata providers should resolve first, then enabled
  download-provider implementations should match aliases and produce the concrete queue target.
- New download sources should land as discrete provider implementations under Raven's provider registry instead of
  bloating one generic scraper.
- Keep chapter/page naming configurable only through the Sage-backed `raven.naming` setting. Title-folder naming stays
  Raven-owned and compatible with rescans unless product requirements explicitly expand that contract.
- Keep VPN-backed downloads fail-closed when Raven VPN is enabled and Raven cannot safely confirm or establish the tunnel.
- Raven download tasks must not hit `100%` until file promotion, brokered catalog persistence, and WebP ingest all
  succeed. If persistence or ingest fails, fail the task with the real error instead of leaving it hanging at `90%`.
- `/downloadall` must skip completed catalog titles, append only missing/new chapters for existing non-completed
  titles, reject invalid provider URLs, and create durable runs that cannot stall forever on a stale title task. If a
  stale running title cannot be cancelled into retryable work, persist a paused batch/run recovery action with the
  exact task id and admin follow-up.
- Page-level source damage should become catalog quality data, not a whole-title dead end: refresh page lists after
  image 404s, generate Scriptarr missing-page placeholders when needed, and mark partial, missing-content, or
  bad-source quality states deterministically.
- Reader page serving is WebP-first. Do not extract CBZ pages on demand for normal reads; LibraryService should serve
  ready chapters from ingested manifests and stable `p000001.webp`-style page files while keeping controllers thin.
- Manual CBZ import is separate from WebP ingest. `/v1/imports` should copy approved Raven-visible CBZs into the
  canonical downloaded tree and queue ingest; `/v1/ingest` owns backlog, retry, hardware state, and manifest generation.
- Startup recovery should reconcile finished `downloaded/<type>/...` archives back into the catalog and collapse
  duplicate restorable tasks for the same logical request or title, but it must run after Raven exposes health so a
  large catalog or slow broker write cannot keep the container unhealthy.
- Old Noona Raven and Komf code are reference material only. Port behavior intentionally, but do not restore Selenium
  or browser-driven scraping.
- Manual metadata overrides are admin-visible contracts and should stay documented.
- Keep full JavaDoc on Raven main and test Java sources. `gradlew check` is the expected enforcement path.

## Coding Map

- Public Raven endpoints live in `src/main/java/com/scriptarr/raven/api/RavenController.java`; keep controllers thin
  and move behavior into downloader, library, settings, metadata, or VPN services.
- Download queue, active title concurrency, retry behavior, and `/downloadall` orchestration live under
  `downloader`. Durable task and bulk-run state must stay Sage/Vault-backed through `settings/RavenBrokerClient`.
- Catalog projection, file promotion, archive naming, WebP ingest, quality markers, and startup recovery live under
  `library`. Keep in-progress files under `downloading/<type>/...`, canonical CBZs under `downloaded/<type>/...`, and
  derived WebP pages under `ingested/<type>/<titleId>/<chapterId>/...`.
- Runtime settings are read through `settings/RavenSettingsService`; apply live reloads where possible without
  cancelling active titles, and let Moon/Sage surface saved-but-not-live warnings when reload fails.
- VPN behavior lives under `vpn` and should fail closed whenever VPN is enabled but tunnel setup or verification is
  unsafe.
- Prove Raven changes with `npm run test:raven`; add focused Java tests near the changed package.
