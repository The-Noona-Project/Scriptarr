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
- Preserve Moon's native reader flows. Do not reintroduce Kavita runtime handoff behavior.
