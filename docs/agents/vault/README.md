# Vault AI Notes

- Vault owns users, roles, permissions, sessions, requests, settings, secrets, progress, generic jobs, and the
  shared cache over MySQL.
- Vault now persists reusable permission groups, user-group assignments, and the shared durable event log in addition
  to the stored user rows. Non-owner access is group-based, while the bootstrap owner remains protected from normal
  reassignment or deletion.
- Vault's shared read path is cache-first, with a six-hour in-process TTL cache that repopulates from MySQL on miss.
- Session reads should remain a single token lookup plus TTL check. Do expired-session deletion through
  `pruneExpiredSessions`, which runs at Vault startup and on the app timer, and keep session cache entries bounded by
  the session TTL.
- Services should not bypass Vault to read or write shared state directly.
- Vault is the only first-party service allowed to touch MySQL.
- Legacy catalog compatibility is allowlisted to `raven_titles.cataloged_at`: only a required non-generated timestamp
  with no default receives `ALTER COLUMN ... SET DEFAULT (CURRENT_TIMESTAMP(precision))`. Never retype/drop the column,
  rewrite existing values, change SQL mode, or add it to fresh schemas. Other defaults and constraints stay unchanged.
- Sage is the supported caller for Vault's HTTP API. Other first-party services should use Sage's internal broker
  routes instead of calling Vault directly.
- Vault exposes `PATCH /api/service/users/:discordUserId/profile` for Sage's Discord login refresh path. Keep it
  service-token only and profile-only: it may update `username`, `avatar_url`, and `updated_at`, then refresh user and
  session-user caches; it must not alter role, permission groups, legacy permissions, sessions, or owner state.
- Raven VPN settings and Oracle credentials live here in 3.0.
- Keep exactly one default onboarding permission group at all times. New or returning Discord users should land on that
  group automatically when they do not already have assignments. `Member-AI` is the seeded default and includes
  `use_noona_chat`; `Member` is the no-AI opt-out group. Preserve the one-time migration marker so old default-only
  `Member` users move once to `Member-AI`, but later admin removals are not undone.
- Deleting a user from Vault-backed access should clear sessions plus local group assignments, but preserve requests,
  progress, follows, bookmarks, and durable events so a future Discord sign-in can recreate that user cleanly.
- Durable events should stay immutable, summary-oriented, and retention-managed instead of storing large raw snapshots.
- Durable event queries should support brokered operator filters such as domain, severity, event type, actor, target,
  text search, cursor, and limit so Moon admin pages do not fake filtering over incomplete payloads.
- Vault now also owns `media_title_state` plus `media_chapter_reads`. Treat those records as the durable bookshelf and
  completion source of truth; `media_progress` stays focused on current reading position only.
- Title unread/reset from Sage must delete the matching `media_title_state`, `media_chapter_reads`, and
  `media_progress` rows. Do not reinsert a started unread title state for that reset path.
- Vault now also owns API key records for Moon/Sage. Store only key hashes and metadata, preserve API keys through
  content reset, and expose resolve/list/update/revoke only through service-authenticated Vault routes for Sage.
- Vault now exposes a service-only database explorer contract for Sage. Keep overview and table browsing allowlisted,
  paginated, and redacted for tokens, secrets, sessions, API key hashes, passwords, and similar values. Do not add an
  arbitrary SQL endpoint.
- The DB explorer edit path is intentionally limited to validated JSON settings rows. Users, sessions, secrets,
  permission groups, API keys, and durable events stay read-only from browser-admin flows.
- Moon branding, uploaded WebP logo variants, and admin toast preferences are normal settings records. Content reset
  must preserve them with other settings.
- Brokered Portal Discord settings now include the fallback release channel id, per-library release channel ids, and
  update notification channel id. Durable release/update notification acknowledgments or latest posted GitHub update
  digests are normal settings-backed state that content reset should preserve.
- Downloadall deliveries, reaction prompts, and slash action claims use generic jobs owned by `scriptarr-sage`, with
  kinds `portal-downloadall-delivery`, `portal-downloadall-prompt`, and `portal-downloadall-action`. Keep acknowledged
  delivery tombstones while associated runs remain notification-eligible; do not restore the capped 500-ID setting
  history. Legacy settings acknowledgments remain readable. Content reset preserves these operational jobs.
- Brokered Portal Discord settings now also include Noona trivia configuration. Trivia rounds, guesses, score events,
  leaderboard acknowledgments, AI tool settings, and AI proposals are Vault-backed settings and should survive content
  reset with other operational settings.
- Raven catalog rows now carry title-level and chapter-level media quality fields. Preserve `qualityStatus`,
  clean/partial/missing counts, quality summaries, expected page counts, missing page numbers, and quality notes
  through both memory and MySQL stores so Moon can surface Missing Content without scraping task logs.
- Raven catalog rows now also carry AVIF ingest state. Preserve title aggregate ingest status/count/error plus chapter
  `ingestStatus`, `ingestRevision`, `ingestedPageCount`, `ingestedAt`, redacted `ingestError`, and manifest path through
  memory and MySQL stores. Keep the single-chapter upsert route aligned with full chapter replacement so Raven can
  checkpoint ingest progress without deleting and reinserting sibling chapter rows.
- Reader-target projections should only choose chapters whose ingest status is `ready`; available CBZ-only chapters are
  not reader-ready.
- Vault owns the compact Raven title-card projection at `/api/service/raven/title-cards`. Keep it title-table-only,
  indexed for type/title/recency filters, paginated by cursor/pageSize, able to return exact `ids` in caller order,
  and free of chapter arrays or filesystem roots. Dedupe cards by library type plus normalized title before counts,
  letters, sorting, and pagination so library pages stay resilient while durable duplicate cleanup runs.
