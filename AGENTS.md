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

## Service Index

- [Warden](services/warden/AGENTS.md)
- [Vault](services/vault/AGENTS.md)
- [Sage](services/sage/AGENTS.md)
- [Moon](services/moon/AGENTS.md)
- [Portal](services/portal/AGENTS.md)
- [Oracle](services/oracle/AGENTS.md)
- [Raven](services/raven/AGENTS.md)

## Workflow Notes

- Browsers should stay behind Moon. Do not casually add browser calls to internal services.
- Vault is the only supported broker and the only first-party service allowed to touch the shared MySQL database.
- First-party service-to-service HTTP must go through Sage. Direct exceptions are limited to Vault -> MySQL, Warden ->
  Docker or host runtime, Oracle -> OpenAI or LocalAI, and Raven -> external source, metadata, and VPN providers.
- Requests created in Moon and Discord must converge on one moderated flow.
- Raven stores active downloads under `downloading/<type>/...` and promotes completed library content into
  `downloaded/<type>/...`.
- Oracle now lives in `services/oracle` as a Python FastAPI service even though the repo-level test and Docker helpers
  still flow through the npm workspace.
- Warden's LocalAI presets now target the LocalAI AIO image family, should only report success after readiness, and
  should boot the Oracle-safe text-generation preload set instead of the full bundled model list.
- Raven VPN should fail closed when enabled, and Raven chapter or page naming now comes from the internal
  `raven.naming` template settings rather than only hard-coded defaults.
- LocalAI is optional to overall platform health; degrade safely when AI dependencies are unavailable.
- Prefer Docker-based verification for cross-service work. `npm run docker:healthcheck` is the default smoke path for
  agents and contributors, while `npm run docker:test` remains the deeper end-to-end flow. `npm run docker:test:teardown`
  is the matching manual cleanup path when the deeper test stack is left running.
