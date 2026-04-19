# Raven Agent Guide

Read this before editing `services/raven`.

## Role

Raven is Scriptarr's Java download, library, metadata, and VPN-aware download engine.

## Hard Rules

- Keep Raven Java-first.
- Keep Raven on the Spring Boot and Java 24 path.
- Organize downloader, library, metadata, and provider responsibilities into clear modules.
- Raven replaces Komf; do not add Komf or Kavita coupling back in.
- Manual metadata overrides are admin-visible contracts and should stay documented.
