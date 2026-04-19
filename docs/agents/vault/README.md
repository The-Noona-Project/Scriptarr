# Vault AI Notes

- Vault owns users, roles, permissions, sessions, requests, settings, secrets, progress, generic jobs, and the
  shared cache over MySQL.
- Vault's shared read path is cache-first, with a six-hour in-process TTL cache that repopulates from MySQL on miss.
- Services should not bypass Vault to read or write shared state directly.
- Vault is the only first-party service allowed to touch MySQL.
- Sage is the supported caller for Vault's HTTP API. Other first-party services should use Sage's internal broker
  routes instead of calling Vault directly.
- Raven VPN settings and Oracle credentials live here in 3.0.
