# Scriptarr AI Docs

This tree is the internal knowledge base for AI contributors.

Audience split:

- public and self-hosters: root and service `README.md`
- server admins: [../../ServerAdmin.md](../../ServerAdmin.md)
- AI contributors: this folder and the service `AGENTS.md` files

## Working Map For New Agents

Start a task like this:

1. Run `git status --short` and preserve unrelated dirty work.
2. Read root [../../AGENTS.md](../../AGENTS.md), then the closest service `AGENTS.md` before editing under
   `services/`.
3. Use `rg` or `rg --files` to find the owning route, component, controller, or test.
4. Sketch the request path before changing code so Moon, Sage, Vault, Portal, Raven, Oracle, and Warden keep their
   ownership boundaries.

Service ownership:

- Moon owns browser-facing user, reader, and admin pages, same-origin proxies, public API docs, and Next builds.
- Sage owns auth, access grants, Moon v3 admin/user APIs, internal service brokerage, AI tool enforcement, and workflow
  coordination.
- Vault owns durable records and is the only first-party service allowed to talk to MySQL.
- Portal owns Discord gateway events, slash commands, DMs, reactions, trivia runtime, and notification delivery, but
  persists and decides state through Sage.
- Raven owns source scraping, downloader queues, `/downloadall`, library file promotion, media quality, naming, and VPN
  protection.
- Oracle owns AI chat/assist responses only; it may advise, but it must not execute Scriptarr mutations directly.
- Warden owns container plans, Docker lifecycle, updates, health checks, and production service convergence.

How to choose the edit point:

- User/admin browser symptom: inspect Moon first, then the Sage route Moon calls, then the owning internal service.
- Discord symptom: inspect Portal first, then the Sage broker route and Vault/Raven state it depends on.
- Durable-state symptom: inspect Sage's broker call and Vault's store before changing any service-local cache.
- Download/library/VPN symptom: inspect Raven, but keep shared state through Sage and Vault.
- Docker, image, first-boot, update, or LocalAI lifecycle symptom: inspect Warden and its service plan/runtime code.

Common code paths:

- Admin pages: `services/moon/apps/admin-next/components`.
- User app pages: `services/moon/apps/user-next/components`.
- Reader app pages: `services/moon/apps/reader-next`.
- Moon v3 proxy and public routes: `services/moon/lib`.
- Moon bundle reporting: `services/moon/scripts/report-bundles.mjs` reads Next diagnostics from
  `.next/diagnostics/route-bundle-stats.json`.
- Moon user card pieces: `services/moon/apps/user-next/components/TitleCard.jsx`,
  `services/moon/apps/user-next/components/home/HomeArtCard.jsx`, and
  `services/moon/apps/user-next/components/CoverImage.jsx`.
- Sage Moon v3 and internal broker routes: `services/sage/lib/registerMoonV3Routes.mjs` and
  `services/sage/lib/registerInternalBrokerRoutes.mjs`.
- Vault reader-target and compact-card state: `services/vault/lib/createStore.mjs`,
  `services/vault/lib/createCachedStore.mjs`, and `services/vault/lib/createVaultApp.mjs`.
- Portal Discord commands/runtime: `services/portal/lib/discord`.
- Raven API/downloader/VPN: `services/raven/src/main/java/com/scriptarr/raven`.
- Warden service plan/runtime: `services/warden/config` and `services/warden/core`.

Coding rules that avoid hidden drift:

- Do not add browser-direct calls to internal services. New browser APIs should be Moon-owned and same-origin.
- Do not let first-party services bypass Sage for shared state. Vault is the only database owner.
- Keep list views on compact projections. Hydrate full Raven title, chapter, manifest, or user-state payloads only for
  title/detail/reader routes or exact-id cards.
- For the unified `/library` catalogue, keep the URL as the source of truth for search/filter/view state and refresh
  only the results chunk. `/browse` remains a compatibility entrypoint. Server-side card payloads should include the
  minimal `readerTarget` needed for art-click reader links.
- Keep admin SSE shared through Moon's admin provider; page-local `EventSource` instances are a regression unless the
  route has a strong isolated reason.
- Keep stale product language out of code and docs. Scriptarr is the product, Noona is only the Discord bot/persona,
  and Kavita/Komf/old Noona Raven should appear only as explicit historical reference.
- Treat Moon, Raven, Sage, Vault, Portal, Warden, Oracle, and LocalAI as internal/admin codenames. Normal reader UI,
  public API labels, and public Discord copy should use the configured branding site name or Noona unless the surface is
  explicitly diagnostic.
