<!-- Keep this README user-facing; move contributor-only implementation detail into docs/agents or AGENTS.md. -->

# Oracle

Oracle is the Noona AI persona for Scriptarr.

Oracle now runs as a small FastAPI service. It starts disabled on install, defaults to OpenAI configuration, and stays
read-only in v1. Moon admin can later switch Oracle to a Warden-managed LocalAI runtime when the server admin is ready
for the longer install or startup time.

Oracle no longer talks directly to Vault or Warden. Its first-party Scriptarr reads now go through Sage's internal
broker routes, while external LLM traffic still goes directly to OpenAI or LocalAI through OpenAI-compatible requests.

Oracle preserves the same internal contract used elsewhere in Scriptarr:

- `GET /health`
- `GET /api/status`
- `POST /api/chat`

`POST /api/chat` still accepts the existing `{ "message": "..." }` payload. Sage may also include an optional
`context` object for brokered surfaces such as public Discord mention chat. That context can carry persona hints,
summarized Noona memory, user display information, and read-only status/library/trivia context. Oracle treats it as
background only; it does not store memory, execute tools, mutate Scriptarr, or reveal raw identifiers/secrets back to
Discord.
Sage may also include a small `visualIdentity` context for Noona and Appa appearance questions; Oracle treats those
descriptions as read-only persona background and does not inspect image files directly.

Moon admin now manages Oracle from `/admin/system/ai` through Sage. That page saves provider, model, temperature, and
masked OpenAI key state, shows Oracle health, and sends a small brokered test prompt without exposing Oracle directly
to the browser.

Oracle also exposes `GET /api/models?provider=openai|localai` for Sage-brokered admin model discovery. OpenAI models
are filtered to Oracle-compatible text or chat families, while LocalAI models are read from the OpenAI-compatible
`/v1/models` endpoint.

Oracle returns provider-specific degraded replies when OpenAI or LocalAI fails. The LLM call timeout defaults to 60
seconds and can be tuned with `SCRIPTARR_ORACLE_LLM_TIMEOUT_SECONDS`, which gives CPU-only LocalAI enough room for
small admin test prompts.

The service keeps the existing env names for Sage, OpenAI, and LocalAI so Warden, Moon, Sage, and Portal do not need
to change how they configure or call Oracle.
