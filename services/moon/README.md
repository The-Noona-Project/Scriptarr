# Moon

Moon serves Scriptarr's native user app at `/` and the admin app at `/admin`.
The user app is now installable as a same-origin PWA with a rolling recent-chapter cache for reader pages.

The admin side now owns Raven VPN settings, Raven metadata provider order, and Oracle or LocalAI configuration while
still proxying everything through Sage instead of sending the browser directly to internal services.
Moon admin also owns the Raven download-provider settings so admins can decide which site-specific Raven scrapers are
enabled as more providers land later.
Moon admin now also includes a dedicated Discord page at `/admin/discord` for guild workflow settings, slash-command
role gates, onboarding template or channel management, and Portal runtime visibility without exposing Discord
credentials in the browser.
That Discord page now distinguishes connected command runtime, command-sync health, onboarding capability, and the last
meaningful Portal runtime error instead of collapsing everything into one disconnected status.

Moon 3.0 also includes a native reader flow with:

- browse and library routes at `/browse` and `/library`
- typed library routes at `/library/<type>`
- typed series detail routes at `/title/<type>/<titleId>`
- a typed native reader at `/reader/<type>/<titleId>/<chapterId>`
- request and following views at `/myrequests` and `/following`

Moon still accepts the older untyped title and reader URLs as backward-compatible shims, but the typed paths above are
the canonical links emitted by the user app.
Moon's request and admin add-title flows now share the same metadata-first intake engine. Users search once, pick a
concrete match, and Scriptarr saves the selected metadata plus download snapshot with the request so moderation can
queue the exact Raven target later. Admin add-title uses the same intake results and queues immediately when a
download-ready match exists.

Admin routes follow the Arr-style operations model, including library, add/import, calendar, activity, wanted,
requests, users, Discord, settings, and system sections under `/admin`.

Fresh installs intentionally show empty library states until Raven has real imported titles to surface, and the admin
program now ships in a dark-only theme by default.

Moon no longer exposes a dev-session claim path. Discord login is the supported first-owner and admin sign-in flow, and
Moon serves versioned CSS or JS asset URLs with `no-store` HTML responses so new publishes invalidate stale browser
bundles automatically.
Moon admin also owns the brokered `moon.branding` setting so admins can rename the site in headers, document titles,
and install metadata without changing the underlying Scriptarr service names.
The signed-in admin shell now also uses the Discord-backed user avatar when one is available, with an initials fallback
so the top-right identity surface stays readable even without profile art.
Moon admin also owns the trusted public API settings at `/admin/system/api`, including enable state, admin key
rotation, and links to the same-origin Swagger docs and raw OpenAPI payload.

Moon now serves the public automation API under `/api/public/*`:

- `GET /api/public/docs`
- `GET /api/public/openapi.json`
- `GET /api/public/v1/search?q=...`
- `POST /api/public/v1/requests`
- `GET /api/public/v1/requests/<requestId>`

Search stays public. Write and polling calls require `X-Scriptarr-Api-Key`, and the external API rejects NSFW titles,
already-imported titles, already-active requests or downloads, and results without an enabled download target before
queueing the surviving request at the lowest priority.

Moon now treats title art as first-class metadata too. Cover images from Raven intake and library state are rendered in
admin Add Title, requests, queue or history, and library surfaces as well as the user browse and title views.
