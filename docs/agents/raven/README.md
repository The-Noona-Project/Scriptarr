# Raven AI Notes

- Raven stays Java-first and now runs on Spring Boot with a Java 24 toolchain.
- Raven owns downloader, library, metadata, PIA/OpenVPN download support, and provider orchestration.
- Launch defaults keep MangaDex enabled first, with AniList and ComicVine available but off by default.
- Keep full JavaDoc on Raven main and test Java sources and let `gradlew check` fail when doc coverage regresses.
- Fresh installs must not reintroduce demo titles; Raven's default library state is empty until real ingest exists.
