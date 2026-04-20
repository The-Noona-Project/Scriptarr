# Sage

Sage is Scriptarr's Moon-facing auth and orchestration broker.

Sage is also the only supported first-party internal HTTP broker. Moon talks to Sage, and Portal, Oracle, Raven, or
Warden should use Sage's internal broker routes instead of reaching across the stack directly.

It persists Moon admin Raven and Oracle settings through Vault, brokers durable job and task state, and mediates the
browser-safe handoff to Warden for manual LocalAI or managed-service update actions.
Sage now also owns the shared metadata-first request intake flow. Moon user requests and Moon admin add-title both
search through Sage, which asks Raven for metadata-plus-download availability, persists the chosen match snapshot in
Vault, and later queues the exact saved Raven target during moderation or admin immediate-add.

Moon's legacy and v3 library routes should mirror Raven's real-or-empty library state. Sage no longer seeds preview
titles on behalf of Moon.
Sage also brokers Moon's trusted public automation API. It stores only the hashed admin API key, issues short-lived
selection tokens for public search results, enforces the external NSFW and duplicate guards on request creation, and
queues accepted external requests at the lowest priority instead of letting them cut ahead of browser or Discord work.
