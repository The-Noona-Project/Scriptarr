# Vault AI Notes

- Vault owns users, roles, permissions, sessions, requests, settings, secrets, progress, generic jobs, and the
  shared cache over MySQL.
- Vault now persists reusable permission groups, user-group assignments, and the shared durable event log in addition
  to the stored user rows. Non-owner access is group-based, while the bootstrap owner remains protected from normal
  reassignment or deletion.
- Vault's shared read path is cache-first, with a six-hour in-process TTL cache that repopulates from MySQL on miss.
- Services should not bypass Vault to read or write shared state directly.
- Vault is the only first-party service allowed to touch MySQL.
- Sage is the supported caller for Vault's HTTP API. Other first-party services should use Sage's internal broker
  routes instead of calling Vault directly.
- Raven VPN settings and Oracle credentials live here in 3.0.
- Keep exactly one default onboarding permission group at all times. New or returning Discord users should land on that
  group automatically when they do not already have assignments.
- Deleting a user from Vault-backed access should clear sessions plus local group assignments, but preserve requests,
  progress, follows, bookmarks, and durable events so a future Discord sign-in can recreate that user cleanly.
- Durable events should stay immutable, summary-oriented, and retention-managed instead of storing large raw snapshots.
