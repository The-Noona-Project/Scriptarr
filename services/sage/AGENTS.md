# Sage Agent Guide

Read this before editing `services/sage`.

## Role

Sage is Scriptarr's Moon-facing auth, browser-safe orchestration broker, and the only supported first-party internal
HTTP broker.

## Hard Rules

- Browsers should talk to Moon, and Moon should talk to Sage.
- Keep Discord auth, first-admin bootstrap, session handling, and policy checks centralized here.
- Avoid bypassing Sage from Moon or other first-party services for convenience.
- Keep Portal, Oracle, Raven, and Warden on Sage-brokered first-party HTTP instead of direct Vault, Oracle, Raven, or
  Warden calls.
- Keep request intake centralized here. Sage should broker Raven intake search, persist the selected metadata or
  download snapshots in Vault, and queue the exact saved Raven target during moderation or admin immediate-add flows.
- Broker `raven.download.providers` through the same settings path as Raven metadata and VPN configuration.
- Keep Raven durable `/downloadall` runs, Missing Content aliases, and queue bulk actions brokered through Sage so Moon
  and Portal never call Raven directly from browsers or Discord runtime code. Sage maintenance should inspect Raven
  title tasks and durable bulk-run status together so stale queue cleanup can reattach detached runs or surface exact
  admin recovery actions.
- Keep Portal trivia brokered through Sage. Sage owns Vault-backed trivia rounds, guesses, score events, leaderboard
  acknowledgments, and optional Oracle borderline matching.
- Keep public Noona mention chat brokered through Sage. Portal should call `/api/internal/portal/noona-chat`; Sage owns
  capped memory summaries, conservative read-context loading, public proposal allowlisting, and Oracle fallback. Do not
  let Portal call Oracle or Vault directly for mention chat.
- Keep Appa admin chat and Noona public-reply review brokered through Sage. Portal should call
  `/api/internal/portal/appa-chat`, `/api/internal/portal/noona-review`, and `/api/internal/portal/noona-review/delivery`;
  Sage owns Appa persona context, redacted durable audit events, and conservative proposal boundaries.
- Keep Appa Discord diagnostics brokered through Sage. Portal should call
  `/api/internal/portal/appa-discord-diagnostic`, and Sage should persist only redacted metadata/snippets for audit.
- Keep AI tool execution Sage-governed. Oracle can assist planning, but Sage must enforce the `ai` domain, enabled
  toggles, grant checks, proposal confirmation, expiry, and durable events.
- Portal-facing release notifications should be grouped into digest payloads with cursor-style `silenceBefore`
  acknowledgment state, and should tolerate completed Raven tasks that no longer match a library title.
- Portal-facing downloadall notifications should use stable ack ids and only acknowledge after Portal confirms the
  requester DM was sent.
- Portal-facing GitHub update notifications should use stable `update:<latestSha>` ids and only acknowledge after
  Portal confirms the channel post was sent.
- Keep Moon's trusted public API brokered here. Sage should hash stored API keys, issue short-lived selection tokens,
  and enforce NSFW plus duplicate guards before queueing external requests at the lowest priority.
- Keep Warden aggregation split by contract: `/health` for service health, `/api/bootstrap` for the static plan, and
  `/api/runtime` for live runtime details.
- Keep GitHub update digests Sage-owned. The `update-check` system task may read GitHub's public API and ask Oracle
  for a Noona summary, but Portal only receives durable update notification payloads through Sage after the summary is
  a real AI response, not degraded or disabled provider fallback copy.
- Keep full JSDoc on exported Sage `.mjs` source and test files. `npm test` should enforce that gate.

## Coding Map

- Moon v3 browser-safe payloads live in `lib/registerMoonV3Routes.mjs`; split reusable payload logic into nearby helper
  modules when the route file starts hiding policy decisions.
- Moon compact card routes should broker Raven/Vault card projections and merge bounded reader targets server-side.
  Keep `/browse`, `/library`, and home shelf filters on `view=card` with `q`, `type`, `letter`, `cursor`, `pageSize`,
  `sort`, and optional exact `ids`; do not ask Moon browsers to hydrate full title/chapter arrays for list pages.
- First-party service broker routes live in `lib/registerInternalBrokerRoutes.mjs`. Portal, Raven, Warden, and Oracle
  should call those internal routes instead of talking directly to Vault or each other.
- Public Noona chat helpers live in `lib/noonaChatService.mjs` and `lib/noonaChatMemory.mjs`. Keep durable memory
  summarized in Vault settings, reject obvious secrets, and keep the public proposal allowlist stricter than the admin
  AI page.
- Appa chat and review helpers live in `lib/appaChatService.mjs`. Keep review excerpts redacted, record correction
  delivery separately from recommendations, and never store raw Discord transcripts.
- Durable state reads and writes go through `lib/vaultClient.mjs`, which is the Sage-side client for Vault's service
  API. Do not add MySQL access here.
- Reader target lookups belong in `vaultClient.mjs` plus focused Moon v3 helpers. Precedence is saved progress/bookmark,
  next unread chapter, first readable chapter, then no target so Moon falls back to the title page.
- Moon reader payloads should stay split: keep the compatibility full reader chapter route, but serve the active reader
  from `/session` plus `/pages?cursor=&pageSize=&rev=` and the existing paged title-chapter route for the settings
  rail. Session payloads must not include full manifests or page lists; page chunks should include revisioned image URLs.
- User-specific Moon title, reader, bookshelf, bookmark, follow, and tag-state helpers should reuse shared user-state
  loaders instead of fanning out into repeated Vault reads.
- Settings that have both saved state and runtime state should keep the saved payload fast, then expose a secondary
  runtime endpoint such as `/api/moon-v3/admin/settings/runtime` or
  `/api/moon-v3/admin/system/status/runtime`.
- Prove Sage changes with `npm --workspace services/sage test`; add route-level tests in `services/sage/tests` when
  a broker payload, grant, conflict, or fan-out contract changes.
