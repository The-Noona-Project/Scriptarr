# Sage AI Notes

- Sage is the Moon-facing broker for auth, first-admin bootstrap, request moderation, status aggregation, and browser-safe
  orchestration.
- Keep Moon -> Sage -> internal services intact.
- Keep first-party service-to-service HTTP behind Sage's internal broker routes instead of allowing Portal, Oracle,
  Raven, or Warden to reach across the stack directly.
- Keep request intake centralized in Sage. Search should broker to Raven's intake search, requester flows should
  persist the selected metadata first, and moderation should queue the exact saved Raven target instead of rerunning a
  fuzzy search at approval time.
- Keep duplicate enforcement aligned with Vault's durable request work key so Moon, Discord, admin add-title, and the
  public API all reject the same concrete target even under concurrent submits.
- Moon and Portal now need explicit request-flow steps from Sage: metadata search, final requester creation, note
  edits, cancellation, admin-only download-option lookup, and admin overrides. Do not collapse that back into one
  opaque fuzzy endpoint.
- Keep duplicate blockers hidden-row only. Sage should attach duplicate users to the request waitlist in request
  details instead of creating a second visible record, and Portal should notify those users when the title is ready.
- `unavailable` requests are first-class Sage records. Keep the background 4-hour recheck loop, `sourceFoundAt` plus
  `sourceFoundOptions` detail fields, and the automatic 90-day expiry flow in sync with Portal's request DMs.
- Sage now brokers group-based admin access too. Keep canonical route-family grants in session payloads, preserve the
  temporary derived legacy permission array for compatibility, and use reusable permission groups instead of reviving
  direct role or flat-permission mutation flows for non-owner users.
- The admin access model includes a `database` domain. Owners may bypass it, but non-owner admins need explicit
  database grants before Sage should serve DB explorer payloads or settings-table edits.
- Sage now also brokers Moon's durable title/chapter read-state, reader preference, and tag-preference actions. Keep
  the user-facing Moon routes browser-safe, write durable read/progress state through Vault, and rebuild
  home/title/reader payloads from explicit tag preferences plus inferred taste from read history, follows, and the
  active bookshelf.
- User title pages now have a split broker contract. Keep the legacy full
  `/api/moon-v3/user/title/:titleId` route for compatibility, but new Moon UI should call
  `/summary` for hero/action data, `/chapters?cursor=&pageSize=&sort=&filter=&q=` for paged chapter rows with read
  state, and `/requests` only after the Requests tab opens. Summary and chapter routes should be Vault-backed instead
  of loading Raven's full title payload, and compact mutation responses (`view=compact` or `response=compact`) must
  return refreshed summary fields without `title.chapters`.
- `POST /api/moon-v3/user/title/:titleId/unread` is a reset-off-shelf action. It must clear title read state, chapter
  reads, title progress, and title bookmarks while preserving follows.
- `POST /api/moon-v3/user/title/:titleId/chapters/bulk-read-state` supports `read`, `unread`, and `reset`. Keep
  individual unread non-destructive; selected reset is the bookmark/progress-clearing action.
- Keep `/api/moon-v3/user/profile` as the dedicated aggregate payload for Moon's tabbed `/profile` route. That
  response should stay focused on trusted identity, bookshelf/completion stats, request counts, and recent activity
  instead of forcing the browser to stitch several unrelated APIs together.
- Home and profile activity cards should use Raven's compact exact-id card projection through Sage rather than
  fanning out into full title reads. Preserve the order requested by Moon when brokering `view=card&ids=...`.
- For browse/library/home cards, Sage should merge the bounded Vault reader-target projection into each compact title.
  The target should expose only the chapter id/type metadata Moon needs to build reader URLs, and should prefer saved
  progress, then next unread, then first readable chapter.
- Broker Moon's sanitized Discord auth `returnTo` path through OAuth `state`, and let Moon's callback relay enforce
  the final fallback to `/` when the remembered route is invalid or the signed-in user cannot access it.
- Moon's root-only content reset is Sage-owned orchestration. Keep the preview plus execute flow brokered, require the
  explicit confirmation string, append `content-reset-started` and `content-reset-completed` events, clear Vault's
  content-side state first, then trigger Raven's managed storage reset.
