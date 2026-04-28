# Portal Agent Guide

Read this before editing `services/portal`.

## Role

Portal handles Discord onboarding, requests, notifications, subscriptions, and the Oracle chat bridge.

## Hard Rules

- Do not reintroduce Kavita or Komf dependencies.
- Moon and Discord requests must converge on one moderated request flow.
- Oracle integration is read-only for v1 status lookup plus chat.
- Portal must send first-party internal HTTP through Sage. Do not add direct Vault, Warden, Raven, or Oracle calls here.
- Keep the current Discord command contract intact unless product requirements explicitly change it: `/ding`, `/status`,
  `/chat`, `/search`, `/request`, `/subscribe`, and DM-only `downloadall`.
- Keep Discord workflow configuration behind the brokered `portal.discord` setting consumed from Moon admin instead of
  scattering guild, role, or onboarding logic across unrelated env vars.
- Requester completion DMs should stay deduped by request id and acknowledgment state so restarts or retries do not
  spam Discord users.
- `downloadall` should always use Sage's durable run path, including legacy raw DM text, and Portal should DM paused,
  completed, failed, or cancelled run summaries only once after Sage exposes a stable notification id.
- Reuse the shared `coverUrl` and Moon public base URL in Portal embeds and DMs when they are available instead of
  inventing a second artwork or link source.
