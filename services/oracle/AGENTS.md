# Oracle Agent Guide

Read this before editing `services/oracle`.

## Role

Oracle is the Noona AI persona for Scriptarr, backed by FastAPI with OpenAI-first defaults and optional LocalAI.

## Hard Rules

- Keep Oracle non-mutating: text chat, read-only status lookup, and bounded structured assistance are allowed, but
  Sage owns all action proposals, confirmations, and executions.
- Oracle degradation must not make the rest of Scriptarr unhealthy.
- Keep Oracle off by default on fresh installs.
- Keep LocalAI communication OpenAI-compatible so Warden-selected images stay swappable.
- Route Oracle's first-party Scriptarr HTTP through Sage; do not add direct Vault or Warden calls here.
- Preserve Oracle's internal wire contract when changing implementation details:
  - `GET /health`
  - `GET /api/status`
  - `POST /api/chat`
  - `POST /api/assist`

## Coding Map

- FastAPI app and route behavior live under `oracle_service`. Provider configuration and OpenAI-compatible LocalAI
  handling should stay isolated from Sage-facing response shapes.
- Oracle may read Scriptarr status through Sage, but it must not execute mutations or bypass Sage to Vault, Warden, or
  other first-party services.
- LocalAI is optional. Missing, slow, or unhealthy AI dependencies should degrade Oracle responses without making the
  whole Scriptarr stack unhealthy.
- Prove Oracle changes with the Oracle pytest suite through the npm workspace, then use `npm run docker:healthcheck`
  if provider config, LocalAI readiness, or Warden interaction changes.
