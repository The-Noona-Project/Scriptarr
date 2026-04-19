# Raven Agent Guide

Read this before editing `services/raven`.

## Role

Raven is Scriptarr's Java download, library, metadata, and VPN-aware download engine.

## Hard Rules

- Keep Raven Java-first.
- Keep Raven on the Spring Boot and Java 24 path.
- Organize downloader, library, metadata, and provider responsibilities into clear modules.
- Raven replaces Komf; do not add Komf or Kavita coupling back in.
- Keep Raven's durable catalog and download task state behind Vault instead of reintroducing local-only or Komf-owned
  storage.
- Old Noona Raven and Komf code are reference material only. Port behavior intentionally, but do not restore Selenium
  or browser-driven scraping.
- Manual metadata overrides are admin-visible contracts and should stay documented.
- Keep full JavaDoc on Raven main and test Java sources. `gradlew check` is the expected enforcement path.
