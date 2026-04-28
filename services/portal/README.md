# Portal

Portal handles Discord onboarding, requests, notifications, subscriptions, and Oracle chat routing.

Portal can run in full Discord mode or in API-only degraded mode when Discord auth is missing or fails.
When Discord rejects privileged intents, Portal now falls back to a minimal slash-command and DM runtime instead of
taking the whole bot offline. In that mode `/ding`, the rest of the slash-command catalog, and DM-only commands can
stay online while guild-member onboarding is marked degraded until the Server Members intent is available.

Portal does not call other first-party services directly. Discord request creation, library search, follow updates,
durable downloadall runs, onboarding settings, and Oracle chat traffic are brokered through Sage's internal service
routes.

Portal's supported Discord command set is:

- `/ding`
- `/status`
- `/chat`
- `/search`
- `/request`
- `/subscribe`
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
batches; Raven pauses the run after each batch until the owner explicitly continues it from DM slash commands.
Bulk queueing is still provider-browse first, but it now asks Raven to metadata-resolve each matched bulk title before
queueing it. Portal only queues titles with one confident metadata match and reports already-active, completed,
already-current, appended, adult-content, no-metadata, ambiguous-metadata, invalid-source, and failed outcomes in the
DM summary. For `nsfw:false`, Raven only queues titles whose WeebCentral detail page explicitly says
`Adult Content: No`; adult or unverified titles are skipped.

Guild id, onboarding settings, release notification channel id, DM superuser id, and per-command role gates are
managed from Moon admin at `/admin/discord`. Discord bot credentials remain env-managed.

Moon admin also surfaces the live Discord runtime state from Portal, including command-sync health, onboarding
capability, requested intents or partials, the most recent DM receive timestamp, the last handled `downloadall`
timestamp, the last `downloadall` error text, and the last meaningful Discord runtime error when the bot disconnects.

Portal also watches request-linked moderation, Raven completion state, and Sage system notifications. When a request is
approved, denied, or finished and the requester has a Discord id, Portal sends one deduped DM with the shared title art
and the right Moon link instead of duplicating notification state in a separate store. Portal also DMs admins who
request LocalAI install, start, or remove jobs when those jobs complete or fail.
When `/admin/discord` has a release channel id, Portal also polls Sage for completed Raven download notifications,
posts one channel message with the best Moon read or title link, and acknowledges the stable `release:<taskId>` id only
after the send succeeds.
Portal now also DMs blocked duplicate requesters when they are attached to the hidden ready-notify waitlist, DMs
waitlisted users again when the title becomes ready, DMs unavailable requesters when a source appears and the request
moves back into admin review, and DMs them again if that unavailable request expires after 90 days.
Portal also polls Sage for durable downloadall run notifications and DMs the requester paused, completed, failed, or
cancelled summaries once per stable notification id.
