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
- Brokered Portal Discord settings now include release and update notification channel ids, and durable release/update
  notification acknowledgments or latest posted GitHub update digests are normal settings-backed state that content
  reset should preserve.
- Downloadall notification acknowledgments and reaction decision prompts are also operational settings-backed state.
  Content reset should preserve them so an owner cannot accidentally lose a paused-run decision path during unrelated
  catalog cleanup.
- Brokered Portal Discord settings now also include Noona trivia configuration. Trivia rounds, guesses, score events,
  leaderboard acknowledgments, AI tool settings, and AI proposals are Vault-backed settings and should survive content
  reset with other operational settings.
- Raven catalog rows now carry title-level and chapter-level media quality fields. Preserve `qualityStatus`,
  clean/partial/missing counts, quality summaries, expected page counts, missing page numbers, and quality notes
  through both memory and MySQL stores so Moon can surface Missing Content without scraping task logs.
- Raven catalog rows now also carry WebP ingest state. Preserve title aggregate ingest status/count/error plus chapter
  `ingestStatus`, `ingestRevision`, `ingestedPageCount`, `ingestedAt`, redacted `ingestError`, and manifest path through
  memory and MySQL stores.
- Reader-target projections should only choose chapters whose ingest status is `ready`; available CBZ-only chapters are
  not reader-ready.
- Vault owns the compact Raven title-card projection at `/api/service/raven/title-cards`. Keep it title-table-only,
  indexed for type/title/recency filters, paginated by cursor/pageSize, able to return exact `ids` in caller order,
  and free of chapter arrays or filesystem roots.
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
