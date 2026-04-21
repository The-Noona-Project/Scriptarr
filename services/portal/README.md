# Portal

Portal handles Discord onboarding, requests, notifications, subscriptions, and Oracle chat routing.

Portal can run in full Discord mode or in API-only degraded mode when Discord auth is missing or fails.
When Discord rejects privileged intents, Portal now falls back to a minimal slash-command and DM runtime instead of
taking the whole bot offline. In that mode `/ding`, the rest of the slash-command catalog, and DM-only commands can
stay online while guild-member onboarding is marked degraded until the Server Members intent is available.

Portal does not call other first-party services directly. Discord request creation, library search, follow updates, bulk download queueing, onboarding settings, and Oracle chat traffic are brokered through Sage's internal service routes.

Portal's supported Discord command set is:

- `/ding`
- `/status`
- `/chat`
- `/search`
- `/request`
- `/subscribe`
- DM-only `downloadall`

`downloadall` stays provider-browse first, but it now asks Raven to metadata-resolve each matched bulk title before
queueing it. Portal only queues titles with one confident metadata match and reports already-active, no-metadata,
ambiguous-metadata, and failed skips in the DM summary. The command is still owner-only and intentionally pinned to
WeebCentral, so it fails if that provider is disabled instead of browsing MangaDex.

Guild id, onboarding settings, DM superuser id, and per-command role gates are managed from Moon admin at
`/admin/discord`. Discord bot credentials remain env-managed.

Moon admin also surfaces the live Discord runtime state from Portal, including command-sync health, onboarding
capability, and the last meaningful Discord runtime error when the bot disconnects.

Portal also watches request-linked moderation and Raven completion state through Sage. When a request is approved,
denied, or finished and the requester has a Discord id, Portal sends one deduped DM with the shared title art and the
right Moon link instead of duplicating notification state in a separate store.