- When a settings page saves durable state and runtime reload fails, preserve the saved state and surface an apply or
  restart warning instead of discarding the admin's change.

Testing ladder:

- Cross-service smoke: `npm run docker:healthcheck`.
- Deep stack flow: `npm run docker:test`, then `npm run docker:test:teardown` if the stack is left running.
- Repo JS tests: `npm run test:js`.
- Raven Java tests: `npm run test:raven`.
- Service tests: `npm --workspace services/sage test`, `npm --workspace services/moon test`,
  `npm --workspace services/portal test`, `npm --workspace services/vault test`, and
  `npm --workspace services/warden test`.
- Moon builds: `npm --workspace services/moon run build:user`,
  `npm --workspace services/moon run build:reader`, and
  `npm --workspace services/moon run build:admin`.

Performance and bundle checks:

- For Moon load-speed work, measure before editing. Capture document load, static Next JS/CSS, chrome/bootstrap calls,
  main payloads, admin event streams, byte sizes, and downstream Sage/Raven/Vault latency separately.
- Run user, reader, and admin builds before `npm --workspace services/moon run bundle:report`; the report reads Next
  diagnostics generated by the builds.
- Root `@once-ui-system/core` JavaScript imports should stay out of always-mounted Moon shells. The lazy profile-only
  style panel is the allowed exception; CSS token/style imports currently remain in layouts.
- Once UI `1.7.x` treats `compressorjs`, `prismjs`, and `recharts` as peers. If refreshing Once UI, keep the profile
  StylePanel bridge lazy, avoid root JS imports where possible, and run `npm --workspace services/moon run build:user`
  after install so missing peer resolution is caught immediately.

Production rollout rules:

- Prefer targeted image publishes for affected services instead of rebuilding unrelated containers.
- Before restarting Raven, check active downloads and `/downloadall` state so long-running work is not interrupted.
- Use Warden for prod updates and verify both stack health and the exact browser or Discord workflow that changed.
- Keep secrets out of terminal summaries, docs, commits, and final messages.

Verification defaults:

- `npm run docker:healthcheck` is the first Docker-backed smoke path for AI contributors. It rebuilds current workspace
  images by default, starts an isolated Warden-managed stack, waits for all containers to become healthy, verifies
  Warden plus Moon, and tears the stack down unless `--keep-running` is set.
- `npm run docker:test` is the heavier end-to-end path for flows that need a live stack beyond health convergence.

Architecture invariants:

- Vault is the only first-party service allowed to touch MySQL directly.
- Sage is the only supported first-party internal HTTP broker.
- Moon requests and admin add-title now share a metadata-first intake flow that persists the selected metadata first,
  then either queues an admin-picked source or waits for staff review.
- Raven intake is now grouped by concrete provider target and edition-aware, so plain vs colored variants only stay
  separate when they truly resolve to different provider URLs.
- Portal's Discord runtime is now live again, and the brokered `portal.discord` settings object is the source of truth
  for guild id, onboarding, per-command role gates, release channel posts, Noona trivia, and DM superuser rules.
- Moon now serves trusted API-key surfaces and plain same-origin Swagger docs. Search is public, protected calls use
  `X-Scriptarr-Api-Key`, system keys inherit assigned permission groups, user keys stay scoped to the owning reader,
  and accepted external requests must stay at the lowest queue priority.
- Active requests now use a durable Vault work key so duplicate submissions across Moon, Discord, admin, and the
  public API collapse cleanly under concurrency.
- Request-linked moderation and Raven completion events can now trigger one Portal DM per request state when a Discord
  id is available. Completed Raven tasks can also queue one release-channel post with a durable `release:<taskId>` ack,
  and durable `/downloadall` batches can queue requester DMs with `downloadall:<runId>:<batchId>:<status>` acks.
- Portal's `/trivia` command and guild message handler are Sage-backed. Trivia rounds, guesses, score events,
  leaderboard acks, and runtime state persist through Vault settings; Oracle may only advise borderline matches.
  Portal should reconcile one active trivia clock from Sage state so reloads, repeated manual starts, and settings
  refreshes do not duplicate clues, hints, timeouts, leaderboards, or scheduled rounds.
- Moon web request creation now lives in `/myrequests`, Discord `/request` now uses the same metadata-only requester
  flow, admins choose download sources during approval from `/admin/requests`, and unavailable requests are Sage-owned
  records that recheck every 4 hours and expire after 90 days. Admin request actions should carry request revisions so
  stale drawers fail with a clean conflict instead of overwriting a newer moderation update.