- `/api/moon-v3/admin/activity/queue` now feeds Moon's live queue board. Keep that payload grouped into `running`,
  `queued`, and `needsAttention` sections, and keep the cancel, retry, remove, priority, and move routes as Moon-safe
  wrappers around Raven task-control operations.
- Keep section bulk queue actions brokered here too: cancel all queued work for `activity.write`, cancel all running
  work for `activity.root`, and remove all removable recovery items without touching promoted library content.
- Keep `needsAttention` limited to retriable or stale Raven title-task recovery work, not generic admin events. The
  queue payload should surface removable flags for failed or stale queued tasks, never put ETA on queued cards, and
  only put speed or ETA on running cards when Raven provides credible data. Keep the brokered `retry-all` action for
  the retriable recovery set.
- Keep `sage.requests.autoApproveAndDownload` high-confidence only. Auto-pick one source only when Raven's confidence
  signals and warnings make that safe; otherwise leave the request in manual admin review.
- Persist Raven and Oracle admin settings through Vault instead of service-local files.
- Persist Moon branding and admin toast preferences through Vault settings too. Logo uploads should arrive from Moon
  already normalized into WebP variants, and Sage should expose public branding metadata without leaking stored image
  payloads except through the explicit public logo variant routes.
- Broker Portal's Discord workflow settings through the shared `portal.discord` setting, and keep Portal-facing broker
  routes for intake search, request creation, library search, follow updates, onboarding tests, release channel tests,
  update channel tests, and Raven durable downloadall runs.
- Broker public Noona mention chat through `/api/internal/portal/noona-chat`. Sage should own the capped
  `portal.noonaChat.memory` settings payload, natural memory commands, secret rejection, conservative read-context
  loading, latest posted GitHub update digest context, public proposal filtering, Oracle fallback, and admin-safe
  memory review/clear payloads. Portal must not call Oracle or Vault directly for this flow.
- Broker Appa admin mentions through `/api/internal/portal/appa-chat` with Appa persona context, admin read context,
  and conservative proposal drafting only. Appa must never execute mutations directly from Discord.
- Broker public Noona reply review through `/api/internal/portal/noona-review`. Store a redacted review event first,
  then let Portal record correction delivery success/failure through Sage only after Discord accepts or rejects the
  Appa message. Do not store full prompts, replies, transcripts, tokens, or secrets.
- Broker Appa Discord diagnostics through `/api/internal/portal/appa-discord-diagnostic`. Store only action metadata,
  channel/user ids, counts, status, and short redacted snippets; never persist full Discord transcripts or unredacted
  message content.
- Keep Noona/Appa appearance facts in `lib/noonaVisualIdentity.mjs`. Those descriptions are read-only Oracle context
  and deterministic degraded-mode replies, not durable user memory or transcript storage.
- Public mention chat proposals are stricter than `/admin/system/ai`: allow only low-risk status-check and trivia
  start/stop proposals, even when broader LocalAI, root/system, or destructive tools are enabled for admins.
- `portal.discord.trivia` is the source of truth for Noona trivia channels, scoring, hints, schedules, and AI
  borderline matching. Sage owns trivia round, guess, score, leaderboard, and ack state through Vault-backed settings.
  Keep active round and `nextRoundAfter` state precise enough for Portal to reconcile one runtime clock after reloads
  or repeated manual starts.
- Portal's Raven downloadall broker route requires an explicit `providerId`. Keep `downloadall` locked to the
  WeebCentral provider on the Sage side too so Portal cannot accidentally fall through to MangaDex when that owner-only
  DM command is used. Preserve the `nsfw` flag exactly as Portal sends it so Raven can enforce explicit
  WeebCentral `Adult Content: No` verification for `nsfw:false`, and pass through Raven's skipped-completed,
  skipped-current, appended, invalid-source, and quality summary counts.
- Persist and expose `raven.download.providers` through the same brokered settings path as Raven metadata and VPN
  configuration.
- Persist and expose brokered `raven.naming` settings, including the fallback naming profile plus the per-type naming
  profiles Moon now edits from `/admin/mediamanagement`.
