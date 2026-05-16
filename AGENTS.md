# Scriptarr Repository Agent Guide

Read this before editing Scriptarr.

## Hard Rules

- Keep changes scoped to the request.
- Preserve user changes you did not make.
- Read the closest service `AGENTS.md` before editing under `services/`.
- If a file is approaching 2000 lines, split it into smaller files when possible.
- If a file is nearing 4000 lines, treat it as overdue for decomposition unless it is generated or framework-constrained.
- Keep public README files user-focused. Move implementation detail into `docs/agents/`.
- If runtime behavior, setup flow, storage layout, auth, roles, permissions, or admin workflow changes, update the
  nearest public README and [ServerAdmin.md](ServerAdmin.md) in the same change.
- If invariants, file ownership, or internal workflows change, update the matching files under `docs/agents/`.
- Scriptarr is the product name. `Noona` should only be used for the Discord bot or AI persona.

## Start Here

- [Public repo README](README.md)
- [Server admin guide](ServerAdmin.md)
- [AI docs index](docs/agents/README.md)

## Useful Commands

- `npm run docker:list`
- `npm run docker:build`
- `npm run docker:push`
- `npm run docker:publish`
- `npm run docker:healthcheck`
- `npm run docker:test`
- `npm run docker:test:teardown`
- `npm run test`
- `npm run test:js`
- `npm run test:raven`

## Service Index

- [Warden](services/warden/AGENTS.md)
- [Vault](services/vault/AGENTS.md)
- [Sage](services/sage/AGENTS.md)
- [Moon](services/moon/AGENTS.md)
- [Portal](services/portal/AGENTS.md)
- [Oracle](services/oracle/AGENTS.md)
- [Raven](services/raven/AGENTS.md)

## Agent Navigation

- Start every non-trivial turn with `git status --short`, then read this file and the closest service `AGENTS.md` for
  any code you plan to touch.
- Use `rg` first. Most work lands in these zones:
  - Warden: `services/warden`, Docker socket orchestration, image updates, service plans, and health convergence.
  - Vault: `services/vault`, durable storage APIs and the only first-party MySQL access.
  - Sage: `services/sage`, auth, grants, Moon v3 routes, internal broker routes, admin workflows, and service
    orchestration.
  - Moon: `services/moon`, browser surfaces, same-origin proxies, admin Next pages under
    `apps/admin-next/components`, user Next pages under `apps/user-next/components`, and public API/Swagger.
  - Portal: `services/portal`, Discord commands, DMs, reactions, release posts, trivia, and Portal-to-Sage runtime.
  - Oracle: `services/oracle`, FastAPI AI chat/assist logic and LocalAI/OpenAI adapters.
  - Raven: `services/raven`, Java downloader, catalog promotion, `/downloadall`, media quality, naming, queue, and VPN.
- Trace traffic before editing: browser -> Moon -> Sage -> internal services; Discord -> Portal -> Sage; Raven -> Sage
  for brokered state; Vault -> MySQL. Do not add direct browser calls to internal services.
- Prove changes with the narrow service test first, then the relevant Moon build or Docker smoke when behavior crosses
  service boundaries. For production, publish only affected images, update through Warden, and smoke the exact
  `https://pax-kun.com` surface.
- Never print or commit secrets. Redact tokens, keys, sessions, credentials, and environment values in notes and logs.

## Coding Map

- Start from the request path, not the file name. Browser work usually starts in Moon, flows through Sage, and then
  reaches Vault, Raven, Warden, Portal, Oracle, or LocalAI only through brokered server-side calls.
- Moon UI edits belong in `services/moon/apps/user-next` for user pages,
  `services/moon/apps/reader-next` for fullscreen reader pages, and
  `services/moon/apps/admin-next` for admin pages. Same-origin Moon route and proxy logic belongs in
  `services/moon/lib`.
- Sage route assembly belongs in `services/sage/lib/registerMoonV3Routes.mjs` for Moon v3 payloads,
  `services/sage/lib/registerInternalBrokerRoutes.mjs` for first-party service routes, and focused helper modules when
  payload logic starts to sprawl.
- Vault owns durable MySQL-backed state through `services/vault/lib/createStore.mjs` and cached store wrappers. Other
  services should add broker routes instead of reaching for MySQL directly.
- Raven Java work lives under `services/raven/src/main/java/com/scriptarr/raven`, with API endpoints in `api`,
  downloader and `/downloadall` orchestration in `downloader`, catalog projection and promotion in `library`, and VPN
  or settings behavior in their matching packages.
- Portal Discord work lives under `services/portal/lib/discord`; Warden orchestration lives under
  `services/warden/config` and `services/warden/core`; Oracle FastAPI work lives under `services/oracle`.
- Keep comments and docs current with the code. Remove stale Kavita, Komf, old plain-JS Moon, setup-wizard, or broad
  Once UI shell language unless it is explicitly historical/reference context.

## Test Map

- Moon UI/proxy changes: `npm --workspace services/moon test`, then `npm --workspace services/moon run build:user`,
  `npm --workspace services/moon run build:reader`, or `npm --workspace services/moon run build:admin` for touched
  Next apps.
- Sage route/broker changes: `npm --workspace services/sage test`.
- Vault storage changes: `npm --workspace services/vault test`.
- Portal Discord/runtime changes: `npm --workspace services/portal test`.
- Warden orchestration changes: `npm --workspace services/warden test`.
- Raven Java changes: `npm run test:raven`.
- Cross-service behavior: `npm run docker:healthcheck`. Use `npm run docker:test` only when the deeper flow is needed,
  and clean it with `npm run docker:test:teardown` if it is left running.
