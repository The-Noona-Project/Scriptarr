# Portal

Portal handles Discord onboarding, requests, notifications, subscriptions, Noona trivia, public Noona mention chat,
and Oracle chat routing.

Portal can run in full Discord mode or in API-only degraded mode when Discord auth is missing or fails.
When Discord rejects privileged intents, Portal now falls back to a minimal slash-command and DM runtime instead of
taking the whole bot offline. In that mode `/ding`, the rest of the slash-command catalog, and DM-only commands can
stay online while guild-member onboarding is marked degraded until the Server Members intent is available.

Portal does not call other first-party services directly. Discord request creation, library search, follow updates,
durable downloadall runs, onboarding settings, public Noona mention chat, and Oracle chat traffic are brokered through
Sage's internal service routes.

Portal's supported Discord command set is:

- `/ding`
- `/status`
- `/chat`
- `/search`
- `/request`
- `/subscribe`
- `/trivia`
- owner-only DM `/downloadall`

Discord `/request` now mirrors Moon's web flow instead of using a one-shot fuzzy picker. Portal first shows raw
metadata-provider matches, then lets the requester submit one exact metadata choice with optional notes. Staff later
choose the concrete download source from `/admin/requests`, unless Sage auto-approves one high-confidence source. If
the metadata exists but there is no source yet, Portal can still create an `unavailable` request, and when Sage later
finds a source it DMs the requester that the title is back in admin review or was auto-approved.

`downloadall` now uses a global slash command in DMs as the supported path: `/downloadall run ...`,
`/downloadall status runid:<id>`, `/downloadall continue runid:<id>`, `/downloadall cancel runid:<id>`, and
`/downloadall help`. Portal still keeps the older raw DM text parser (`downloadall ...`) as a legacy best-effort
fallback, but that path depends on Discord delivering `messageCreate` events and should not be treated as the primary
interface anymore. The command stays owner-only and intentionally pinned to WeebCentral, so it fails if that provider
is disabled instead of browsing MangaDex.
Every `downloadall` request now creates a durable Raven run. Selecting `type:all` or `titlegroup:all` creates multiple
batches; Raven pauses after the configured `groupsize` batch count, which defaults to one and is capped at 25. Paused
summary DMs get check/cross reactions so the owner can continue or cancel without typing a follow-up command.
Bulk queueing is still provider-browse first, but it now asks Raven to metadata-resolve each matched bulk title before
queueing it. Portal only queues titles with one confident metadata match and reports already-active, completed,
already-current, appended, adult-content, no-metadata, ambiguous-metadata, invalid-source, and failed outcomes in the
DM summary. For `nsfw:false`, Raven only queues titles whose WeebCentral detail page explicitly says
`Adult Content: No`; adult or unverified titles are skipped.

Guild id, onboarding settings, release notification channel id, GitHub update channel id, DM superuser id, Noona mention-chat settings, and
per-command role gates are managed from Moon admin at `/admin/discord`. Discord bot credentials remain env-managed.

Moon admin also surfaces the live Discord runtime state from Portal, including command-sync health, onboarding
capability, requested intents or partials, the most recent DM receive timestamp, the last handled `downloadall`
timestamp, the last `downloadall` error text, last Noona mention-chat time or error, and the last meaningful Discord
runtime error when the bot disconnects.

Noona mention chat lets guild users talk naturally to the real bot user id, such as `@Noona Ai are you alive?`. Portal
detects the bot mention by Discord user id, removes the mention from the prompt, checks the same `/chat` role gate used
by the slash command, sends typing, asks Sage, and replies publicly to the triggering message. It ignores bots, wrong
guilds, empty prompts, disallowed channels, and ordinary unmentioned chatter. Mention chat returns `true` to the guild
message pipeline when it handles a message, so trivia does not also process the same message as a guess.

The `portal.discord.noonaChat` setting owns the rollout shape:

- `enabled`: defaults to `false` on fresh installs
- `allowedChannelIds`: empty means every channel in the configured guild
- `memoryEnabled`: defaults to `true` once mention chat is enabled
- `publicReplies`: fixed `true` for this version
- `proposalMode`: `conservative` or `off`

Discord's Message Content intent must be enabled in the Discord developer portal for mention chat, trivia guesses, and
legacy DM text fallback handling. Portal requests the gateway intent, but Discord will not deliver message content
until the application setting allows it.

Durable Noona memory is summarized through Sage and Vault, not stored as raw Discord transcripts. Users can say
`remember that ...`, `forget that`, `forget me`, or `what do you remember about me?`. Server lore such as `LONG LIVE
NOONA` is capped separately from user facts. Admins can review memory counts and clear one user, server lore, or all
Noona memory from `/admin/discord`.

Public chat never executes mutations. Sage gives it a conservative read context for status, Discord runtime, trivia,
and library search, and can draft only low-risk proposals such as status checks or trivia start/stop for later admin
confirmation. LocalAI lifecycle, root/system, destructive, and arbitrary broadcast actions stay out of the public-chat
allowlist even if the admin AI page has them enabled.

Portal also watches request-linked moderation, Raven completion state, and Sage system notifications. When a request is
approved, denied, or finished and the requester has a Discord id, Portal sends one deduped DM with the shared title art
and the right Moon link instead of duplicating notification state in a separate store. Portal also DMs admins who
request LocalAI install, start, or remove jobs when those jobs complete or fail.
When `/admin/discord` has a release channel id, Portal also polls Sage for completed Raven download notifications,
posts one channel message with the best Moon read or title link, and acknowledges the stable `release:<taskId>` id only
after the send succeeds.
When `/admin/discord` has an update channel id, Portal also polls Sage for GitHub update digest notifications, posts
Noona's AI-written summary of new `The-Noona-Project/Scriptarr` commits, and acknowledges the stable
`update:<latestSha>` id only after Discord accepts the channel message. The summary is generated by Sage and Oracle;
Portal does not call GitHub or Oracle directly for update posts.
Portal now also DMs blocked duplicate requesters when they are attached to the hidden ready-notify waitlist, DMs
waitlisted users again when the title becomes ready, DMs unavailable requesters when a source appears and the request
moves back into admin review, and DMs them again if that unavailable request expires after 90 days.
Portal also polls Sage for durable downloadall run notifications and DMs the requester paused, completed, failed, or
cancelled summaries once per stable notification id.

Noona trivia is Sage-backed and runs from the configured trivia channel. Portal now reconciles one active trivia clock
from Sage state on startup, settings refresh, manual start, win, and timeout. Repeated `/trivia start` calls while a
round is open report the existing round instead of reposting the clue, and stale timers from old reloads cannot post
duplicate hints, timeouts, leaderboards, or next rounds.
