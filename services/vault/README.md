# Vault

Vault is Scriptarr's shared auth, cache, and state broker over MySQL.

Vault is the only first-party service allowed to touch the shared MySQL database directly. It keeps a cache-first
shared read layer in front of hot state and now stores durable generic jobs and job tasks for long-running work such
as managed-service updates and Raven pipeline activity.
Vault now also persists reusable permission groups, user-group assignments, and the shared durable event log that
powers `/admin/users`, `/admin/requests`, and `/admin/system/events`. The bootstrap owner stays protected, while every
other user's admin access is derived from one or more permission groups plus a required default onboarding group for
new or returning Discord sign-ins.
Vault now also persists title-level and chapter-level read state for Moon's bookshelf and completion logic. Progress
rows still track the current reading position, while the read-state model determines whether a title is active on the
bookshelf or fully completed.
Its content reset path is content-only, not a factory reset: requests, work locks, progress, read state, follows,
reader bookmarks, Raven catalog rows, Raven tasks, and Raven-owned jobs are cleared, while users, permission groups,
sessions, settings, secrets, and durable events remain intact.

It also stores the Raven VPN settings, Raven metadata provider configuration, Oracle provider state, and Oracle
secrets used by the rest of the stack.