- Sage also brokers Moon's trusted API-key auth. Keep system keys resolved through assigned permission groups, user keys
  resolved only to their owner with admin grants stripped, API keys hashed at rest, short-lived selection tokens for
  search results, and the lowest-priority queue stamp for accepted external requests.
- Keep Warden status aggregation split by endpoint contract instead of flattening bootstrap and runtime payloads
  together.
- Keep full JSDoc on exported Sage `.mjs` source and tests so the ESLint doc gate stays green.
- Legacy `/api/library` behavior must mirror Raven's real-or-empty library state instead of injecting scaffold titles.
- Moon admin calendar now depends on richer Raven chapter and title timestamps. Keep
  `/api/moon-v3/admin/calendar` focused on dated chapter releases plus one completed-title marker per finished title
  when fallback dates exist, and return an undated completed count when no safe date is available.
- `/api/moon-v3/admin/library/:titleId` is now the brokered admin drill-down payload for Moon's Sonarr-style title
  detail route. Keep it rich enough to combine title lifecycle status, related requests, active or recent Raven tasks,
  and chapter-level release or archive fields without forcing Moon to fan out into multiple browser calls.
- Sage now also brokers admin title repair APIs. Keep `/api/moon-v3/admin/library/:titleId/repair-options` and
  `/api/moon-v3/admin/library/:titleId/replace-source` as thin Moon-safe wrappers around Raven's concrete provider
  repair flow instead of leaking Raven directly into the browser.
- Sage now owns the shared admin event read path too. Keep `/api/moon-v3/admin/events` and
  `/api/moon-v3/admin/events/stream` same-origin and Moon-safe, authorize them by the requested event domains, and use
  internal broker routes plus Vault's durable event log instead of ad hoc page-specific aggregations.
- Sage owns the Settings DB explorer broker at `/api/moon-v3/admin/settings/database`. Keep overview, table browsing,
  and settings-row edits behind database grants, route all data through Vault, redact sensitive values, and never add
  arbitrary SQL endpoints.
