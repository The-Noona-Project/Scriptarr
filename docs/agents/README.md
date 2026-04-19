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
- Raven stores in-flight downloads under `downloading/<type>/...` and promotes completed library content into
  `downloaded/<type>/...`.
- Oracle is now a FastAPI Python service that keeps the same Sage-facing wire contract.
- Warden-managed LocalAI presets use the LocalAI AIO images and must wait for readiness before surfacing success.
- Raven VPN fails closed when enabled, and the internal `raven.naming` setting now controls chapter and page naming.

## Service Index

- [Warden](warden/README.md)
- [Vault](vault/README.md)
- [Sage](sage/README.md)
- [Moon](moon/README.md)
- [Portal](portal/README.md)
- [Oracle](oracle/README.md)
- [Raven](raven/README.md)
