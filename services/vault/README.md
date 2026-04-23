# Vault

Vault is Scriptarr's shared auth, cache, and state broker over MySQL.

Vault is the only first-party service allowed to touch the shared MySQL database directly. It keeps a cache-first
shared read layer in front of hot state and now stores durable generic jobs and job tasks for long-running work such
as managed-service updates and Raven pipeline activity.
Vault now also persists reusable permission groups, user-group assignments, and the shared durable event log that
powers `/admin/users`, `/admin/requests`, and `/admin/system/events`. The bootstrap owner stays protected, while every
other user's admin access is derived from one or more permission groups plus a required default onboarding group for
new or returning Discord sign-ins.

It also stores the Raven VPN settings, Raven metadata provider configuration, Oracle provider state, and Oracle
secrets used by the rest of the stack.
