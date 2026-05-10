# Moon AI Notes

- Moon contains two distinct programs in one runtime: the user app and the admin app.
- User-facing library and reader flows live at `/`.
- Admin moderation, health, metadata, and settings flows live at `/admin`.
- Keep Raven VPN, Raven metadata, and Oracle or LocalAI controls behind Moon-owned admin routes.
- Keep the Raven provider settings honest: WeebCentral first by default, MangaDex as a normal fallback download
  provider, Anime-Planet as a scrape-based metadata provider ahead of MangaUpdates, and the owner-only Discord
  `downloadall` command described as intentionally WeebCentral-only.
- Keep Moon branding behind the admin settings flow. `moon.branding.siteName` plus the optional uploaded WebP logo
  variants are the brokered source of truth for user and admin headers, document titles, and PWA install metadata.
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
  - `/admin/settings/database`
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
- Preserve same-origin login return flow. Moon should pass a sanitized `returnTo` path into Sage's Discord auth URL,
  and the callback relay should send users back to the page where login started whenever that route is still allowed,
  falling back to `/` otherwise.
- Keep HTML responses uncached and static admin or user assets versioned so publishes invalidate the browser cache
  without relying on manual hard refreshes.
- User and admin chrome should start from `/api/moon/chrome/bootstrap?returnTo=...`, which returns branding, auth,
  user identity, and first-owner bootstrap status in one Moon-owned response. Do not include a Discord OAuth URL in
  that payload; fetch the existing login URL endpoint only when a signed-out screen needs to render a sign-in action.
- Keep the user app installable. `manifest.webmanifest` and `/service-worker.js` are Moon-owned routes, and the
  service worker should cache the app shell plus only a small rolling set of recent reader chapters.
- The user app now runs as an embedded Next.js App Router program. Preserve the existing public Moon routes and
  same-origin APIs while keeping the lightweight local shell primitives, single-row megamenu navigation, compact
  avatar dropdown, `/profile` route for the lazy StylePanel bridge or install actions, and simple footer inside
  Moon's runtime instead of bypassing Moon. The old `apps/user` plain-JS shell is gone, so new user-surface work
  should stay inside `apps/user-next`. Keep root `@once-ui-system/core` JS imports out of always-mounted user/admin
  shell files; the profile-only StylePanel bridge is the exception and should stay lazy.
- The admin app now also runs through embedded Next at `apps/admin-next` for all `/admin` routes. The old plain-JS
  `apps/admin` fallback and `/admin-assets` route are gone, so new admin work should stay in `apps/admin-next` and
  continue using Moon same-origin APIs rather than direct internal service calls.
- Keep the avatar dropdown intentionally small and anchored to the avatar trigger. It should only surface `Profile`,
  conditional `Admin`, and `Logout`, and it should close on outside click, Escape, and route changes.
- `/profile` is now a tabbed account hub. Keep `Overview`, `Stats`, and `Preferences` fed from the dedicated
  `/api/moon-v3/user/profile` payload instead of reintroducing a fan-out of unrelated browser calls.
- The user home route should stay cover-led and shelf-based, not hero-heavy. Favor a personalized "Your Bookshelf"
  continue-reading scroller first, then recent-by-type shelves and tag-driven shelves built from explicit tag
  likes/dislikes plus inferred taste from read history, follows, and the active bookshelf.
- Browse and library shelves should use `/api/moon-v3/user/library?view=card` with server-side filtering and pagination
  instead of pulling full title details. Full title detail and reader routes are still the only places that should load
  chapter arrays. Home shelves should stay bounded to compact card reads and hydrate full titles only for exact
  continue-reading, read-state, or following ids. Use the compact exact-id card projection (`view=card&ids=...`) for
  those activity ids instead of fanning out into individual full title requests.
- For the next Moon speed pass, build a fresh timing table before editing. Watch document load, Next JS/CSS chunk size,
  chrome/session/bootstrap calls, main route payload, admin event-stream startup, image or cover-cache work, and
  downstream Sage/Raven/Vault latency separately so the fix targets the real bottleneck.
- Use `services/moon/scripts/report-bundles.mjs` for bundle reports and keep admin route chunks dynamically loaded
  after auth/grant checks. If bundle size is still high, remove always-mounted shell dependencies before trimming leaf
  page code that is already lazy.
