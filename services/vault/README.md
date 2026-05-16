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
When Sage resets a title unread, Vault deletes that user's `media_title_state`, `media_chapter_reads`, and
`media_progress` rows for the title instead of leaving a started unread title on the bookshelf.
Vault now also persists first-class API key records for Moon and Sage. It stores hashed key material plus metadata for
system keys, user-owned keys, permission-group assignment, last-used timestamps, and revocation state; plaintext API
keys are never stored.
Vault also exposes a service-only database explorer contract for Sage. It reports overview and table data through an
allowlisted, paginated, redacted path and never accepts arbitrary SQL from browser flows. The first write path is
limited to validated JSON rows in `settings`; users, sessions, secrets, permission groups, API keys, and durable
events remain read-only through the explorer.
Its content reset path is content-only, not a factory reset: requests, work locks, progress, read state, follows,
reader bookmarks, Raven catalog rows, Raven tasks, and Raven-owned jobs are cleared, while users, permission groups,
API keys, sessions, settings, secrets, and durable events remain intact.
Vault also exposes the service-only `GET /api/service/raven/title-cards` projection for Moon shelves. It reads from
`raven_titles` only, supports query, type, letter, cursor, page-size, sort, and exact `ids` filters, preserves exact-id
ordering for activity hydration, and keeps chapter arrays plus Raven filesystem roots out of card payloads.

It also stores the Raven VPN settings, Raven metadata provider configuration, Oracle provider state, Portal Discord
workflow settings including release notification channel id, and Oracle secrets used by the rest of the stack. Moon
branding, uploaded WebP logo variants, release/downloadall notification acknowledgments, downloadall reaction prompt
state, and admin toast preferences are normal Vault settings and survive content reset with other settings.
