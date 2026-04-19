# Scriptarr 3.0

Scriptarr is a self-hosted manga and comics stack rebuilt for 3.0. `Noona` now only refers to the Discord bot and AI
persona while the product, services, storage, images, and docs all use Scriptarr naming.

Warden bootstraps the stack, Moon is the user and admin surface, Sage is the browser-safe broker, Vault owns shared
MySQL-backed state, Raven handles downloads plus metadata, Portal handles Discord, and Oracle provides optional
read-only AI chat.

## Service Map

- `scriptarr-warden`: bootstraps the stack, parses the URL-first MySQL contract, owns `scriptarr-network`, and exposes
  manual LocalAI install or start actions
- `scriptarr-mysql`: durable shared datastore for Scriptarr when `SCRIPTARR_MYSQL_URL=SELFHOST`
- `scriptarr-vault`: auth, permissions, settings, secrets, cache, requests, sessions, and progress broker
- `scriptarr-sage`: Moon-facing auth and orchestration broker
- `scriptarr-moon`: same-origin user app at `/`, native reader routes under `/reader/*`, and Arr-style admin app at `/admin`
- `scriptarr-raven`: Spring Boot Java 24 downloader, library, metadata, and PIA/OpenVPN-aware download engine
- `scriptarr-portal`: Discord onboarding, requests, notifications, subscriptions, and Oracle bridge
- `scriptarr-oracle`: LangChain JS service that starts disabled, defaults to OpenAI config, and can optionally use
  LocalAI later

## Docker Images

Scriptarr no longer ships a compose-based deployment path in this repo. Each first-party service has its own
`Dockerfile`, and the supported helper scripts are:

- `npm run docker:list`
- `npm run docker:build`
- `npm run docker:push`
- `npm run docker:publish`

Published images target `docker.darkmatterservers.com/the-noona-project/scriptarr-<service>:<tag>`.

For end-to-end Docker verification, use:

- `npm run docker:test`
- `npm run docker:test:teardown`

## First Boot

1. Start Warden with `SUPERUSER_ID` set to the Discord user id that is allowed to claim the first admin session.
2. Provide the Discord bot token as `DISCORD_TOKEN`.
3. Set `SCRIPTARR_MYSQL_URL` to `SELFHOST` for managed MySQL or to `mysql://...` for an external database.
4. Optionally set `SCRIPTARR_MYSQL_USER` if you want to override the managed app user or supply a username that is
   missing from the external MySQL URL.
5. Open Moon and use the admin claim flow.
6. Copy the callback URL surfaced by Warden or Moon into the Discord developer portal.
7. Finish integrations, library, metadata, VPN, Oracle, and moderation settings in Moon admin.

## Key Contracts

- Browser traffic stays behind Moon. Browsers should not call Warden, Vault, Raven, Portal, Oracle, or LocalAI
  directly.
- Users can create and track requests in Moon and Discord, but Raven only receives approved work.
- Vault is the only supported broker to the shared MySQL database.
- Warden owns one shared internal Docker network named `scriptarr-network`. Moon is the only first-party service
  exposed publicly by default.
- LocalAI is optional for overall stack health and is not installed on first boot.
- Oracle starts disabled and OpenAI-first. LocalAI is enabled later from Moon admin when the admin is ready for a slow
  install or start cycle.

## Docs

- [ServerAdmin.md](ServerAdmin.md)
- [AGENTS.md](AGENTS.md)
- [AI docs index](docs/agents/README.md)
