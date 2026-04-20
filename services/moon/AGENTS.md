# Moon Agent Guide

Read this before editing `services/moon`.

## Role

Moon serves the forward-facing user app at `/` and the admin app at `/admin` from the same runtime.

## Hard Rules

- Preserve the same-origin split between the two Moon programs.
- Keep Moon's browser traffic behind Moon-owned API routes that proxy into Sage.
- The user app is the real library and reader surface.
- The admin app owns moderation, libraries, metadata repair, users, permissions, and service settings.
- Add full JSDoc to Moon JS modules, exported functions, route handlers, page controllers, and important helpers.
- Split Moon files before they grow into monoliths. If a file is approaching 2000 lines, break it into smaller modules when possible.
- Treat files nearing 4000 lines as overdue for decomposition unless they are generated or framework-constrained.
- Keep `/admin` aligned with Arr-style admin density and `/` aligned with Moon's native reading-first UX.
- Keep Discord login as Moon's only first-owner and admin sign-in path. Do not reintroduce dev-session claim flows.
- Keep Moon HTML uncacheable and its static CSS or JS assets versioned so publishes invalidate stale browser bundles cleanly.
- Preserve Moon's native reader flows. Do not reintroduce Kavita runtime handoff behavior.
- Keep user requests and admin add-title on the shared metadata-first intake flow. Moon should submit `query`,
  `selectedMetadata`, and nullable `selectedDownload` instead of regressing to free-text-only request payloads.
- `/admin/requests` should keep showing the saved metadata or download snapshots, linked Raven job state, and the
  resolve path for `unavailable` requests.
- Keep the trusted public Moon API behind Moon-owned routes. `/api/public/*` and `/admin/system/api` should stay
  browser-safe, same-origin, and Sage-backed instead of reaching into internal services directly.
- Public request creation must keep using server-issued selection tokens and preserve the NSFW, already-in-library, and
  already-active guardrails before low-priority queueing.
- Keep cover art visible across add-title, requests, queue/history, and library/title surfaces when Raven provides a
  `coverUrl`.
