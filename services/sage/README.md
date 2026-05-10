# Sage

Sage is Scriptarr's Moon-facing auth and orchestration broker.

Sage is also the only supported first-party internal HTTP broker. Moon talks to Sage, and Portal, Oracle, Raven, or
Warden should use Sage's internal broker routes instead of reaching across the stack directly.

It persists Moon admin Raven and Oracle settings through Vault, brokers durable job and task state, mediates the
browser-safe handoff to Warden for manual LocalAI or managed-service update actions, and exposes system notification
queues for Portal-owned Discord DMs.
Sage now also owns the shared metadata-first request intake flow. Moon user requests, Discord `/request`, and Moon
admin add-title all search through Sage, which asks Raven for metadata and source availability, persists the chosen
metadata snapshot in Vault, and later queues the exact saved Raven target during moderation or admin immediate-add.
Sage now treats Raven's grouped intake result as the canonical request identity and defers final duplicate enforcement
to Vault's durable work-key guard so Moon, Discord, admin add-title, and the public API all reject the same duplicate
targets consistently under concurrency.
Moon web now creates requests only through `/myrequests`, and Discord `/request` now uses the same metadata-first
sequence. Sage exposes the browser-safe and Portal-safe orchestration steps separately: metadata search, admin-only
download-option lookup from the selected metadata result, and final moderated request creation.
Duplicate submissions no longer create visible second request rows. Sage attaches duplicate users to a hidden waitlist
on the canonical request work identity so Portal can DM them when the title becomes ready. When metadata exists but no
download target exists yet, Sage stores an `unavailable` request, re-checks it every 4 hours, and expires it after 90
days if no stable source appears.
Sage also owns the brokered `sage.requests.autoApproveAndDownload` setting. When that toggle is enabled, Sage may
queue a request automatically only if Raven resolves one high-confidence source with no conflicting warnings; anything
weaker stays in manual admin review.
Sage now also brokers durable user read-state and tag-preference routes for Moon. Moon home, title, and reader payloads
use those brokered title or chapter reads plus explicit tag likes or dislikes to build the active bookshelf and
personalized tag shelves instead of relying only on progress rows.
Sage now also exposes a dedicated `/api/moon-v3/user/profile` aggregate payload so Moon's `/profile` route can render
tabbed overview, stats, and preferences surfaces from one trusted response instead of fanning out across several
browser calls.
Sage now also carries a sanitized Moon `returnTo` path through Discord OAuth `state` so Moon can return the browser to
the page where login started instead of always landing in admin or one fixed callback destination.
For Moon admin, Sage now brokers `/api/moon-v3/admin/activity/queue` as a live queue-board payload plus task action
routes for cancel, retry, reprioritize, move up/down, cancel-all queued, cancel-all running, and remove-all removable.
Those routes stay Moon-safe, same-origin, and event-backed so the admin queue can re-fetch on SSE updates instead of
polling blindly.
That queue payload now stays recovery-focused: `needsAttention` only contains Raven recovery work with a remove
affordance when a task is safe to clear, queued cards do not carry ETA, and running cards carry live download speed
plus an active ETA when Raven gives Sage credible progress data. Sage also exposes `retry-all` and per-task remove
actions for the recovery set. Warden service update or restart jobs are excluded from this recovery payload and remain
under System/Updates/Events; Sage does not yet expose a Moon queue cleanup action for non-Raven broker jobs.
Sage also brokers Portal's owner-only DM-only WeebCentral `/downloadall` workflow. All requests now proxy to Raven's
durable bulk-run create path, while status, continue/resume, and cancel paths let each batch pause for owner approval.
Sage exposes a Portal notification queue for paused, completed, failed, or cancelled run batches and acknowledges those
notifications only after Portal confirms the requester DM. Paused downloadall DMs can persist reaction decision
prompts through Sage so the owner can continue with a check reaction or cancel with a cross reaction; duplicate or
expired prompt decisions are idempotent.
Sage also brokers compact paginated Moon library card reads from Raven's card projection, passing `q`, `type`,
`letter`, `cursor`, `pageSize`, `sort`, and optional exact `ids` through instead of sorting a full catalog in memory.
Browse, library, home, and profile shelf clients should use that route and reserve full title payloads for title
detail and reader routes. Continue-reading and recent-activity card hydration should use the exact-id card projection
instead of fanning out into individual full-title requests.
Sage also owns the root-only content reset preview plus execute flow for Moon admin. It previews Vault plus Raven reset
scope, requires an explicit confirmation string, appends durable reset events, clears Vault's content-side state, and
then tells Raven to wipe its managed catalog, tasks, and managed download folders.
Sage now also brokers group-based Moon admin access and the shared admin event backbone. It exposes reusable
permission-group CRUD plus user-group assignment flows for `/admin/users`, keeps canonical route-family grants in Moon
session payloads while temporarily deriving the old flat permission array for compatibility, and appends immutable
durable events into Vault after authoritative mutations or async service updates.
Moon now reads those shared events through same-origin `/api/moon-v3/admin/events` and
`/api/moon-v3/admin/events/stream` routes. Sage authorizes those reads by the requested event domains instead of
falling back to one blanket system permission.
Sage also brokers the Moon Settings hub. Branding site name, uploaded WebP logo variant metadata, toast defaults,
personal toast overrides, Raven VPN, provider settings, request workflow, and Discord essentials all stay Vault-backed
and browser-safe. The fast Settings payload stays saved-state focused. Raven VPN runtime, the database overview, and
Portal Discord runtime hydrate from `/api/moon-v3/admin/settings/runtime`; the database overview returns `null` when
the admin lacks the `database` read grant. The DB explorer routes under `/api/moon-v3/admin/settings/database` require
the `database` admin domain, read only through Vault's allowlisted explorer contract, and only write validated settings
JSON. Sage also brokers the admin VPN test action to Raven and returns only sanitized runtime state, never PIA
credentials.
The v3 Settings save surface includes explicit Raven metadata-provider, Raven download-provider, Raven download-runtime,
and Portal Discord basics routes so Moon no longer has to rely on generic legacy settings mutations for those sections.
`raven.download.runtime` stores the active title-download limit (`1` through `6`, default `2`); Sage saves it through
Vault, appends a durable settings event, and asks Raven to reload it live. If Raven cannot reload immediately, Sage
returns the saved setting plus a warning so the value can still apply after the next Raven restart. Sage also exposes
the dedicated Discord settings routes for the full `/admin/discord` page, including release notification channel tests.
Admin request moderation now returns summary counts with the request list and exposes `deny` as a first-class
`requests.write` mutation that requires a moderator comment, records durable request events, and lets the existing
notification flow tell the requester what happened.
Admin request summaries include a revision number, and approve, deny, override, resolve, and source-refresh actions
can pass that revision back as `expectedRevision`. Vault rejects stale actions with `REQUEST_REVISION_CONFLICT`, which
Sage forwards as a clean 409 so Moon can refresh before the moderator retries.
`/api/moon-v3/admin/calendar` now returns chapter release entries plus completed-title markers, preserving undated
completed counts so Moon can surface finished catalog titles that do not have reliable chapter dates.

