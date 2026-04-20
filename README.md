# Scriptarr

Scriptarr is a self-hosted manga and comics stack rebuilt for 3.0. `Noona` now only refers to the Discord bot and AI
persona while the product, services, storage, images, and docs all use Scriptarr naming.

Warden bootstraps the stack, Moon is the user and admin surface, Sage is the browser-safe and first-party internal
broker, Vault owns shared MySQL-backed state plus cache or job brokerage, Raven handles downloads plus metadata, Portal
handles Discord, and Oracle provides optional read-only AI chat.

## Service Map

- `scriptarr-warden`: bootstraps the stack, parses the URL-first MySQL contract, owns `scriptarr-network`, and exposes
  manual LocalAI install or start actions
- `scriptarr-mysql`: durable shared datastore for Scriptarr when `SCRIPTARR_MYSQL_URL=SELFHOST`
- `scriptarr-vault`: auth, permissions, settings, secrets, cache, requests, sessions, progress, and generic job broker
- `scriptarr-sage`: Moon-facing auth plus the only supported first-party internal HTTP broker
- `scriptarr-moon`: same-origin installable user app at `/`, type-scoped native reader routes under `/reader/<type>/<title>/<chapter>`, and Arr-style admin app at `/admin`
- `scriptarr-raven`: Spring Boot Java 24 downloader, library, metadata, and PIA/OpenVPN-aware download engine
- `scriptarr-portal`: Discord onboarding, requests, notifications, subscriptions, and Oracle bridge
- `scriptarr-oracle`: FastAPI Python service that starts disabled, defaults to OpenAI config, and can optionally use
  LocalAI later

## Docker Images

Scriptarr no longer ships a compose-based deployment path in this repo. Each first-party service has its own
`Dockerfile`, and the supported helper scripts are:

- `npm run docker:list`
- `npm run docker:build`
- `npm run docker:push`
- `npm run docker:publish`

Published images target `docker.darkmatterservers.com/the-noona-project/scriptarr-<service>:<tag>`.

The supported runtime install path is to manually start only `scriptarr-warden`. Warden runs as its own container with
the Docker socket bind plus its `warden/logs` and `warden/runtime` mounts, then reconciles Moon, Vault, Sage, Raven,
Portal, Oracle, and optional managed MySQL for you. On Linux and Unraid hosts, also bind the full
`SCRIPTARR_DATA_ROOT` path back into the container at the same absolute path so Warden can prepare the storage tree
directly while it reconciles the sibling containers. See [ServerAdmin.md](ServerAdmin.md) for the full container
contract and the recommended `docker run` shape.

Fresh installs no longer seed demo titles into Moon or Raven. The user and admin library views stay empty until Raven
has real imported titles to surface.
Raven now stages active work under `downloading/<type>/...` and promotes completed library content into
`downloaded/<type>/...` inside the Raven downloads tree.
Raven also supports old-style chapter and page naming templates behind the internal `raven.naming` setting while
keeping the current title-folder layout stable for rescans.
Moon requests and admin add-title now use a metadata-first intake flow. Users search once, Scriptarr checks enabled
metadata providers first, then enabled download providers, and stores the selected match snapshot with the request so
moderation can queue the exact Raven target later.
Moon admin also exposes a dedicated Discord page at `/admin/discord` for guild workflow settings, onboarding template
or channel management, per-command role gates, and Portal runtime visibility without exposing Discord credentials.
Moon admin also exposes `/admin/system/api` for trusted automation settings, API key generation, and same-origin
Swagger or OpenAPI links for the public Moon API.

For end-to-end Docker verification, use:

- `npm run docker:healthcheck`
- `npm run docker:test`
- `npm run docker:test:teardown`

## First Boot

1. Start the `scriptarr-warden` container with the Docker socket bind, `SUPERUSER_ID`, and the host data root Warden
   should use for managed service storage. On Linux and Unraid, also bind that host data root back into the container
   at the same path.
