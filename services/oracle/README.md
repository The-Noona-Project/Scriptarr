<!-- Keep this README user-facing; move contributor-only implementation detail into docs/agents or AGENTS.md. -->

# Oracle

Oracle provides Scriptarr's read-only AI replies for Noona and Appa.

Oracle now runs as a small FastAPI service. It starts disabled on install, defaults to OpenAI configuration, and stays
read-only in v1. Moon admin can later switch Oracle to the embedded LocalAI runtime when the server admin is ready for
the longer install or startup time.

Oracle no longer talks directly to Vault or Warden. Its first-party Scriptarr reads now go through Sage's internal
broker routes, while external LLM traffic still goes directly to OpenAI or LocalAI through OpenAI-compatible requests.

Oracle preserves the same internal contract used elsewhere in Scriptarr:

- `GET /health`
- `GET /api/status`
- `POST /api/chat`

`POST /api/chat` still accepts the existing `{ "message": "..." }` payload. Sage may also include an optional
`personaName` (`Noona` or `Appa`) and `context` object for brokered surfaces such as public Discord mention chat and
Appa admin mentions. That context can carry persona hints, summarized Noona memory, user display information, and
read-only status/library/trivia context. Oracle treats it as background only; it does not store memory, execute tools,
mutate Scriptarr, or reveal raw identifiers/secrets back to Discord.
Sage may also include a small `visualIdentity` context for Noona and Appa appearance questions; Oracle treats those
descriptions as read-only persona background and does not inspect image files directly.

Moon admin now manages Oracle from `/admin/system/ai` through Sage. That page saves provider, model, temperature, and
masked OpenAI key state, shows Oracle health, and sends a small brokered test prompt without exposing Oracle directly
to the browser.

Oracle also exposes `GET /api/models?provider=openai|localai` for Sage-brokered admin model discovery. OpenAI models
are filtered to Oracle-compatible text or chat families, while LocalAI models are read from the OpenAI-compatible
`/v1/models` endpoint. `POST /api/assist` includes the bounded `review-noona-public-chat` task, which returns a
normalized Appa review decision for Sage; Oracle does not post corrections or write audit events itself.

Oracle returns provider-specific degraded replies when OpenAI or LocalAI fails. The LLM call timeout defaults to 60
seconds and can be tuned with `SCRIPTARR_ORACLE_LLM_TIMEOUT_SECONDS`, which gives CPU-only LocalAI enough room for
small admin test prompts.

Embedded LocalAI startup is deploy-safe. After Oracle prepares its local cache, it starts a background auto-start check
only when Oracle is enabled, the selected provider is `localai`, the selected GGUF model already exists in persistent
storage, no remove action is active, and the runtime can pass a real `scriptarr-ok` generation probe. Missing models or
slow warmup leave Oracle and the broader Scriptarr stack healthy while `/admin/system/ai` shows the startup phase and
last gate reason.

The service keeps the existing env names for Sage, OpenAI, and LocalAI so Warden, Moon, Sage, and Portal do not need
to change how they configure or call Oracle.