- Vault owns Raven catalog aliases. Any retired duplicate title id should resolve to its canonical title for exact card
  lookup, title summary, chapter page, reader target, metadata-match, and catalog write paths.
- Keep duplicate preview/merge maintenance service-only. Merge must write alias mappings and an audit result after
  preserving best title metadata, chapters, metadata matches, quality/ingest state, reader progress, read state,
  follows, and bookmarks on the canonical title. For large libraries, keep preview title-row-only and use bounded
  `limit` batches so a maintenance pass does not hydrate every chapter in the catalog before it can respond.
- Vault also owns the title-page split projections used by Sage. `/api/service/raven/titles/:titleId/summary` returns
  title metadata, user read/progress counts, primary/latest chapter hints, and no `title.chapters` payload.
  `/api/service/raven/titles/:titleId/chapters` returns paged chapter rows with read state plus server-side
  cursor/pageSize/sort/filter/q handling. Keep memory and MySQL behavior aligned, cap chapter page size at 100, and
  invalidate summary/chapter-page caches whenever progress, title read state, chapter read state, or Raven title/chapter
  rows change.
- Vault also owns the service-only reader-target projection for compact cards. Given a Discord user id and bounded
  title ids, return the best chapter target using progress/bookmark first, then next unread, then first readable
  chapter. Keep this projection cache-aware and invalidate it with progress, bookmark, chapter-read, and Raven chapter
  mutations.
- Vault's content reset path must stay content-only. It may clear requests, request work locks, progress, read state,
  follows, bookmarks, Raven catalog rows, Raven download tasks, and Raven-owned jobs, but it must not delete users,
  permission groups, API keys, sessions, settings, secrets, or durable events.

- The selected-run reset is a different, narrower contract: preserve stable title/alias rows, metadata/covers/source
  publication state, every user's reading state, requests, download tasks, jobs and receipts. Fence the exact selected
  durable plans before filesystem deletion; canonical IDs require actual task/append references or exact source/type
  identity, never metadata aliases. Reject ambiguous source ownership. Clear only chapters/roots/content counters after
  the coordinator's quiescent removal proof, then explicitly finish. Finished replay must not clear newly created data.
- Conversion state lives in `conversionJobs.mjs` with a MySQL transaction adapter. Serialize the network's single
  encoding slot using the durable pool-row lock, use DB time for 120-second leases, increment epochs on reassignment,
  retain claim/retry receipts and hashed lease secrets, and reject stale worker operations. Queue priority is
  interactive, bulk, then migration; only queued work can be promoted with new owner attribution.
- Versioned conversion input requires both `contentIdentityVersion: 2` and `orderedEntriesSha256`, the SHA256 of the
  UTF-8 compact JSON string-array in `input.entries`, preserving array order and exact entry names. Validate the digest
  and include both fields in normalized input, spec hash and deterministic content identity. Partial pairs, unknown
  versions and mismatched digests fail closed. Absent both fields must retain the exact legacy normalized input,
  content job ID and spec hash; never rewrite existing jobs or completion history when page order changes.
- Keep coordinator cancellation independent of worker claim epochs: issue `spec.coordinatorGeneration` on create and
  rotate it on queued promotion and every explicit retry, preserving it across claims/lease reassignments. Validate
  captured `expectedCoordinatorGeneration` atomically before cancellation; never let an old waiter fetch a newer token
  merely to cancel it. Idempotent create/retry replays retain their accepted token; retry may promote but never demote
  foreground priority/attribution. Preserve the legacy optional explicit epoch guard.
- Root publication validates all segments and commits the chapter and conversion completion in one transaction. Preserve
  AVIF compatibility, logical page counts, explicit WebP segment checkpoints, metadata-only field preservation, and
  catalogue/reader cache invalidation. Use `SCRIPTARR_TEST_MYSQL_URL` against an isolated MySQL 8.4 instance to exercise
  concurrent claims, forced post-chapter rollback, lost-response replay, and scoped-reset preservation.
- Completed-artifact repair uses the existing coordinator-only `/jobs/:jobId/complete` operation, with top-level
  `expectedCoordinatorGeneration` and `repair: {requestId, expectedCurrentChapterFingerprint}`. Fingerprint the raw
  public Vault chapter JSON using recursively sorted compact JSON plus SHA256; the locked adapter must use exactly
  the same normalized public projection, including null/default/omitted fields. Epoch, generation, artifact, maintenance
  and original source/archive/revision/manifest/logical/physical identity remain fenced on both repair and replay.
  Only failed/pending current checkpoints can repair. Preserve current metadata/quality and the original job completion
  hash, result, timestamps and history; retain separate private request receipts. Identical replay returns its stable
  acknowledgment only while current identity remains ready. Changed requests, later failures and superseded output
  conflict. Catalog `updatedAt` advances to a fresh stable second even for two repairs within one DB second. Ordinary
  chapter writes lock rows and advance changed checkpoints monotonically; unchanged replacement siblings retain theirs.
  Repair must serialize UTC fractional timestamps exactly like publication and ordinary chapter writes, preserving the
  database's existing precision/rounding of `ingestedAt` while advancing only the repair's `updatedAt` checkpoint.
- Fixed profiles accept segmentation versions 1 and 2 with otherwise identical seven fields. Version 2 has a distinct
  profile hash and content job ID; worker capability `profileVersion: 1` describes the transport protocol. Do not mutate
  an existing version-1 job into different tile geometry or infer durable segment readiness from DTO defaults.
