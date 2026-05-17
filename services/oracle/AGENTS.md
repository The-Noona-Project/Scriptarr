<!-- Oracle contributor notes. Keep public-facing behavior and setup guidance in README.md and ServerAdmin.md. -->

# Oracle Agent Guide

Read this before editing `services/oracle`.

## Role

Oracle provides Scriptarr's Noona and Appa AI replies, backed by FastAPI with OpenAI-first defaults and optional
LocalAI.

## Hard Rules

- Keep Oracle non-mutating: text chat, read-only status lookup, and bounded structured assistance are allowed, but
  Sage owns all action proposals, confirmations, and executions.
- Oracle degradation must not make the rest of Scriptarr unhealthy.
- Keep Oracle off by default on fresh installs.
- Keep LocalAI communication OpenAI-compatible. Oracle owns the embedded LocalAI model cache/runtime; Warden only
  injects container mounts and GPU/runtime flags.
- Route Oracle's first-party Scriptarr HTTP through Sage; do not add direct Vault or Warden calls here.
- Preserve Oracle's internal wire contract when changing implementation details:
  - `GET /health`
  - `GET /api/status`
  - `POST /api/chat`
  - `POST /api/assist`
- `POST /api/chat` may receive an optional `personaName` plus Sage-curated `context` object. Treat both as read-only
  background for response quality, preserve the old message-only contract, and never use context to execute tools or
  reveal secrets, raw Discord ids, credentials, or admin-only internals.
- `POST /api/assist` task `review-noona-public-chat` should return a normalized Appa review decision. If model output
  is malformed, default to `ok` with empty correction text instead of guessing a public correction.

## Coding Map

- FastAPI app and route behavior live under `oracle_service`. Provider configuration and embedded LocalAI handling
  should stay isolated from Sage-facing response shapes.
- Oracle may read Scriptarr status through Sage, but it must not execute mutations or bypass Sage to Vault, Warden, or
  other first-party services.
- LocalAI is optional. Missing, slow, or unhealthy AI dependencies should degrade Oracle responses without making the
  whole Scriptarr stack unhealthy.
- Prove Oracle changes with the Oracle pytest suite through the npm workspace, then use `npm run docker:healthcheck`
  if provider config, LocalAI readiness, or Warden interaction changes.
