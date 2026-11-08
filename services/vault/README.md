# Vault

Vault is Scriptarr's shared auth, cache, and state broker over MySQL.

Vault is the only first-party service allowed to touch the shared MySQL database directly. It keeps a cache-first
shared read layer in front of hot state and now stores durable generic jobs and job tasks for long-running work such
as managed-service updates and Raven pipeline activity.
For retained databases with the legacy required `raven_titles.cataloged_at` column, startup supplies a missing
precision-matched timestamp default. Existing timestamps, custom defaults, column constraints and indexes remain
intact. Fresh databases keep the current schema without adding that legacy column.
Vault now also persists reusable permission groups, user-group assignments, and the shared durable event log that
powers `/admin/users`, `/admin/requests`, and `/admin/system/events`. The bootstrap owner stays protected, while every
other user's admin access is derived from one or more permission groups plus a required default onboarding group for
new or returning Discord sign-ins. The seeded default is `Member-AI`, which includes `use_noona_chat`; `Member` stays
available as the no-AI opt-out group, and Vault performs a one-time repair that moves old default-only `Member` users
to `Member-AI` without reapplying that move after an admin later removes chat access.
Session reads stay on the fast path: Vault looks up the requested token, checks its TTL, and leaves expired-row cleanup
to startup and periodic pruning. MySQL stores keep session and role indexes for auth/bootstrap lookups.
For external MySQL deployments, Vault keeps the shared pool warm with a guarded low-frequency health probe and logs
slow `health` or service settings reads without exposing setting values. The keepalive never overlaps itself, so a
stalled cold connection cannot pile up duplicate probes.
Vault now also persists title-level and chapter-level read state for Moon's bookshelf and completion logic. Progress
rows still track the current reading position, while the read-state model determines whether a title is active on the
bookshelf or fully completed.
Vault also carries Raven ingest state in the catalog: title aggregate status and counts, plus chapter `ingestStatus`,
`ingestRevision`, `ingestedPageCount`, `ingestedAt`, redacted `ingestError`, and manifest path. Compact reader targets
only consider chapters whose ingest status is ready. Raven's AVIF hot path uses Vault's service-only single-chapter
upsert route for per-chapter progress, so a large title no longer rewrites all sibling chapter rows on each checkpoint.
Raven download-task heartbeats keep the caller-provided UTC `updatedAt` timestamp so Moon's live queue can distinguish
fresh active work from genuinely stale tasks even when the MySQL server timezone differs from UTC.
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
ordering for activity hydration, and keeps chapter arrays plus Raven filesystem roots out of card payloads. The
projection deduplicates by library type plus normalized title before counts, sorting, letters, and pagination so Moon
does not show stale duplicate catalog rows while cleanup is rolling out.
Vault stores `catalog_key` on Raven titles and a `raven_title_aliases` map for retired duplicate ids. Exact-id card
lookups, title summaries, chapter pages, reader targets, and metadata-match reads resolve aliases to the canonical title.
The service-only duplicate preview and merge endpoints are intended for Sage/Warden maintenance only; merges write an
audit setting after moving chapters, metadata, read/progress state, follows, and bookmarks to the canonical title.
Large catalog cleanups can pass a `limit` so Vault previews title rows cheaply and hydrates chapter rows only for the
duplicate groups being merged in that batch.

It also stores the Raven VPN settings, Raven metadata provider configuration, Oracle provider state, Portal Discord
workflow settings including release notification channel id, and Oracle secrets used by the rest of the stack. Moon
branding, uploaded WebP logo variants, release/downloadall notification acknowledgments, downloadall reaction prompt
state, and admin toast preferences are normal Vault settings and survive content reset with other settings.

Chapter conversion has a separate transactional store under the Sage-only `/api/service/raven-ingest` routes.
Deterministic `raven_webp_<sha256>` identities bind the title, chapter, source archive SHA256, and fixed WebP profile.
MySQL serializes claims through one InnoDB pool-row lock: the entire network has one encoding lease, lasting 120
seconds with 20-second renewals. Claims retain durable replay receipts and hashed lease secrets; reassignment increments
the epoch and rejects stale uploads, heartbeats, failures, and publication. Fresh interactive work precedes bulk work,
which precedes migration. Joining fresh work can promote a queued migration without changing its content identity.
Validated results release the encoding slot and remain recoverable until the coordinator atomically commits the final
chapter and job completion. Generic job upserts are not substitutes for these fenced operations.
Each create also receives a server-issued `spec.coordinatorGeneration`, separate from the immutable content identity.
It survives worker claims and lease reassignments, and rotates on queued priority/ownership promotion or explicit retry.
Coordinators cancel with the generation captured for their own execution, so a queued-to-claimed race can stop its
worker while a delayed old cancellation cannot stop a newer approved retry. Exact create/retry replays retain the token;
legacy explicit epoch cancellation remains supported.

Existing AVIF chapters remain readable. WebP chapter checkpoints additionally retain `sourcePageCount`,
`expectedSegmentCount`, `ingestedSegmentCount`, and `segmentsReady`; logical page counts never count physical tiles.
Partial or legacy WebP output without a complete segment checkpoint is not reader-ready. Metadata-only updates preserve
omitted segment fields in both memory and MySQL, and publication invalidates cached catalogue and reader projections.

Selected-run cleanup uses the separate `content-reset/preview`, `begin`, `apply`, and `finish` conversion routes.
Preview records exactly the selected durable plans and owned tasks, deduplicates canonical IDs, and retains the original
filesystem inventory for crash recovery. A canonical title requires a persisted task/append reference or an exact
selected source URL and library type; metadata aliases or similar names cannot expand deletion scope. Ambiguous source
ownership fails closed. Begin requires the original run to be cancelled and fences canonical IDs and retired aliases.
Apply requires Raven's exact quiescent filesystem-removal proof. It clears only scoped chapters, roots and content
readiness/counters, retaining title/alias identities, metadata, covers, publication status, all user reading state,
requests, jobs, download-task history, settings and credentials. Finish releases the fence. Replaying a finished apply
never clears fresh content again. This scoped workflow does not call the older global content-reset operation.