- Cover cards should prefer Moon's derived `coverThumbUrl` WebP cache when Sage provides one. The cache is derived
  storage only: Moon fetches Sage-approved cover URLs, converts them with `sharp`, stores WebP files under the Moon
  cover-cache folder, and exposes a rerunnable `Optimize cover images` admin task.
- Bookshelf membership is no longer derived from `media_progress` alone. Moon should treat title/chapter read state as
  the source of truth for started vs completed bookshelf behavior while still keeping progress rows for the active
  reading position.
- Title pages should keep the explicit reader actions visible: mark title read, mark title unread, mark chapter read,
  mark chapter unread, and per-tag `Like`, `Hide`, or `Clear` actions.
- Reader preferences are now centered on the new immersive reader. Seamless infinite scroll is the default mode,
  fit-width paged mode is the secondary option, and progress, bookmarks, and typed route syncing should keep working
  even as the shell evolves.
- `/admin/system/logs`, `/admin/system/events`, and `/admin/system/updates` are purpose-built Next pages, not generic
  record-card fallbacks. Keep their refreshes background-only so filters, drawers, and confirmation fields do not
  flash or reset.
- `/admin/system/logs` must only read allowlisted, server-redacted Docker log tails through Moon -> Sage -> Warden.
  Never add browser-direct Docker, Warden, or raw secret log access.
- `/admin/system/events` should use Vault's durable event log with brokered filters and a detail drawer. Preserve the
  selected event and filters during SSE refreshes.
- `/admin/system/updates` is an actionable Moon surface that checks or starts managed-service update jobs through Sage.
  Viewing requires `system.read`; check/install actions require `system.root` plus the typed confirmation
  `UPDATE SCRIPTARR`.
- `/admin/system/tasks` is the scheduler surface for Sage-owned maintenance jobs. Keep it Radarr-style and dense:
  enabled state, free cron expression, timezone, next-run preview, manual run, last-run status, and recent history.
  Refresh quietly so cron drafts and focused controls are never wiped by SSE.
- `/admin/system/status` is the grouped endpoint matrix. Initial load should use Sage's lightweight registry/status
  payload; only the explicit check action should call the expensive live GET probes. Show auth-gated reads as
  protected and keep mutation endpoints visible but clearly marked as not probed. Warden bootstrap and runtime details
  belong in `/api/moon-v3/admin/system/status/runtime`, hydrated after the matrix paints.
- `/admin/settings` is the general Settings hub. Keep branding, logo upload or remove, database summary, credits,
  support links, toast notification preferences, Raven VPN, metadata providers, download providers, Raven download
  runtime, request workflow, and Discord basics there. Do not drift AI controls back into this page. Keep section
  drafts protected from background refreshes while dirty, and use the explicit Moon v3 settings save routes for
  Settings-owned forms. The Raven active title-download field should be numeric, constrained to `1` through `6`, and
  should surface a saved-but-not-live warning if Raven reload fails. Show Raven VPN runtime capability, settings
  freshness, `armed / idle`, and protected state from the secondary `/api/moon-v3/admin/settings/runtime` payload
  instead of blocking the saved settings response on Raven, Vault overview, or Portal runtime work. The Settings VPN
  test button must call Moon -> Sage -> Raven rather than reaching around the browser-safe broker path.
- `/admin/settings/database` is a hidden-from-nav full page opened only from Settings. Keep it Moon -> Sage -> Vault,
  require database grants through the route model, show redacted/paginated rows, and allow editing only the validated
  settings JSON path the broker exposes.
- Use the shared `AdminToastProvider` for admin action results, async jobs, and live SSE events. Page-local toast
  stacks should only be introduced for isolated surfaces that cannot sit under the admin provider.
- Admin SSE should be shared through the provider. Pages register event domains and stale callbacks instead of opening
  their own `EventSource` connections.
- `/admin/system/ai` is the dedicated Oracle, LocalAI, and AI tooling page. Keep provider, provider-specific model
  dropdown, temperature, masked key state, LocalAI profile/image controls, manual install/start/remove actions,
  lifecycle progress, health/status, completion toasts, test prompt, tool toggles, assistant prompts, and confirmable
  proposals here instead of drifting those controls back into the main Settings page. Model options must come through
  Moon -> Sage -> Oracle, not browser-direct provider calls.
- `/admin/system` also owns the root-only content reset maintenance flow. Keep it two-step, confirmation-gated,
  same-origin, and honest about what will be deleted: content-side requests, progress, read state, follows, bookmarks,
  Raven catalog state, Raven task state, and managed Raven download folders only.
