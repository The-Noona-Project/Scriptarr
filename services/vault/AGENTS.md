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
- Preserve service-to-service auth boundaries.
- Sage is the supported caller for Vault's HTTP surface. Other first-party services should not bypass Sage.
- Keep public docs concise and operational.
- If user, role, permission, or request-model contracts change, update docs and tests in the same change.
