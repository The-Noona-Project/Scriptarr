# Oracle AI Notes

- Oracle is read-only in v1.
- It starts disabled and OpenAI-first.
- It still uses OpenAI-compatible wiring so LocalAI can be swapped in later.
- It should gracefully return disabled or degraded responses when OpenAI or LocalAI is unavailable.
- Oracle's first-party Scriptarr reads should flow through Sage's internal broker routes rather than direct Vault or
  Warden clients.
