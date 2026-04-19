# Sage Agent Guide

Read this before editing `services/sage`.

## Role

Sage is Scriptarr's Moon-facing auth and browser-safe orchestration broker.

## Hard Rules

- Browsers should talk to Moon, and Moon should talk to Sage.
- Keep Discord auth, first-admin claim, session handling, and policy checks centralized here.
- Avoid bypassing Sage from Moon for convenience.
- Keep Warden aggregation split by contract: `/health` for service health, `/api/bootstrap` for the static plan, and
  `/api/runtime` for live runtime details.
- Keep full JSDoc on exported Sage `.mjs` source and test files. `npm test` should enforce that gate.
