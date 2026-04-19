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
- Vault is the supported broker for shared MySQL-backed state.
- Requests created in Moon and Discord must converge on one moderated flow.
- LocalAI is optional to overall platform health; degrade safely when AI dependencies are unavailable.
- Prefer Docker-based verification for cross-service work. `npm run docker:test` is the supported end-to-end test mode,
  and `npm run docker:test:teardown` is the matching cleanup path.