- Moon performance work also needs `npm --workspace services/moon run bundle:report` after the touched user, reader,
  or admin builds, and bundle regressions should be compared against the current route first-load JS baseline.
- Dependency refreshes should prefer existing `package.json` ranges and minimal lockfile movement. If a package changes
  optional peer behavior, prove the affected build and record any newly required direct dependencies instead of pulling
  broad latest-version upgrades.

## Workflow Notes

- Browsers should stay behind Moon. Do not casually add browser calls to internal services.
- Vault is the only supported broker and the only first-party service allowed to touch the shared MySQL database.
- First-party service-to-service HTTP must go through Sage. Direct exceptions are limited to Vault -> MySQL, Warden ->
  Docker or host runtime, Oracle -> OpenAI or LocalAI, and Raven -> external source, metadata, and VPN providers.
- Requests created in Moon and Discord must converge on one moderated flow.
- Moon user requests and Moon admin add-title now share one metadata-first intake flow. Persist the selected metadata
  and download snapshots so moderation can queue the exact saved Raven target later.
- Moon web request creation now lives in `/myrequests`. Keep the web requester flow metadata-first there instead of
  reintroducing older request-entry surfaces.
- Moon Discord login should preserve a sanitized same-origin return path when possible and fall back to `/` if the
  remembered route is missing, unsafe, or no longer allowed for the signed-in user.
- Moon also owns the trusted public automation API. Keep external search and request traffic behind Moon's
  `/api/public/*` routes, store only hashed API keys in Vault through Sage, and preserve the NSFW, duplicate, and
  lowest-priority guards on external queueing.
- Moon browse, library, and home shelves should stay on the compact title-card broker path. Pass filters through Moon
  -> Sage -> Vault or Raven card projections instead of hydrating full title or chapter arrays for list views.
  Browse state is URL-owned (`q`, `type`, `letter`, `cursor`, `pageSize`) and card art should route to the
  Sage/Vault-merged `readerTarget` while title text routes to the title page.
- For Moon load-speed work, measure before editing. Build a timing table for representative user and admin pages, split
  document or Next asset load, chrome/bootstrap calls, main page payload, SSE/event calls, and payload size, then compare
  Moon route time against downstream Sage, Raven, and Vault time for heavy endpoints.
- Keep Moon performance fixes on the existing hot paths: compact card projections, bounded home shelves, shared admin
  bootstrap/event streams, lightweight admin status, route-level dynamic admin loading, and measured bundle reduction.
  Do not add browser-direct calls to internal services as a shortcut.
- Portal's Discord runtime is brokered through Moon admin's `/admin/discord` settings page. Keep guild id, onboarding,
  DM superuser id, release/update notification channels, Noona trivia settings, and per-command role mapping behind that
  settings object instead of drifting back to scattered env-only behavior.
- Portal now sends request completion DMs. Preserve the single-send acknowledgment flow so retries or restarts do not
  spam the requester.
- Portal trivia should reconcile one active Sage-backed round clock. Reloads, repeated `/trivia start`, and settings
  refreshes must not duplicate clues, hints, timeout posts, or leaderboard windows.
- Moon admin's `/admin/system/ai` is the browser-safe owner for Oracle, optional LocalAI, and Sage-governed AI
  proposals. Keep browser traffic behind Moon and Sage instead of adding direct browser calls to Oracle, Warden,
  OpenAI, or LocalAI.
- Moon admin's `/admin/system/status` is now registry-first. Keep the lightweight endpoint matrix fast on first load,
  and only probe GET/read endpoints from the explicit check action while leaving mutation routes unprobed.
- Raven stores active downloads under `downloading/<type>/...` and promotes completed library content into
  `downloaded/<type>/...`.
- Raven should only report `100%` after promoted files persist into the brokered catalog, and startup recovery should
  reconcile finished `downloaded/<type>/...` files back into the library if catalog rows are missing.
- Raven title-download concurrency is Sage-backed runtime config. Default to `2`, allow only `1` through `6`, apply
  reloads live when possible without cancelling active titles, and treat the Moon Settings value as the owner of that
  limit.
- Moon admin Wanted should keep `/admin/wanted/missing-content` as the canonical repair surface for chapter gaps,
  missing pages, and bad-source quality states, with `/admin/wanted/missing-chapters` left as an alias only.
- Oracle now lives in `services/oracle` as a Python FastAPI service even though the repo-level test and Docker helpers
  still flow through the npm workspace.
- Warden's LocalAI presets now target the LocalAI AIO image family, should only report success after readiness, and
  should boot the Oracle-safe text-generation preload set instead of the full bundled model list.
- Raven VPN should fail closed when enabled, and Raven chapter or page naming now comes from the internal
  `raven.naming` template settings rather than only hard-coded defaults.
- `raven.naming` is now profile-based by library type, and Moon admin owns that workflow at
  `/admin/mediamanagement`.
- LocalAI is optional to overall platform health; degrade safely when AI dependencies are unavailable.
- Moon admin's `/admin/activity/queue` is the live Raven queue board. Keep it SSE-backed, limit `Needs attention` to
  failed or stale Raven title tasks, show ETA only for active downloads with credible telemetry, and only remove
  incomplete managed working folders from recovery actions.
- Prefer Docker-based verification for cross-service work. `npm run docker:healthcheck` is the default smoke path for
  agents and contributors, while `npm run docker:test` remains the deeper end-to-end flow. `npm run docker:test:teardown`
  is the matching manual cleanup path when the deeper test stack is left running.
