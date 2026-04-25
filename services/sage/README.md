# Sage

Sage is Scriptarr's Moon-facing auth and orchestration broker.

Sage is also the only supported first-party internal HTTP broker. Moon talks to Sage, and Portal, Oracle, Raven, or
Warden should use Sage's internal broker routes instead of reaching across the stack directly.

It persists Moon admin Raven and Oracle settings through Vault, brokers durable job and task state, and mediates the
browser-safe handoff to Warden for manual LocalAI or managed-service update actions.
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

Moon's legacy and v3 library routes should mirror Raven's real-or-empty library state. Sage no longer seeds preview
titles on behalf of Moon.
Sage also brokers Moon's trusted public automation API. It stores only the hashed admin API key, issues short-lived
selection tokens for public search results, enforces the external NSFW and duplicate guards on request creation, and
queues accepted external requests at the lowest priority instead of letting them cut ahead of browser or Discord work.
