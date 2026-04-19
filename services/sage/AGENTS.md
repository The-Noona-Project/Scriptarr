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
- Keep Warden aggregation split by contract: `/health` for service health, `/api/bootstrap` for the static plan, and
  `/api/runtime` for live runtime details.
- Keep full JSDoc on exported Sage `.mjs` source and test files. `npm test` should enforce that gate.
