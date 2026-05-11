# Vault Agent Guide

Read this before editing `services/vault`.

## Role

Vault is Scriptarr's shared auth, settings, secrets, request, session, cache, progress, and generic job broker over
MySQL.

## Hard Rules

- Vault is the only first-party service allowed to talk to MySQL directly.
- Keep Vault as the supported broker to shared MySQL state.
- Keep hot shared reads cache-first with the Vault-owned TTL cache, and keep writes authoritative in MySQL with
  immediate cache refresh or invalidation.
- Keep generic async jobs and job tasks durable here so other services do not invent sidecar state stores.
- Preserve Raven title/chapter quality fields and durable downloadall job state; Missing Content and Portal DMs depend
  on those records surviving cache refreshes and MySQL restarts.
- Preserve brokered Portal trivia state and AI tool/proposal settings through normal settings storage and content
  reset; Portal and Sage depend on those records surviving restarts.
- Preserve service-to-service auth boundaries.
- Sage is the supported caller for Vault's HTTP surface. Other first-party services should not bypass Sage.
- Keep public docs concise and operational.
- If user, role, permission, or request-model contracts change, update docs and tests in the same change.

## Coding Map

- Durable MySQL-backed behavior lives in `lib/createStore.mjs`; cache-first wrappers live in
  `lib/createCachedStore.mjs`; HTTP routes live in `lib/createVaultApp.mjs`.
- Keep writes authoritative in MySQL, then refresh or invalidate Vault-owned caches before returning.
- Generic jobs and job tasks are the durable substrate for Warden updates, Raven `/downloadall`, Portal DMs, and other
  async work. Preserve their owner, kind, status, payload, result, and task ordering contracts.
- Permission groups, sessions, API keys, requests, reader state, follows, bookmarks, and Raven catalog records are
  shared product contracts. Add route and store tests when any of those shapes change.
- Prove Vault changes with `npm --workspace services/vault test`; use `npm run docker:healthcheck` when migrations,
  startup, cache behavior, or cross-service contracts change.
