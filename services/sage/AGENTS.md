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
- Keep Moon's trusted public API brokered here. Sage should hash stored API keys, issue short-lived selection tokens,
  and enforce NSFW plus duplicate guards before queueing external requests at the lowest priority.
- Keep Warden aggregation split by contract: `/health` for service health, `/api/bootstrap` for the static plan, and
  `/api/runtime` for live runtime details.
- Keep full JSDoc on exported Sage `.mjs` source and test files. `npm test` should enforce that gate.
