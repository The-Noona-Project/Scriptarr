# Moon AI Notes

- Moon contains two distinct programs in one runtime: the user app and the admin app.
- User-facing library and reader flows live at `/`.
- Admin moderation, health, metadata, and settings flows live at `/admin`.
- Keep Raven VPN, Raven metadata, and Oracle or LocalAI controls behind Moon-owned admin routes.
- Keep Moon branding behind the admin settings flow. `moon.branding.siteName` is the brokered source of truth for user
  and admin headers, document titles, and PWA install metadata.
- Moon source files should carry full JSDoc across exported functions, route modules, SPA controllers, and important internal helpers.
- Prefer small route and page modules over giant `app.js` files. Break files up before they become hard to reason about.
- The supported admin route families are:
  - `/admin/library`
  - `/admin/add`
  - `/admin/import`
  - `/admin/calendar`
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
- The old untyped `/title/:id` and `/reader/:titleId/:chapterId` paths are compatibility shims only. New Moon links
  should emit the typed canonical paths.
- Moon stays responsible for browser-safe proxying into Sage. Browsers should not call Raven, Warden, Vault, Portal, or Oracle directly.
- Moon should show honest empty states when Raven has no imported titles, and `/admin` should stay dark by default.
- Keep Discord login as the only bootstrap and admin sign-in path. Do not reintroduce claim-dev-session behavior.
- Keep HTML responses uncached and static admin or user assets versioned so publishes invalidate the browser cache
  without relying on manual hard refreshes.
- Keep the user app installable. `manifest.webmanifest` and `/service-worker.js` are Moon-owned routes, and the
  service worker should cache the app shell plus only a small rolling set of recent reader chapters.
- Reader preferences are now type-aware. Webtoon defaults should stay vertical, other types should stay paged, and user
  overrides should not bleed across title types.
- `/admin/system/updates` is an actionable Moon surface that checks or starts managed-service update jobs through Sage.
