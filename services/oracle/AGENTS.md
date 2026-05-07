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
