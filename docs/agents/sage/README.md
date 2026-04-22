# Sage AI Notes

- Sage is the Moon-facing broker for auth, first-admin bootstrap, request moderation, status aggregation, and browser-safe
  orchestration.
- Keep Moon -> Sage -> internal services intact.
- Keep first-party service-to-service HTTP behind Sage's internal broker routes instead of allowing Portal, Oracle,
  Raven, or Warden to reach across the stack directly.
- Keep request intake centralized in Sage. Search should broker to Raven's intake search, request creation should
  persist the selected metadata plus download snapshots in Vault, and moderation should queue the exact saved Raven
  target instead of rerunning a fuzzy search at approval time.
- Keep duplicate enforcement aligned with Vault's durable request work key so Moon, Discord, admin add-title, and the
  public API all reject the same concrete target even under concurrent submits.
- Persist Raven and Oracle admin settings through Vault instead of service-local files.
- Broker Portal's Discord workflow settings through the shared `portal.discord` setting, and keep Portal-facing broker
  routes for intake search, request creation, library search, follow updates, onboarding tests, and Raven bulk queue.
- Portal's Raven bulk queue broker route now requires an explicit `providerId`. Keep `downloadall` locked to the
  WeebCentral provider on the Sage side too so Portal cannot accidentally fall through to MangaDex when that owner-only
  DM command is used.
- Persist and expose `raven.download.providers` through the same brokered settings path as Raven metadata and VPN
  configuration.
- Persist and expose brokered `raven.naming` settings, including the fallback naming profile plus the per-type naming
  profiles Moon now edits from `/admin/mediamanagement`.
- Sage also brokers Moon's trusted public automation API. Keep API keys hashed at rest, issue short-lived
  selection tokens for search results, and preserve the lowest-priority queue stamp for accepted external requests.
- Keep Warden status aggregation split by endpoint contract instead of flattening bootstrap and runtime payloads
  together.
- Keep full JSDoc on exported Sage `.mjs` source and tests so the ESLint doc gate stays green.
- Legacy `/api/library` behavior must mirror Raven's real-or-empty library state instead of injecting scaffold titles.
- Moon admin calendar now depends on richer Raven chapter data. Keep `/api/moon-v3/admin/calendar` focused on dated
  release entries with enough title context for Moon to render a calendar-first operational view.
- `/api/moon-v3/admin/library/:titleId` is now the brokered admin drill-down payload for Moon's Sonarr-style title
  detail route. Keep it rich enough to combine title lifecycle status, related requests, active or recent Raven tasks,
  and chapter-level release or archive fields without forcing Moon to fan out into multiple browser calls.
- Sage now also brokers admin title repair APIs. Keep `/api/moon-v3/admin/library/:titleId/repair-options` and
  `/api/moon-v3/admin/library/:titleId/replace-source` as thin Moon-safe wrappers around Raven's concrete provider
  repair flow instead of leaking Raven directly into the browser.
