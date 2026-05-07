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
- Portal's Discord runtime is brokered through Moon admin's `/admin/discord` settings page. Keep guild id, onboarding,
  DM superuser id, release notification channel, Noona trivia settings, and per-command role mapping behind that
  settings object instead of drifting back to scattered env-only behavior.
- Portal now sends request completion DMs. Preserve the single-send acknowledgment flow so retries or restarts do not
  spam the requester.
- Moon admin's `/admin/system/ai` is the browser-safe owner for Oracle, optional LocalAI, and Sage-governed AI
  proposals. Keep browser traffic behind Moon and Sage instead of adding direct browser calls to Oracle, Warden,
  OpenAI, or LocalAI.
- Raven stores active downloads under `downloading/<type>/...` and promotes completed library content into
  `downloaded/<type>/...`.
- Raven should only report `100%` after promoted files persist into the brokered catalog, and startup recovery should
  reconcile finished `downloaded/<type>/...` files back into the library if catalog rows are missing.
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
