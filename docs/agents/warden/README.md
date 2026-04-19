# Warden AI Notes

- Warden owns first boot, runtime defaults, service descriptors, the URL-first MySQL contract, and LocalAI image
  selection.
- Warden must surface the exact Discord callback URL administrators need.
- Warden owns one shared internal Docker network named `scriptarr-network`; Moon is the only default public bridge.
- Warden runs as its own Docker container and is the only first-party container admins should start manually in the
  supported install path.
- Warden requires a Docker socket bind and should reconcile the managed sibling containers from inside that container.
- Warden's own persistent folders are `warden/logs -> /var/log/scriptarr` and `warden/runtime -> /var/lib/scriptarr`.
- LocalAI is manual in 3.0: no first-boot pull, install, or start.
- AI acceleration is optional; safe fallback is required.
- The repo-level Docker test stack is Warden-managed, starts a containerized Warden first, and should stay aligned with
  the runtime service plan.
- Keep full JSDoc on exported Warden `.mjs` source and tests so the ESLint doc gate stays green.