- Moon admin Wanted uses dedicated repair pages: `/admin/wanted/metadata` for provider metadata apply, and
  `/admin/wanted/missing-content` for coverage repair, damaged-page review, and bad-source summaries via staged
  replacement downloads. The old metadata-gaps and missing-chapters paths are legacy-only and should redirect.
- Raven now exposes merged metadata-provider and download-provider tags as one canonical tag set for library and
  moderation surfaces, while keeping source attribution internally for debugging.
- Raven stores in-flight downloads under `downloading/<type>/...` and promotes completed library content into
  `downloaded/<type>/...`.
- Raven title-download concurrency is brokered through `raven.download.runtime`. Default to two active titles, allow
  only `1` through `6`, apply reloads live without cancelling active downloads, and keep per-title page download
  concurrency fixed.
- Raven should only report `100%` after the promoted files persist into the brokered catalog, and startup recovery now
  rescans finished `downloaded/<type>/...` content to heal missing library rows.
- Raven should skip completed titles during `/downloadall`, append only missing/new chapters for existing active
  titles, convert source-image damage into Missing Content quality fields instead of wedging a whole batch, and pause
  with an exact recovery action if a stale running title task cannot be cancelled into retryable work.
- Oracle is now a FastAPI Python service that keeps the same Sage-facing wire contract plus `/api/assist` for bounded
  structured assistance. It never executes mutations directly.
- Warden-managed LocalAI presets use the LocalAI AIO images and must wait for readiness before surfacing success.
- Raven VPN fails closed when enabled, and the internal `raven.naming` setting now controls chapter and page naming.
- `raven.naming` is now profile-based by library type, and Moon admin exposes it through `/admin/mediamanagement`
  instead of burying it in the generic settings page.
- Moon admin library and calendar now expect richer Raven release metadata: the series index is dense and sortable,
  while the calendar view consumes chapter release dates captured from source scrapes, metadata enrichment, and
  completed-title fallback dates so finished catalog titles remain visible.
- Moon admin System pages now include Logs, Events, Updates, Tasks, Status, API, and AI as purpose-built Next surfaces.
  Keep browser traffic same-origin through Moon -> Sage, keep task jobs allowlisted, make Status load the lightweight
  registry first and probe GET/read endpoints only from its explicit check action, and keep Oracle/LocalAI settings
  plus Sage-governed AI tool proposals under `/admin/system/ai`.
- Moon home shelves and the unified `/library` catalogue should use Raven's compact card projection through Sage. Do
  not load full Raven title/chapter arrays for card lists; hydrate full titles only for title/detail/reader flows or
  exact continue-reading ids.
- Card links are intentionally split: cover/art opens the best reader URL from `readerTarget`, and title/copy opens the
  canonical title page. Keep this accessible-link split in browse, library, and home shelf cards.
- Moon chrome should collapse branding, auth, user identity, and first-owner bootstrap into
  `/api/moon/chrome/bootstrap`, then fetch the Discord login URL lazily only when a signed-out screen needs it.
- Moon Settings and Status should paint saved or registry payloads first, then hydrate runtime-only data from
  `/api/moon-v3/admin/settings/runtime` and `/api/moon-v3/admin/system/status/runtime`.

## Moon Load-Speed Handoff

When the next task is "make Moon faster," start with observation instead of edits:

- Capture a small timing table for `/`, `/browse`, `/library`, a title or reader route, `/admin/settings`,
  `/admin/system/status`, `/admin/activity/queue`, and `/admin/requests`.
- Separate document or Next asset load, Moon chrome/bootstrap calls, main route payload, admin SSE/event calls, payload
  byte size, and downstream Sage/Raven/Vault latency where the payload crosses services.
- Check whether the page is blocked by JS bundle size, same-origin API fan-out, downstream broker latency, payload
  shape, cover/image work, auth/session bootstrap, SSE startup, or hydration/client rendering work.
- Keep proven fast paths intact: compact library cards, bounded home shelves, toast-only settings reads, shared admin
  event stream, lightweight System Status first load, and explicit deep status checks.
- Prefer narrow proof first: Moon helper tests, Sage payload tests, Raven/Vault projection tests, then user/reader/admin
  Next builds. Use `npm run docker:healthcheck` for cross-service confirmation and prod smoke against
  `https://pax-kun.com`.

## Service Index

- [Warden](warden/README.md)
- [Vault](vault/README.md)
- [Sage](sage/README.md)
- [Moon](moon/README.md)
- [Portal](portal/README.md)
- [Oracle](oracle/README.md)
- [Raven](raven/README.md)