- Sage owns the admin toast settings broker. Global defaults require `settings.root`; personal overrides must be scoped
  to the signed-in admin's Discord user id. The toast-only read endpoint returns just `{global, personal, effective,
  canEditGlobal}` so Moon admin does not need the full Settings aggregate on startup.
- Sage owns the explicit v3 Settings save routes for Raven metadata providers, Raven download providers, Raven
  download runtime, and Portal Discord basics. Preserve legacy routes during migration, but keep new Moon Settings
  forms on the v3 save surface.
- `raven.download.runtime` stores Raven's active title-download limit. Validate `activeTitleDownloads` as an integer
  from `1` through `6`, persist through Vault, append a settings event, then call Raven's runtime reload route. A reload
  failure should not roll back the saved value; return a warning so Moon can show that it applies after restart.
- Keep the main Settings aggregate fast and saved-state focused. Raven VPN runtime fields (`runtimeCapable`,
  `settingsFresh`, `state`, `protected`, and `lastError`), database overview, and Portal Discord runtime belong in
  `/api/moon-v3/admin/settings/runtime`, with database overview returning `null` when the admin lacks database read
  access. Broker the admin VPN test through the v3 Settings surface and never expose PIA secrets in the response.
- Sage owns admin request summary counts and the request deny mutation. Deny requires `requests.write`, rejects blank
  comments, stores the moderator comment and timeline entry, appends a durable request event, and leaves notification
  delivery to the existing requester-notification flow.
- Admin request summaries must expose `revision`, and approve, deny, override, resolve, and refresh-source mutations
  should accept `expectedRevision`. Surface Vault's `REQUEST_REVISION_CONFLICT` and `REQUEST_WORK_KEY_CONFLICT` as
  stable 409 payloads for Moon.
- Sage owns the Wanted metadata and Missing Content broker routes. Keep `/api/moon-v3/admin/wanted/metadata`
  canonical, keep `/metadata-gaps` as a legacy alias, pass library ids into Raven metadata search, apply chosen
  matches through Raven identify, keep `/api/moon-v3/admin/wanted/missing-content` canonical, and keep
  `/missing-chapters` as an alias. Missing Content should include chapter gaps plus Raven quality counts and damaged
  page details while still repairing through the existing library repair/replace-source flow.
- Sage also owns the browser-safe System-page broker contracts. `/api/moon-v3/admin/system/logs` should enforce
  `system.read` and proxy only Warden's redacted log-tail API; `/api/moon-v3/admin/system/events` should forward
  durable event filters to Vault; `/api/moon-v3/admin/system/updates/check` and `/install` should stay `system.root`.
- Sage owns the admin maintenance scheduler behind `/api/moon-v3/admin/system/tasks`. Keep the job catalog
  allowlisted, store cron schedules in Vault under Sage-owned settings, prevent overlapping runs per task, and append
  durable job snapshots plus events for manual or scheduled runs.
- Sage owns the System Status endpoint registry. Keep `/api/moon-v3/admin/system/status` grouped by service and
  lightweight, keep Warden bootstrap/runtime details in `/api/moon-v3/admin/system/status/runtime`, probe GET/read
  endpoints only from `/api/moon-v3/admin/system/status/check`, classify auth-gated reads as `protected`, keep mutation
  routes visible as `not_probed`, and avoid adding browser-direct status calls around Moon.
- Sage owns the dedicated AI admin broker at `/api/moon-v3/admin/system/ai` and the `ai` admin domain. Oracle settings
  saves require `ai.write`; LocalAI lifecycle actions require `ai.root`; install/start/remove requests should pass the
  Moon admin requester context to Warden. Admin test prompts and structured assist calls should degrade safely when
  Oracle or LocalAI is unavailable. Keep the admin test timeout long enough for CPU-only LocalAI prompts instead of
  assuming readiness means fast generation. Keep the base AI payload saved-state focused, put Oracle health and LocalAI
  runtime probes in `/api/moon-v3/admin/system/ai/runtime`, and keep model discovery brokered through Oracle; Moon
  should never call OpenAI or LocalAI directly from the browser.
- Sage owns the AI tool registry. Read tools can execute immediately when enabled and permitted; operational tools
  create expiring proposals and require an authorized admin confirmation before Sage executes the allowlisted action.
- Sage should expose acked system-notification queues for Portal so Warden LocalAI lifecycle jobs can DM the admin who
  requested them without making Portal poll Warden directly.
- Sage should expose acked release-channel notification queues for Portal from completed Raven download tasks. Group
  pending releases into stable `release:digest:<newestTaskId>:<count>` payloads, keep the durable state as
  `ackedIds` plus the `silenceBefore` cursor, tolerate completed tasks with no matching library title, and only mark
  them acknowledged after Portal confirms the Discord channel send.
- Sage should expose acked update-channel notification queues for Portal from GitHub update digests. The `update-check`
  system task must call Warden's image check first, then compare `The-Noona-Project/Scriptarr` commits against the
  last posted update baseline, ask Oracle for the Noona summary, store pending retry state when Oracle is unavailable
  or returns degraded/disabled fallback copy, and use stable `update:<latestSha>` ids that are acknowledged only after
  Portal confirms the Discord channel send.
- Sage should expose acked downloadall notification queues for Portal from Raven durable run jobs. Use stable
  `downloadall:<runId>:<batchId>:<status>` ids and only mark them acknowledged after Portal confirms the requester DM.
- Sage also owns downloadall reaction decision prompts. Store the paused-notification DM message id, owner id, run id,
  batch id, and decision status durably; check reactions continue the run, cross reactions cancel the remaining run,
  duplicate decisions are idempotent, and expired prompts do not repeat actions.
- Moon's user library card route should broker Raven's compact card view and paginate/filter in Sage so browsers never
  need full chapter arrays for `/browse`, `/library`, or shelf cards. Pass `q`, `type`, `letter`, `cursor`,
  `pageSize`, `sort`, and optional exact `ids` through Raven instead of sorting/slicing a full catalog in Sage.
- Service-originated async changes from Raven, Portal, or Warden should append immutable summary events through Sage's
  internal broker routes after the authoritative mutation succeeds so `/admin/users`, `/admin/requests`, and
  `/admin/system/events` all reflect the same truth.
