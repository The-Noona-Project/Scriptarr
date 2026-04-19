# Moon

Moon serves Scriptarr's native user app at `/` and the admin app at `/admin`.

The admin side now owns Raven VPN settings, Raven metadata provider order, and Oracle or LocalAI configuration while
still proxying everything through Sage instead of sending the browser directly to internal services.

Moon 3.0 also includes a native reader flow with:

- browse and library routes at `/browse` and `/library`
- series detail routes at `/title/<id>`
- a native reader at `/reader/<titleId>/<chapterId>`
- request and following views at `/myrequests` and `/following`

Admin routes follow the Arr-style operations model, including library, add/import, calendar, activity, wanted,
requests, users, settings, and system sections under `/admin`.
