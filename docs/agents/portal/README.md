# Portal AI Notes

- Portal owns Discord-facing request creation, moderation messaging, subscriptions, onboarding, and Oracle chat entry.
- It no longer bridges Kavita or Komf.
- Portal is not allowed to call Vault or Oracle directly. First-party internal traffic must go through Sage's token-authenticated broker routes.
- The live Discord command set is `/ding`, `/status`, `/chat`, `/search`, `/request`, `/subscribe`, `/trivia`, and
  owner-only DM `/downloadall`.
- Portal should treat the brokered `portal.discord` setting as the source of truth for guild id, onboarding message or
  channel, DM superuser id, release notification channel id, and per-command role gates.
- Portal should prefer a minimal Discord runtime over going fully dark when privileged intents are unavailable. Slash
  commands and DMs should remain online, while onboarding should degrade separately and surface the real runtime error
  or command-sync problem back through Moon admin.
- Portal now also owns requester approval, denial, and completion DMs. Keep those notifications deduped by request id
  plus decision state, and reuse the shared `coverUrl` plus Moon public base URL when they are available.
- Portal also owns release channel posts for completed Raven downloads. Poll Sage's release-notification queue, send
  to the configured channel with a Moon read or title link, and acknowledge only after Discord accepts the message.
- Portal owns Noona trivia runtime delivery. It should start/stop rounds through Sage, treat normal messages in the
  configured trivia channel as guesses, post quiet reactions for wrong guesses, announce the first correct winner, and
  acknowledge leaderboard posts only after Discord accepts the message.
- Keep one active trivia clock. Startup, settings reload, manual starts, wins, and timeouts should reconcile against
  Sage state, schedule either the active round followups or the next round, and ignore stale timers from older runtime
  generations. Repeated `/trivia start` during an active round should report the existing round without reposting the
  clue.
- Portal may ask Sage -> Oracle for bounded message assistance, but deterministic notification templates stay
  authoritative and acknowledgments still happen only after a Discord send succeeds.
- Portal also sends deduped system DMs for LocalAI lifecycle jobs exposed by Sage, including install, start, and
  remove completion or failure notices for the Discord-backed admin who requested the action.
- Portal-originated async request and Discord-runtime state that matters to operators should now be mirrored into the
  shared durable event log through Sage's internal broker routes instead of living only in Portal-local memory.
- `/request` now mirrors Moon's metadata-first wizard. Portal should search raw metadata rows first, then submit one
  exact metadata choice for moderated review instead of asking the requester to pick a download provider.
- Duplicate blockers should not create visible extra requests. Portal should surface the blocked state, rely on Sage's
  hidden waitlist attachment, DM those users again when the title is ready, and keep source-found plus expired
  unavailable DMs aligned with the same request-notification state machine.
- When Sage later finds a source for an unavailable request, Portal should DM that the request moved back into admin
  review or auto-approved; do not reintroduce requester-side source picking in Discord.
- DM `/downloadall` now uses a global slash command as the supported path: `/downloadall run ...`,
  `/downloadall status ...`, `/downloadall continue ...`, `/downloadall cancel ...`, and `/downloadall help`. Keep
  the raw text parser as a legacy best-effort fallback only; it still depends on Discord delivering DM `messageCreate`
  events.
- That DM bulk path stays owner-only and WeebCentral-only. Even when MangaDex is enabled for normal intake or direct
  requests, Portal should always send `providerId=weebcentral` for `downloadall`, reject non-owner callers before
  touching Sage, and surface a clear error when WeebCentral is disabled.
- `downloadall` is still provider-browse first, but it must now go through Raven's metadata-safe durable run flow
  before queueing anything. Queue only titles with one confident metadata match and surface already-active, completed,
  already-current, appended, adult-content, no-metadata, ambiguous-metadata, invalid-source, and failed outcomes in the
  DM summary. When the requester uses `nsfw:false`, Raven must require an explicit WeebCentral `Adult Content: No`
  before queueing.
- Portal should poll Sage's downloadall notification queue, DM the requester for paused/completed/failed/cancelled
  run batches with stable `downloadall:<runId>:<batchId>:<status>` ids, and acknowledge only after Discord accepts
  the DM.
- Paused downloadall DMs should add check/cross decision reactions and persist the DM message mapping through Sage
  before acknowledging the notification. Only the configured owner can decide; check continues the run and cross
  cancels remaining work. Completed, failed, and cancelled summaries are informational and should not create decision
  prompts.
- Preserve `groupsize` across slash-command and legacy DM parsing as `batchesPerApproval` with bounds `1-25`.
- Portal runtime state should keep enough DM diagnostics to explain silent failures quickly: requested intents,
  requested partials, last DM receive timestamp, last handled `downloadall`, and last `downloadall` error.
