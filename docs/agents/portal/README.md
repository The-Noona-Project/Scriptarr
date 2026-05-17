# Portal AI Notes

- Portal owns Discord-facing request creation, moderation messaging, subscriptions, onboarding, public Noona mention
  chat, and Oracle chat entry.
- It no longer bridges Kavita or Komf.
- Portal is not allowed to call Vault or Oracle directly. First-party internal traffic must go through Sage's token-authenticated broker routes.
- The live Discord command set is `/ding`, `/status`, `/chat`, `/search`, `/request`, `/subscribe`, `/trivia`, and
  owner-only DM `/downloadall`.
- Portal should treat the brokered `portal.discord` setting as the source of truth for guild id, onboarding message or
  channel, DM superuser id, release notification channel id, update notification channel id, and per-command role gates.
- Bundled Discord avatar assets live in `services/portal/assets/discord`. Portal may upload the configured
  `SCRIPTARR_DISCORD_BOT_PERSONA` avatar on startup according to `SCRIPTARR_DISCORD_AVATAR_MODE`, but should not write
  avatar bytes into Vault or Discord message memory.
- Portal should prefer a minimal Discord runtime over going fully dark when privileged intents are unavailable. Slash
  commands and DMs should remain online, while onboarding should degrade separately and surface the real runtime error
  or command-sync problem back through Moon admin.
- Portal now also owns requester approval, denial, and completion DMs. Keep those notifications deduped by request id
  plus decision state, and reuse the shared `coverUrl` plus Moon public base URL when they are available.
- Portal also owns release channel posts for completed Raven downloads. Poll Sage's release-notification queue, send
  one compact digest to the configured channel with up to ten Moon read or title links plus `+N more`, and acknowledge
  only after Discord accepts the message.
- Portal also owns update channel posts for Sage-created GitHub update digests. Poll Sage's update-notification queue,
  post Noona's AI-written summary to the configured update channel, and acknowledge only after Discord accepts the
  message. Portal must not call GitHub or Oracle directly for this workflow.
- Portal owns Noona trivia runtime delivery. It should start/stop rounds through Sage, treat normal messages in the
  configured trivia channel as guesses, post quiet reactions for wrong guesses, announce the first correct winner, and
  acknowledge leaderboard posts only after Discord accepts the message.
- Portal owns only the Discord delivery side of natural Noona mention chat. Detect mentions by bot user id, not
  display name; ignore bots, wrong guilds, disallowed channels, empty prompts, and unmentioned chatter; reuse the
  `/chat` command role gate; send typing; reply publicly to the triggering message; and split replies safely before
  Discord's message limit.
- Mention chat must call Sage's `/api/internal/portal/noona-chat` route, not Oracle directly. Sage owns durable memory,
  allowed read context, latest posted update digest context, conservative proposal detection, and Oracle fallback
  behavior.
- Noona/Appa appearance knowledge belongs in Sage's visual identity helper and is passed to Oracle as read-only
  context. Portal only owns Discord delivery and default avatar upload.
- When mention chat handles a guild message, do not pass that same message into trivia guess handling. Unmentioned
  guild messages should still flow to trivia unchanged.
- Keep one active trivia clock. Startup, settings reload, manual starts, wins, and timeouts should reconcile against
  Sage state, schedule either the active round followups or the next round, and ignore stale timers from older runtime
  generations. Repeated `/trivia start` during an active round should report the existing round without reposting the
  clue.
- Portal may ask Sage -> Oracle for bounded message assistance, but deterministic notification templates stay
  authoritative and acknowledgments still happen only after a Discord send succeeds.
- Durable Noona memory is a capped Vault settings summary, not raw transcript storage. Portal may surface runtime
  diagnostics such as last mention time/error, while Sage handles `remember that`, `forget that`, `forget me`, and
  `what do you remember about me?`.
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
  requested partials, last DM receive timestamp, last handled `downloadall`, last `downloadall` error, and last Noona
  mention-chat time/error.