- `/admin/discord` should surface Portal capability state honestly: command runtime, command sync, onboarding
  availability, release notification channel id, Noona trivia channel/scoring/schedule settings, and the last
  meaningful runtime error should all be visible without forcing the admin to read logs.
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
  from Raven's provider scrapes plus metadata enrichment, add one completion marker for finished titles with fallback
  dates, and keep undated completed titles visible in the summary instead of dropping them silently.
- `/admin/requests` should surface the saved metadata, metadata-site links, merged tags, linked Raven task state, and
  the resolve path for `unavailable` requests instead of assuming every request is immediately approvable.
- `/admin/requests` now also owns the source-pick and override path for requester metadata picks. Moderators can
  replace metadata or download selections before they approve or resolve the request. The page is a moderation inbox,
  not a raw table: default to Needs review, keep active request edits stable across SSE refreshes, and require a
  moderator comment before calling the deny route. Bulk actions are limited to refresh-source and deny; approvals stay
  per request so staff make one source decision at a time.
- Request drawer state should reset only when the selected request id or revision changes. Use the locally selected
  metadata/source when computing approve and resolve button state, auto-select a single concrete candidate for review,
  and pass `expectedRevision` on admin mutations so stale actions surface clean 409 conflicts.
- `/admin/wanted/metadata` is the canonical metadata repair surface. Keep `/admin/wanted/metadata-gaps` as a redirect
  only, search provider matches through Sage with the library id, and apply selected matches through Raven identify.
- `/admin/wanted/missing-content` is the coverage and quality repair surface. Keep `/admin/wanted/missing-chapters`
  as a redirect only, show missing chapters, possible missing pages, damaged chapters, and bad-source summaries, and
  keep repair candidates plus staged replacement queueing brokered through the existing library repair routes instead
  of adding browser-direct Raven calls.
- `/admin/users` now owns the group-based access model. Keep the protected owner visible but read-only, keep one
  required default onboarding group, and treat group assignment as the way to make moderators or other admins instead
  of reviving flat role toggles. Use the domains payload as the source of truth for the grant matrix.
- `/admin/activity/queue` is now the live Raven queue board. Keep it card-based, split into `Running`, `Queued`, and
  `Needs attention`, subscribe through the shared admin SSE stream, and re-fetch the queue payload on relevant events
  instead of trying to hand-reconcile every raw event in the browser.
- Keep `Needs attention` recovery-only. Do not let unrelated admin or system events such as service restarts leak into
  that section.
- Preserve the interaction lock around queue controls so SSE refreshes do not collapse the priority select or destroy
  in-progress edits. Apply one trailing refresh after the control blurs or the action completes.
- Queue controls belong on the cards. `activity.write` can retry, remove failed or stale queued work, cancel all
  queued work, remove all removable recovery items, reprioritize, and reorder queued work, while `activity.root` is
  required to cancel running tasks or bulk-cancel all running work.
- Queued cards should not show ETAs. Running cards can show download speed and active ETA only when Sage or Raven
  supplies credible values. Do not invent fake transfer rates or fake timing in the browser.
- Queue active-slot totals should use the configured Raven title-download limit from Sage, while the queue page itself
  stays display-only for that setting.
- Moon's shared admin event feeds now come from `/api/moon-v3/admin/events` and `/api/moon-v3/admin/events/stream`.
  Those routes are same-origin, Sage-backed, and domain-scoped, so pages such as `/admin/users` and `/admin/requests`
  can subscribe with their own route-family grants instead of requiring blanket system access.
- Keep the brokered `Auto approve and download` setting in Moon admin aligned with Sage's high-confidence-only
  behavior. Moon should present it as an optimization toggle, not as a promise that every request will skip review.
- `/admin/system/api` is the admin control point for Moon API keys. Keep system-key CRUD, permission-group assignment,
  user-key audit, and Swagger/OpenAPI links same-origin, Sage-backed, and free of direct internal service calls.
- `/profile` owns user-level API key creation and revocation for signed-in readers. Keep those keys account-scoped and
  focused on reader sync rather than admin access.
- `/api/public/*` should keep returning `coverUrl`, selection tokens, and the external guardrail metadata that trusted
  automations need to avoid NSFW, duplicate, or already-active downloads.
- The signed-in Moon shell should prefer the Discord-backed `avatarUrl` when it exists and fall back to initials
  instead of leaving the admin identity surface text-only.
