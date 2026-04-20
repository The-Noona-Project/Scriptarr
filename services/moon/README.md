# Moon

Moon serves Scriptarr's native user app at `/` and the admin app at `/admin`.
The user app is now installable as a same-origin PWA with a rolling recent-chapter cache for reader pages.

The admin side now owns Raven VPN settings, Raven metadata provider order, and Oracle or LocalAI configuration while
still proxying everything through Sage instead of sending the browser directly to internal services.

Moon 3.0 also includes a native reader flow with:

- browse and library routes at `/browse` and `/library`
- typed library routes at `/library/<type>`
- typed series detail routes at `/title/<type>/<titleId>`
- a typed native reader at `/reader/<type>/<titleId>/<chapterId>`
- request and following views at `/myrequests` and `/following`

Moon still accepts the older untyped title and reader URLs as backward-compatible shims, but the typed paths above are
the canonical links emitted by the user app.

Admin routes follow the Arr-style operations model, including library, add/import, calendar, activity, wanted,
requests, users, settings, and system sections under `/admin`.

Fresh installs intentionally show empty library states until Raven has real imported titles to surface, and the admin
program now ships in a dark-only theme by default.

Moon no longer exposes a dev-session claim path. Discord login is the supported first-owner and admin sign-in flow, and
Moon serves versioned CSS or JS asset URLs with `no-store` HTML responses so new publishes invalidate stale browser
bundles automatically.
Moon admin also owns the brokered `moon.branding` setting so admins can rename the site in headers, document titles,
and install metadata without changing the underlying Scriptarr service names.
