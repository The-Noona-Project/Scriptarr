# Vault Agent Guide

Read this before editing `services/vault`.

## Role

Vault is Scriptarr's shared auth, settings, secrets, request, session, cache, and progress broker over MySQL.

## Hard Rules

- Keep Vault as the supported broker to shared MySQL state.
- Preserve service-to-service auth boundaries.
- Keep public docs concise and operational.
- If user, role, permission, or request-model contracts change, update docs and tests in the same change.
