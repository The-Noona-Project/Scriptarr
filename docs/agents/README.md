# Scriptarr AI Docs

This tree is the internal knowledge base for AI contributors.

Audience split:

- public and self-hosters: root and service `README.md`
- server admins: [../../ServerAdmin.md](../../ServerAdmin.md)
- AI contributors: this folder and the service `AGENTS.md` files

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
  for guild id, onboarding, per-command role gates, and DM superuser rules.
- Moon now serves a trusted public automation API and same-origin Swagger docs. Search is public, create or status
  calls use the brokered admin API key, and accepted external requests must stay at the lowest queue priority.
- Active requests now use a durable Vault work key so duplicate submissions across Moon, Discord, admin, and the
  public API collapse cleanly under concurrency.
- Request-linked moderation and Raven completion events can now trigger one Portal DM per request state when a Discord
  id is available.
- Moon web request creation now lives in `/myrequests`, Discord `/request` now uses the same metadata-only requester
  flow, admins choose download sources during approval from `/admin/requests`, and unavailable requests are Sage-owned
  records that recheck every 4 hours and expire after 90 days.
- Raven now exposes merged metadata-provider and download-provider tags as one canonical tag set for library and
  moderation surfaces, while keeping source attribution internally for debugging.
- Raven stores in-flight downloads under `downloading/<type>/...` and promotes completed library content into
  `downloaded/<type>/...`.
- Raven should only report `100%` after the promoted files persist into the brokered catalog, and startup recovery now
  rescans finished `downloaded/<type>/...` content to heal missing library rows.
- Oracle is now a FastAPI Python service that keeps the same Sage-facing wire contract.
- Warden-managed LocalAI presets use the LocalAI AIO images and must wait for readiness before surfacing success.
- Raven VPN fails closed when enabled, and the internal `raven.naming` setting now controls chapter and page naming.
- `raven.naming` is now profile-based by library type, and Moon admin exposes it through `/admin/mediamanagement`
  instead of burying it in the generic settings page.
- Moon admin library and calendar now expect richer Raven release metadata: the series index is dense and sortable,
  while the calendar view consumes chapter release dates captured from source scrapes and metadata enrichment.

## Service Index

- [Warden](warden/README.md)
- [Vault](vault/README.md)
- [Sage](sage/README.md)
- [Moon](moon/README.md)
- [Portal](portal/README.md)
- [Oracle](oracle/README.md)
- [Raven](raven/README.md)
