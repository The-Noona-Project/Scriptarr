# Raven

Raven is Scriptarr's Spring Boot Java 24 download, library, and metadata engine.

It owns the built-in metadata stack that replaces Komf, keeps MangaDex enabled by default, and supports optional
PIA/OpenVPN-backed downloads using the simplified Moon admin VPN settings.

Fresh installs now expose an empty library instead of demo titles. Moon stays empty until Raven has real imported
titles to surface.

Raven now reaches shared settings and durable catalog state through Sage's internal broker routes. Sage owns the
first-party hop to Vault, while Raven stays responsible for download execution, source scraping, provider calls, and
reader-ready library projection.

Completed downloads now use Raven's managed two-stage layout under the existing `/downloads` mount:

- `/downloads/downloading/<type-slug>/<title-folder>`
- `/downloads/downloaded/<type-slug>/<title-folder>`

Raven stores dynamic library type labels and slugs from the source when available, uses opaque durable title ids for
new catalog entries, and keeps route shapes stable for Moon. The current metadata set includes MangaDex, AniList,
MangaUpdates, optional MyAnimeList, and optional ComicVine, with provider matching filtered by the title's stored
library type.

Raven also supports a Sage-backed `raven.naming` setting for the safe subset of the old download naming schema:

- `chapterTemplate`
- `pageTemplate`
- `chapterPad`
- `pagePad`
- `volumePad`

Title-folder naming stays unchanged so rescans remain compatible with Raven's current durable catalog and managed
storage roots. Chapter archives default to Scriptarr-style `c001` naming with optional volume omission when no
volume data exists, and page names default to padded numeric files like `001.jpg`.

When Raven VPN is enabled through Moon admin, downloads now fail closed if Raven cannot safely load the settings,
resolve the requested PIA profile, or complete the OpenVPN handshake. Raven still uses the existing simplified
enable/region/credentials admin contract, but the runtime now refreshes stale PIA profiles, reconnects on region
changes, and uses short-lived credential files with `--auth-nocache`.
