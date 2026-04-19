# Sage

Sage is Scriptarr's Moon-facing auth and orchestration broker.

Sage is also the only supported first-party internal HTTP broker. Moon talks to Sage, and Portal, Oracle, Raven, or
Warden should use Sage's internal broker routes instead of reaching across the stack directly.

It persists Moon admin Raven and Oracle settings through Vault, brokers durable job and task state, and mediates the
browser-safe handoff to Warden for manual LocalAI or managed-service update actions.

Moon's legacy and v3 library routes should mirror Raven's real-or-empty library state. Sage no longer seeds preview
titles on behalf of Moon.
