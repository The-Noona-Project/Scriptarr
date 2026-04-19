# Raven

Raven is Scriptarr's Spring Boot Java 24 download, library, and metadata engine.

It owns the built-in metadata stack that replaces Komf, keeps MangaDex enabled by default, and supports optional
PIA/OpenVPN-backed downloads using the simplified Moon admin VPN settings.

Fresh installs now expose an empty library instead of demo titles. Moon stays empty until Raven has real imported
titles to surface.

Raven now keeps its library titles, chapters, metadata matches, and download-task snapshots in Vault-backed storage so
downloads and imported archives survive container restarts. The current metadata set includes MangaDex, AniList,
MangaUpdates, optional MyAnimeList, and optional ComicVine.
