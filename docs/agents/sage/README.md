# Sage AI Notes

- Sage is the Moon-facing broker for auth, first-admin claim, request moderation, status aggregation, and browser-safe
  orchestration.
- Keep Moon -> Sage -> internal services intact.
- Persist Raven and Oracle admin settings through Vault instead of service-local files.
- Keep Warden status aggregation split by endpoint contract instead of flattening bootstrap and runtime payloads
  together.
- Keep full JSDoc on exported Sage `.mjs` source and tests so the ESLint doc gate stays green.
