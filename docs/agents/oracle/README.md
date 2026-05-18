# Oracle AI Notes

- Oracle is still non-mutating: it can chat, report status, and provide bounded structured assistance, but Sage owns
  all tool execution and confirmations.
- It starts disabled and OpenAI-first.
- Oracle now runs as a FastAPI Python service while preserving the existing `/health`, `/api/status`, and `/api/chat`
  contract for the rest of Scriptarr, plus `/api/assist` for Sage-brokered planning, trivia matching advice, concise
  message assistance, and Appa review decisions.
- `/api/chat` accepts optional Sage-curated context and `personaName` (`Noona` or `Appa`) while preserving the
  message-only contract. Use context for persona, summarized memory, and read-only status/library/trivia background
  only; do not store it, expose raw ids or secrets, or treat it as permission to mutate anything.
- `/api/assist` task `review-noona-public-chat` must return a normalized decision for Sage. Malformed model output
  should degrade to `ok` with no correction text, not a guessed public correction.
- If the context includes `visualIdentity`, use it only to answer Noona/Appa appearance questions. Do not claim Oracle
  viewed the images directly; Sage owns the text descriptions and Portal owns the Discord avatar assets.
- It uses OpenAI-compatible wiring for both OpenAI and embedded LocalAI. Embedded LocalAI runs in the Oracle container,
  starts with no preloaded model, and downloads the selected GGUF once into persistent storage.
- Embedded LocalAI should not be considered usable until a real generation probe returns the expected readiness text.
  A healthy process, `/readyz`, or any random non-empty completion is not enough.
- The next startup hardening pass should make deploy/restart behavior less manual: if Oracle is enabled, provider is
  `localai`, and the selected model is already installed, Oracle may start embedded LocalAI and verify generation in
  the background while keeping `/health` healthy and admin runtime status honest.
- It should gracefully return disabled or degraded responses when OpenAI or LocalAI is unavailable.
- Keep degraded replies provider-specific so OpenAI failures are not reported as LocalAI outages, and keep the
  provider call timeout long enough for CPU-only LocalAI admin tests.
- Keep `GET /api/models` additive and read-only. It should discover OpenAI models through server-side provider calls
  and return Oracle's embedded LocalAI model options/status when LocalAI is embedded.
- Oracle's first-party Scriptarr reads should flow through Sage's internal broker routes rather than direct Vault or
  Warden clients.
- When Oracle is configured for LocalAI and the model is left blank or still has a legacy OpenAI-style alias, use
  `Hermes-3-Llama-3.1-8B-Q4_K_S.gguf`.
- The model YAML written into `/models` must remain OpenAI-chat compatible. Preserve the `chat_message` template when
  changing LocalAI model config generation; broken templates can make the model answer from stale-looking prompt text
  even while the API returns HTTP 200.
- Moon admin now manages Oracle from `/admin/system/ai` through Sage. Keep `/api/status` and `/api/chat` suitable for
  health display and the admin test prompt, and keep disabled or degraded responses friendly rather than making the
  broader stack unhealthy.
- `/api/assist` must degrade to empty advisory output when Oracle is disabled, slow, or unhealthy. Do not let assist
  failures block Portal notifications, trivia rounds, or admin pages.
