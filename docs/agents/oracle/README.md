# Oracle AI Notes

- Oracle is still non-mutating: it can chat, report status, and provide bounded structured assistance, but Sage owns
  all tool execution and confirmations.
- It starts disabled and OpenAI-first.
- Oracle now runs as a FastAPI Python service while preserving the existing `/health`, `/api/status`, and `/api/chat`
  contract for the rest of Scriptarr, plus `/api/assist` for Sage-brokered planning, trivia matching advice, and
  concise message assistance.
- `/api/chat` accepts optional Sage-curated context while preserving the message-only contract. Use context for
  persona, summarized memory, and read-only status/library/trivia background only; do not store it, expose raw ids or
  secrets, or treat it as permission to mutate anything.
- It still uses OpenAI-compatible wiring so LocalAI can be swapped in later.
- It should gracefully return disabled or degraded responses when OpenAI or LocalAI is unavailable.
- Keep degraded replies provider-specific so OpenAI failures are not reported as LocalAI outages, and keep the
  provider call timeout long enough for CPU-only LocalAI admin tests.
- Keep `GET /api/models` additive and read-only. It should discover OpenAI or LocalAI models through server-side
  provider calls, filter OpenAI results to Oracle-compatible text/chat models, and return a current/default fallback
  option if discovery fails.
- Oracle's first-party Scriptarr reads should flow through Sage's internal broker routes rather than direct Vault or
  Warden clients.
- When Oracle is configured for LocalAI and the model is left blank, use a LocalAI-friendly alias rather than the
  OpenAI-default model name.
- Moon admin now manages Oracle from `/admin/system/ai` through Sage. Keep `/api/status` and `/api/chat` suitable for
  health display and the admin test prompt, and keep disabled or degraded responses friendly rather than making the
  broader stack unhealthy.
- `/api/assist` must degrade to empty advisory output when Oracle is disabled, slow, or unhealthy. Do not let assist
  failures block Portal notifications, trivia rounds, or admin pages.
