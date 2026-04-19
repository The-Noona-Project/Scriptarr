# Warden AI Notes

- Warden owns first boot, runtime defaults, service descriptors, the URL-first MySQL contract, and LocalAI image
  selection.
- Warden must surface the exact Discord callback URL administrators need.
- Warden owns one shared internal Docker network named `scriptarr-network`; Moon is the only default public bridge.
- Warden runs as its own Docker container and is the only first-party container admins should start manually in the
  supported install path.
- Warden requires a Docker socket bind and should reconcile the managed sibling containers from inside that container.
- Warden's own persistent folders are `warden/logs -> /var/log/scriptarr` and `warden/runtime -> /var/lib/scriptarr`.
- On Linux or Unraid installs, prefer binding the full `SCRIPTARR_DATA_ROOT` back into the Warden container at the
  same absolute path so Warden can create the host storage tree directly.
- Keep Docker health checks aligned between Warden, the managed HTTP services, and managed MySQL so operators can trust
  Docker's `healthy` status during first boot and upgrades.
- LocalAI is manual in 3.0: no first-boot pull, install, or start.
- AI acceleration is optional; safe fallback is required.
- The repo-level Docker test stack is Warden-managed, starts a containerized Warden first, and should stay aligned with
  the runtime service plan.
- Warden's public bootstrap and runtime APIs must redact secrets before Moon or other operators consume them.
- Keep full JSDoc on exported Warden `.mjs` source and tests so the ESLint doc gate stays green.
