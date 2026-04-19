# Warden AI Notes

- Warden owns first boot, runtime defaults, service descriptors, the URL-first MySQL contract, and LocalAI image
  selection.
- Warden must surface the exact Discord callback URL administrators need.
- Warden owns one shared internal Docker network named `scriptarr-network`; Moon is the only default public bridge.
- LocalAI is manual in 3.0: no first-boot pull, install, or start.
- AI acceleration is optional; safe fallback is required.
- The repo-level Docker test stack is Warden-managed and should stay aligned with the runtime service plan.
