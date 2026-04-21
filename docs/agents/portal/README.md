# Portal AI Notes

- Portal owns Discord-facing request creation, moderation messaging, subscriptions, onboarding, and Oracle chat entry.
- It no longer bridges Kavita or Komf.
- Portal is not allowed to call Vault or Oracle directly. First-party internal traffic must go through Sage's token-authenticated broker routes.
- The live Discord command set is `/ding`, `/status`, `/chat`, `/search`, `/request`, `/subscribe`, and DM-only
  `downloadall`.
- Portal should treat the brokered `portal.discord` setting as the source of truth for guild id, onboarding message or
  channel, DM superuser id, and per-command role gates.
- Portal should prefer a minimal Discord runtime over going fully dark when privileged intents are unavailable. Slash
  commands and DMs should remain online, while onboarding should degrade separately and surface the real runtime error
  or command-sync problem back through Moon admin.
- Portal now also owns requester approval, denial, and completion DMs. Keep those notifications deduped by request id
  plus decision state, and reuse the shared `coverUrl` plus Moon public base URL when they are available.
- DM-only `downloadall` is still provider-browse first, but it must now go through Raven's metadata-safe bulk resolver
  before queueing anything. Queue only titles with one confident metadata match and surface already-active,
  no-metadata, ambiguous-metadata, and failed outcomes in the DM summary.
- That DM bulk path stays owner-only and WeebCentral-only. Even when MangaDex is enabled for normal intake or direct
  requests, Portal should always send `providerId=weebcentral` for `downloadall` and surface a clear error when
  WeebCentral is disabled.
