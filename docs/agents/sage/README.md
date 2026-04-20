# Sage AI Notes

- Sage is the Moon-facing broker for auth, first-admin bootstrap, request moderation, status aggregation, and browser-safe
  orchestration.
- Keep Moon -> Sage -> internal services intact.
- Keep first-party service-to-service HTTP behind Sage's internal broker routes instead of allowing Portal, Oracle,
  Raven, or Warden to reach across the stack directly.
- Keep request intake centralized in Sage. Search should broker to Raven's intake search, request creation should
  persist the selected metadata plus download snapshots in Vault, and moderation should queue the exact saved Raven
  target instead of rerunning a fuzzy search at approval time.
- Persist Raven and Oracle admin settings through Vault instead of service-local files.
- Broker Portal's Discord workflow settings through the shared `portal.discord` setting, and keep Portal-facing broker
  routes for intake search, request creation, library search, follow updates, onboarding tests, and Raven bulk queue.
- Persist and expose `raven.download.providers` through the same brokered settings path as Raven metadata and VPN
  configuration.
- Sage also brokers Moon's trusted public automation API. Keep API keys hashed at rest, issue short-lived
  selection tokens for search results, and preserve the lowest-priority queue stamp for accepted external requests.
- Keep Warden status aggregation split by endpoint contract instead of flattening bootstrap and runtime payloads
  together.
- Keep full JSDoc on exported Sage `.mjs` source and tests so the ESLint doc gate stays green.
- Legacy `/api/library` behavior must mirror Raven's real-or-empty library state instead of injecting scaffold titles.
