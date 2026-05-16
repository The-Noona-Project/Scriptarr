# Moon Agent Guide

Read this before editing `services/moon`.

## Role

Moon serves the forward-facing user app at `/`, the dedicated reader app at `/reader`, and the admin app at `/admin`
from the same runtime.

## Hard Rules

- Preserve the same-origin split between the three Moon programs.
- Keep Moon's browser traffic behind Moon-owned API routes that proxy into Sage.
- The user app owns home, browse, library, title, requests, following, and profile surfaces.
- The reader app owns fullscreen `/reader/<type>/<titleId>/<chapterId>` reading.
- The admin app owns moderation, libraries, metadata repair, users, permissions, and service settings.
- Add full JSDoc to Moon JS modules, exported functions, route handlers, page controllers, and important helpers.
- Split Moon files before they grow into monoliths. If a file is approaching 2000 lines, break it into smaller modules when possible.
- Treat files nearing 4000 lines as overdue for decomposition unless they are generated or framework-constrained.
- Keep `/admin` aligned with Arr-style admin density and `/` aligned with Moon's native reading-first UX.
- Keep Discord login as Moon's only first-owner and admin sign-in path. Do not reintroduce dev-session claim flows.
- Keep Moon HTML uncacheable and its static CSS or JS assets versioned so publishes invalidate stale browser bundles cleanly.
- Keep normal reader-facing copy branded. The user app, reader app, PWA metadata, public fallback HTML, and public API
  labels should use the configured site name or neutral product wording instead of service codenames; keep codenames for
  admin diagnostics and internal code paths.
- For Moon speed work, measure before editing. Compare document and Next asset load, chrome/bootstrap requests, main
  route payloads, event-stream calls, and payload sizes for user home, browse/library, reader/title, admin settings,
  admin status, and admin queue or requests.
- Preserve the current performance shape: user card lists use compact projections, home shelves stay bounded, admin
  status starts lightweight, admin events share one provider stream, and admin routes should load leaf chunks only after
  auth/grant checks.
- Preserve Moon's native reader flows. Do not reintroduce Kavita runtime handoff behavior or browser-direct calls.
- Keep user requests and admin add-title on the shared metadata-first intake flow. Moon should submit `query`,
  `selectedMetadata`, and nullable `selectedDownload` instead of regressing to free-text-only request payloads.
- `/admin/requests` should keep showing the saved metadata or download snapshots, linked Raven job state, and the
  resolve path for `unavailable` requests.
- `/admin/wanted/missing-content` is the canonical Missing Content page for chapter gaps and Raven quality damage; keep
  `/admin/wanted/missing-chapters` as a redirect/alias only.
- `/admin/activity/queue` should keep section-safe bulk controls brokered through Moon -> Sage, including cancel all
  queued, root-only cancel all running, retry all recovery items, and remove all removable recovery items.
- Keep the trusted public Moon API behind Moon-owned routes. `/api/public/*` and `/admin/system/api` should stay
  browser-safe, same-origin, and Sage-backed instead of reaching into internal services directly.
- Keep `/admin/discord` as the browser-safe owner of Portal Discord settings, including release/update notification
  channels, Noona mention chat, Noona memory review/clear controls, Noona trivia configuration, and manual trivia
  runtime actions.
- Keep `/admin/system/ai` as the browser-safe owner of Oracle, LocalAI, and Sage-governed AI tool proposals. Browser
  code must never call Oracle, Warden, OpenAI, or LocalAI directly.
- Public request creation must keep using server-issued selection tokens and preserve the NSFW, already-in-library, and
  already-active guardrails before low-priority queueing.
- Keep cover art visible across add-title, requests, queue/history, and library/title surfaces when Raven provides a
  `coverUrl`.

## Coding Map

- User pages live in `apps/user-next/components/pages`; shared user shell, chrome, navigation, cards, and local UI
  primitives live beside them under `apps/user-next/components`.
- Reader pages live in `apps/reader-next`; it is a fullscreen app with its own loading/auth/error states and
  `/reader/_next` assets.
- Admin pages live in `apps/admin-next/components`; shared admin API helpers, access checks, routes, event streams, and
  formatting live in `apps/admin-next/lib`.
- Same-origin runtime and proxy routes live in `lib`. Moon should proxy or compose through Sage instead of teaching the
  browser about Sage, Vault, Raven, Warden, Portal, Oracle, OpenAI, or LocalAI URLs.
- Discord admin helpers live in `apps/admin-next/lib/adminDiscord.js` and `/admin/discord` UI in
  `apps/admin-next/components/DiscordPage.jsx`. Keep Noona mention-chat settings on the brokered
  `portal.discord.noonaChat` object, keep release/update channel ids under `portal.discord.notifications`, and clear
  memory through Moon -> Sage, never browser-direct Vault or Oracle calls.
- User/admin chrome should start from `/api/moon/chrome/bootstrap?returnTo=...`; fetch the Discord login URL only when
  a signed-out view needs a sign-in action.
- User card lists should call `/api/moon-v3/user/library?view=card`, including `ids=...` for exact activity cards.
  Title and reader pages are the places that may hydrate full title, manifest, chapter, preference, bookmark, and
  read-state payloads.
- Browse owns `q`, `type`, and `letter` in the URL. Update only the results chunk on search/filter changes, keep
  previous card data visible while a newer same-origin request is in flight, and rely on the server-side compact card
  path for filtering/pagination.
- Home, browse, library, and profile may use the user-next persistent JSON cache for signed-in return visits. Keep it
  browser-local, per-user, stale-while-revalidate, and limited to compact card/profile-preview payloads; never store
  card JSON in cookies or cache admin, API key, request mutation, title detail, or reader payloads there.
- Compact cards should use the merged `readerTarget` for cover/art links and the canonical title route for title/copy
  links. Use `CoverImage.jsx` for card artwork so broken remote covers fall back to a styled initial instead of a
  broken image glyph.
- Keep always-mounted user/admin shells on local primitives. Do not reintroduce root `@once-ui-system/core` JavaScript
  imports outside the lazy profile-only style panel bridge.
- Once UI `1.7.x` no longer installs every module helper as a transitive dependency. When refreshing Once UI, keep
  `compressorjs`, `prismjs`, and `recharts` resolution in mind and prove the profile route through
  `npm --workspace services/moon run build:user`.

## Performance Navigation

- User Next surfaces live under `apps/user-next`; reader Next surfaces live under `apps/reader-next`; admin Next
  surfaces live under `apps/admin-next`.
- Same-origin Moon API and proxy helpers live under `lib`, while Sage owns the actual Moon v3 payload assembly.
- Use `services/moon/scripts/report-bundles.mjs` when first-load JS/CSS size is part of the investigation.
- Use `services/moon/tests/adminFrontendPerformance.test.mjs`, `tests/settingsDraft.test.mjs`, and `tests/moonApp.test.mjs`
  for narrow Moon regression coverage, then build the relevant Next app.
- For cross-service speed fixes, run the narrow service tests first, then `npm run docker:healthcheck`.
- For UI route changes, build the touched app with `npm --workspace services/moon run build:user`,
  `npm --workspace services/moon run build:reader`, or `npm --workspace services/moon run build:admin`.
  For bundle work, build the touched apps before running
  `npm --workspace services/moon run bundle:report`.
