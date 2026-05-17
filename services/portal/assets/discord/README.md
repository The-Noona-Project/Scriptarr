# Discord Bot Avatars

These 512px PNGs are bundled defaults for Scriptarr-managed Discord bot identities:

- `noona-avatar.png`: the public Noona AI persona.
- `appa-avatar.png`: Appa, the admin and reviewer bot identity used by Portal and Noona visual context.

Portal uploads the configured default only when Discord reports that the bot has no custom avatar, unless
`SCRIPTARR_DISCORD_AVATAR_MODE=force` is set for a deliberate refresh. Keep these files small because they are loaded
inside the Portal runtime image and sent to Discord's user-avatar endpoint.