Sage also brokers the Next admin System pages. `/admin/system/logs` reads Warden's allowlisted redacted Docker log
tail through Sage, `/admin/system/events` forwards richer durable-event filters into Vault, and
`/admin/system/updates` keeps using Warden's managed-service check/install APIs with `system.root` required for
mutations.
`/admin/system/tasks` is Sage's allowlisted maintenance scheduler: definitions are Scriptarr-owned, schedules are
Vault-backed, overlapping runs are blocked per task, and every manual or scheduled run emits durable job and event
state. `/admin/system/status` is the lightweight endpoint registry; Warden bootstrap and runtime details hydrate from
`/api/moon-v3/admin/system/status/runtime`. It leaves GET/read checks pending until
`/api/moon-v3/admin/system/status/check` is called, then classifies auth-gated reads as protected and leaves mutation
routes unprobed. `/admin/system/ai` centralizes Oracle settings plus brokered Warden LocalAI
install, start, and remove controls with requester context for Portal completion DMs.

Moon's legacy and v3 library routes should mirror Raven's real-or-empty library state. Sage no longer seeds preview
titles on behalf of Moon.
Sage also brokers Moon's trusted API-key flow. It resolves hashed system keys into synthetic actors with
permission-group grants, resolves user keys into account-scoped reader actors with admin grants stripped, keeps legacy
public keys accepted during migration, issues short-lived selection tokens for public search results, enforces the
external NSFW and duplicate guards on request creation, and queues accepted external requests at the lowest priority.
Sage also owns the admin Wanted repair routes. `/api/moon-v3/admin/wanted/metadata` is canonical, the old
`metadata-gaps` route remains an alias, metadata search is scoped with the Raven library id, metadata apply calls
Raven identify, and missing-chapter repair stays on the existing staged replacement download broker.
Sage also owns Portal's release notification queue. Completed Raven tasks become stable `release:<taskId>` channel
notifications when a release channel is configured, and Portal acknowledges them through Sage only after Discord
accepts the channel message.
