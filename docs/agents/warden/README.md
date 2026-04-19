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
- `npm run docker:healthcheck` is the default Warden-managed smoke flow for contributors. It is expected to take a
  while on cold machines because it rebuilds images and may need to pull missing layers.
- LocalAI is manual in 3.0: no first-boot pull, install, or start.
- LocalAI presets now use the LocalAI AIO image family. Warden must mount persistent LocalAI state, pass the correct
  hardware flags for the selected preset, wait for readiness before reporting success, and constrain the AIO `MODELS`
  preload set to the Oracle-safe text generation profile instead of the full bundled list.
- AI acceleration is optional; safe fallback is required.
- The repo-level Docker test stack is Warden-managed, starts a containerized Warden first, and should stay aligned with
  the runtime service plan.
- Warden's public bootstrap and runtime APIs must redact secrets before Moon or other operators consume them.
- The managed-service update path lives behind Moon -> Sage -> Warden and only targets the sibling first-party
  services. Warden and MySQL are informational or manual in the current product scope.
- Warden should inject Sage broker settings into Portal, Oracle, and Raven instead of direct first-party base URLs.
- Update jobs should be mirrored into the shared broker as durable jobs and job tasks, not left as Warden-only memory.
- Keep full JSDoc on exported Warden `.mjs` source and tests so the ESLint doc gate stays green.