2. Provide the Discord bot token as `DISCORD_TOKEN`.
3. Set `SCRIPTARR_MYSQL_URL` to `SELFHOST` for managed MySQL or to `mysql://...` for an external database.
4. Optionally set `SCRIPTARR_MYSQL_USER` if you want to override the managed app user or supply a username that is
   missing from the external MySQL URL.
5. Watch the Warden logs while it reconciles the sibling containers. First boot now surfaces when Docker is creating or
   downloading the managed images.
   Docker health checks now report `healthy` for Warden plus the managed services once each container settles.
6. Open Moon, confirm the bootstrap surface shows the configured first owner id, and use Discord login to claim the
   first owner session.
7. Copy the callback URL surfaced by Warden or Moon into the Discord developer portal.
8. Finish branding, integrations, library, metadata, Raven download-provider, VPN, Oracle, moderation, and managed-service update settings in Moon admin.
   If you use the Discord bot runtime, finish the guild id, onboarding, superuser id, and per-command role mapping in
   `/admin/discord` before syncing slash commands.

## Key Contracts

- Browser traffic stays behind Moon. Browsers should not call Warden, Vault, Raven, Portal, Oracle, or LocalAI
  directly.
- Users can create and track requests in Moon and Discord, but Raven only receives approved work.
- Moon user requests and Moon admin add-title now share one metadata-first intake engine. Requests persist the selected
  metadata plus download match snapshot, and unavailable requests can be re-resolved later instead of being dropped.
- Portal now owns a real Discord command runtime again. The supported command set is `/ding`, `/status`, `/chat`,
  `/search`, `/request`, `/subscribe`, plus the DM-only `downloadall` command for the configured Discord superuser.
- Portal now prefers a minimal Discord runtime over going fully dark when privileged intents are unavailable, so slash
  commands and DMs can stay online while onboarding is shown as degraded in Moon admin.
- Discord `/subscribe` reuses Moon's shared follow store, so Moon and Discord notifications stay aligned instead of
  creating parallel subscription data.
- Portal now sends one Discord DM when a request-linked Raven download completes for a requester with a Discord id,
  reusing the same title art and Moon links the rest of the stack exposes.
- Vault is the only supported broker to the shared MySQL database.
- Sage is the supported internal HTTP hop between first-party services. Direct internal exceptions are limited to
  Vault -> MySQL, Warden -> Docker or host runtime, Oracle -> OpenAI or LocalAI, and Raven -> external source,
  metadata, or VPN providers.
- Warden owns one shared internal Docker network named `scriptarr-network`. Moon is the only first-party service
  exposed publicly by default.
- Warden is not published publicly by default outside the test stack. Admins should talk to the stack through Moon
  unless they are debugging from inside the managed Docker network.
- LocalAI is optional for overall stack health and is not installed on first boot.
- Oracle starts disabled and OpenAI-first. LocalAI is enabled later from Moon admin when the admin is ready for a slow
  install or start cycle.
- Warden-managed LocalAI presets now use the LocalAI AIO image family and only report startup success once the LocalAI
  runtime is actually ready. Warden now starts those AIO images with the Oracle-safe text-generation preload set
  instead of the full bundled model list so first startup does not get stuck on optional speech or media models.
- Raven VPN should fail closed when VPN-backed downloads are enabled and the tunnel cannot be established.
- Raven should only report download completion after promote plus catalog persistence succeed, and it now rescans the
  `downloaded/<type>/...` tree on boot to recover missing catalog records from finished files.
- Moon admin stays dark by default, serves versioned browser assets, and exposes the managed-service updates flow for
  Vault, Sage, Moon, Raven, Portal, and Oracle.
- Moon's user app is now installable as a PWA, keeps HTML uncached, and uses a rolling recent-chapter reader cache on
  the current device instead of bulk offline sync.
- Moon also serves a trusted public automation API under `/api/public/*`. Search is public, writes use
  `X-Scriptarr-Api-Key`, Swagger lives at `/api/public/docs`, and external requests are guarded against NSFW, duplicate
  library entries, and already-active downloads before being queued at the lowest priority.

## Docs

- [ServerAdmin.md](ServerAdmin.md)
- [AGENTS.md](AGENTS.md)
- [AI docs index](docs/agents/README.md)
