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
