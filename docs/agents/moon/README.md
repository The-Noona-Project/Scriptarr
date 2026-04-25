# Moon AI Notes

- Moon contains two distinct programs in one runtime: the user app and the admin app.
- User-facing library and reader flows live at `/`.
- Admin moderation, health, metadata, and settings flows live at `/admin`.
- Keep Raven VPN, Raven metadata, and Oracle or LocalAI controls behind Moon-owned admin routes.
- Keep the Raven provider settings honest: WeebCentral first by default, MangaDex as a normal fallback download
  provider, Anime-Planet as a scrape-based metadata provider ahead of MangaUpdates, and the owner-only Discord
  `downloadall` command described as intentionally WeebCentral-only.
- Keep Moon branding behind the admin settings flow. `moon.branding.siteName` is the brokered source of truth for user
  and admin headers, document titles, and PWA install metadata.
- Moon source files should carry full JSDoc across exported functions, route modules, SPA controllers, and important internal helpers.
- Prefer small route and page modules over giant `app.js` files. Break files up before they become hard to reason about.
- The supported admin route families are:
  - `/admin/library`
  - `/admin/add`
  - `/admin/import`
  - `/admin/calendar`
  - `/admin/mediamanagement`
  - `/admin/activity/*`
  - `/admin/wanted/*`
  - `/admin/requests`
  - `/admin/users`
  - `/admin/settings`
  - `/admin/system/*`
- The supported user route families are:
  - `/`
  - `/browse`
  - `/library/:type`
  - `/title/:type/:titleId`
  - `/reader/:type/:titleId/:chapterId`
  - `/myrequests`
  - `/following`
  - `/profile`
- The old untyped `/title/:id` and `/reader/:titleId/:chapterId` paths are compatibility shims only. New Moon links
  should emit the typed canonical paths.
- Moon stays responsible for browser-safe proxying into Sage. Browsers should not call Raven, Warden, Vault, Portal, or Oracle directly.
- Keep user requests and admin add-title on the shared intake engine. Moon should submit `query` plus
  `selectedMetadata` for requester flows, and only include `selectedDownload` on admin approval or admin add flows
  instead of regressing to free-text-only request payloads.
- `/myrequests` is now the only web request-creation surface. Keep the inline wizard metadata-first, keep the lower
  list tabbed into `Active`, `Completed`, and `Closed`, and only allow requester note edits or cancel actions while
  the request is still active.
- Duplicate request blockers should not create second visible rows in Moon. Show the duplicate outcome, link directly
  to the title when it already exists, and let Sage or Portal own the hidden waitlist and later ready notifications.
- Moon should show honest empty states when Raven has no imported titles, and `/admin` should stay dark by default.
- Keep Discord login as the only bootstrap and admin sign-in path. Do not reintroduce claim-dev-session behavior.
- Keep HTML responses uncached and static admin or user assets versioned so publishes invalidate the browser cache
  without relying on manual hard refreshes.
- Keep the user app installable. `manifest.webmanifest` and `/service-worker.js` are Moon-owned routes, and the
  service worker should cache the app shell plus only a small rolling set of recent reader chapters.
- The user app now runs as an embedded Next.js App Router program. Preserve the existing public Moon routes and
  same-origin APIs while keeping the Once UI shell, single-row megamenu navigation, minimal avatar dropdown,
  `/profile` route for StylePanel or install actions, and simple footer inside Moon's runtime instead of bypassing
  Moon. The old `apps/user` plain-JS shell is gone, so new user-surface work should stay inside `apps/user-next`.
- The user home route should stay cover-led and shelf-based, not hero-heavy. Favor a personalized "Your Bookshelf"
  continue-reading scroller first, then recent-by-type shelves and tag-driven shelves built from explicit tag
  likes/dislikes plus inferred taste from read history, follows, and the active bookshelf.
- Bookshelf membership is no longer derived from `media_progress` alone. Moon should treat title/chapter read state as
  the source of truth for started vs completed bookshelf behavior while still keeping progress rows for the active
  reading position.
- Title pages should keep the explicit reader actions visible: mark title read, mark title unread, mark chapter read,
  mark chapter unread, and per-tag `Like`, `Hide`, or `Clear` actions.
- Reader preferences are now centered on the new immersive reader. Seamless infinite scroll is the default mode,
  fit-width paged mode is the secondary option, and progress, bookmarks, and typed route syncing should keep working
  even as the shell evolves.
- `/admin/system/updates` is an actionable Moon surface that checks or starts managed-service update jobs through Sage.
- `/admin/system` also owns the root-only content reset maintenance flow. Keep it two-step, confirmation-gated,
  same-origin, and honest about what will be deleted: content-side requests, progress, read state, follows, bookmarks,
  Raven catalog state, Raven task state, and managed Raven download folders only.
- `/admin/discord` should surface Portal capability state honestly: command runtime, command sync, onboarding
  availability, and the last meaningful runtime error should all be visible without forcing the admin to read logs.
- `/admin/library` should stay dense and operational, closer to Sonarr's series index than to a marketing gallery.
  Favor sortable status, release, coverage, and path information over oversized cards.
- `/admin/library/:type/:titleId` is the admin drill-down companion to that dense index. Keep it operational and
  Sonarr-inspired: hero summary up top, then requests, Raven task state, and chapter-level release or archive detail
  below instead of a reader-style consumer layout.
- That admin title drill-down now also owns the source-repair UX. Keep alternate concrete provider targets, coverage
  previews, warning chips, and the safe replacement queue action behind Moon -> Sage -> Raven instead of bypassing the
  broker or exposing destructive delete-first flows in the browser.
- `/admin/mediamanagement` is the dedicated Raven naming surface. Keep one fallback naming profile plus per-type
  profiles for manga, manhwa, manhua, webtoon, comic, and OEL in sync with the brokered `raven.naming` payload.
- `/admin/calendar` should consume real release entries, not just task history. Prefer chapter release dates captured
  from Raven's provider scrapes plus metadata enrichment and present them in a calendar-first operational view.
- `/admin/requests` should surface the saved metadata, metadata-site links, merged tags, linked Raven task state, and
  the resolve path for `unavailable` requests instead of assuming every request is immediately approvable.
- `/admin/requests` now also owns the source-pick and override path for requester metadata picks. Moderators can
  replace metadata or download selections before they approve or resolve the request.
- `/admin/users` now owns the group-based access model. Keep the protected owner visible but read-only, keep one
  required default onboarding group, and treat group assignment as the way to make moderators or other admins instead
  of reviving flat role toggles.
- Moon's shared admin event feeds now come from `/api/moon-v3/admin/events` and `/api/moon-v3/admin/events/stream`.
  Those routes are same-origin, Sage-backed, and domain-scoped, so pages such as `/admin/users` and `/admin/requests`
  can subscribe with their own route-family grants instead of requiring blanket system access.
- Keep the brokered `Auto approve and download` setting in Moon admin aligned with Sage's high-confidence-only
  behavior. Moon should present it as an optimization toggle, not as a promise that every request will skip review.
- `/admin/system/api` is the admin control point for Moon's trusted public API. Keep the docs and key-management
  surfaces same-origin, Sage-backed, and free of direct internal service calls.
- `/api/public/*` should keep returning `coverUrl`, selection tokens, and the external guardrail metadata that trusted
  automations need to avoid NSFW, duplicate, or already-active downloads.
- The signed-in Moon shell should prefer the Discord-backed `avatarUrl` when it exists and fall back to initials
  instead of leaving the admin identity surface text-only.
