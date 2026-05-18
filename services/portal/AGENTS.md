# Portal Agent Guide

Read this before editing `services/portal`.

## Role

Portal handles Discord onboarding, requests, notifications, subscriptions, Noona trivia, public Noona mention chat,
optional Appa admin/reviewer chat, and the Oracle chat bridge through Sage.

## Hard Rules

- Do not reintroduce Kavita or Komf dependencies.
- Moon and Discord requests must converge on one moderated request flow.
- Oracle integration is assistive only: Portal may call Oracle through Sage for bounded helper text, but deterministic
  templates and Sage-owned state remain authoritative.
- Portal must send first-party internal HTTP through Sage. Do not add direct Vault, Warden, Raven, or Oracle calls here.
- Keep the split Discord command contract intact: Noona owns reader-facing commands and public chat; Appa owns admin
  commands, admin mentions, DM-only `downloadall`, redacted Discord diagnostics, and serious Noona corrections. If
  Appa is disabled, missing env, or degraded at startup, Noona must keep the legacy single-bot admin fallback.
- Noona trivia guesses are normal guild messages in the configured channel. Portal should ignore bots, wrong channels,
  and inactive rounds; Sage owns the round, guess, score, and leaderboard state.
- Public Noona mention chat should detect the real bot mention by Discord user id, not display name. It must ignore
  bots, wrong guilds, empty prompts, disallowed channels, and unmentioned chatter; reuse the `/chat` role gate; reply
  publicly; split long replies; and return handled so trivia does not also process the same message.
- Appa review should happen after Noona replies and only post same-thread corrections for serious verdicts. Persist
  review and delivery results through Sage with redacted excerpts, not raw transcripts.
- Appa Discord diagnostics may inspect recent messages only in configured Noona/Appa-allowed channels. Redact content
  before responding or auditing, and persist only redacted diagnostic events through Sage.
- Keep Discord workflow configuration behind the brokered `portal.discord` setting consumed from Moon admin instead of
  scattering guild, role, or onboarding logic across unrelated env vars.
- Keep public Discord copy branded. Normal slash-command replies, requester DMs, release posts, and update posts should
  use the configured site name or Noona instead of internal service codenames; owner-only diagnostics may name services
  when that helps operate the stack.
- Keep Noona public copy human and compact. Do not duplicate AI summaries above and inside embeds, do not expose raw
  commit rows as Noona's voice, and keep repository/commit traceability in clearly labeled embed fields.
- For live Noona tone QA, use Appa diagnostics/review from an allowed admin/dev channel when configured. Keep snippets
  short and redacted, and do not persist raw Discord transcripts. Test both public mention replies and GitHub update
  posts because Portal formatting can make a good Oracle summary feel noisy.
- Requester completion DMs and channel notifications should stay deduped by stable Sage acknowledgment ids so restarts
  or retries do not spam Discord users or channels. Release channel notifications should render Sage digest payloads as
  compact Scriptarr-branded posts and acknowledge digest metadata only after Discord accepts the message.
- `downloadall` should always use Sage's durable run path, including legacy raw DM text, and Portal should DM paused,
  completed, failed, or cancelled run summaries only once after Sage exposes a stable notification id.
- Reuse the shared `coverUrl` and Moon public base URL in Portal embeds and DMs when they are available instead of
  inventing a second artwork or link source.

## Coding Map

- Discord command handlers and runtime helpers live under `lib/discord`. Keep slash command parsing, DM-only command
  branches, notification polling, mention chat, and trivia timers in small modules instead of expanding a single gateway
  file.
- Portal should persist and decide shared state through Sage routes only. Use brokered settings for guild, role,
  onboarding, release-channel, update-channel, Noona mention chat, Appa split/review behavior, trivia, and DM superuser
  configuration.
- Mention chat memory and proposal decisions belong to Sage and Vault. Portal may keep only short rolling/runtime
  diagnostics such as last mention time or error.
- Update-notification delivery lives in `lib/followNotifier.mjs`. Portal should render one concise Noona summary plus
  metadata fields; do not duplicate the AI-written body in message content and embed description.
- Request and completion notifications should keep stable acknowledgment ids so retries or restarts do not duplicate
  requester DMs, release posts, or GitHub update-summary posts.
- Trivia runtime must reconcile one Sage-backed active round clock. Refreshes, repeated starts, and settings reloads
  should not create duplicate clues, hints, timeouts, or leaderboards.
- Prove Portal changes with `npm --workspace services/portal test`; use `npm run docker:healthcheck` when the change
  crosses Sage, Raven, Vault, or Moon.
