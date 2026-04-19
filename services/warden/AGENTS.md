# Warden Agent Guide

Read this before editing `services/warden`.

## Role

Warden is Scriptarr's Docker orchestrator and first-boot source of truth. It seeds runtime defaults, derives the
Discord callback URL, parses the URL-first MySQL contract, owns `scriptarr-network`, selects the correct LocalAI AIO
image for the host hardware, and exposes manual LocalAI lifecycle actions after install.

## Hard Rules

- Keep public runtime and setup details in `README.md` and [../../ServerAdmin.md](../../ServerAdmin.md).
- Warden should degrade safely when AI acceleration is unavailable.
- Do not reintroduce a setup wizard.
- Warden is the only first-party container admins should start manually. It must run as `scriptarr-warden` unless a
  narrower test or preview scope explicitly changes the name.
- Warden requires a Docker socket bind and should reconcile the rest of the managed Scriptarr containers from inside its
  own container.
- Warden owns the managed service env contract and should inject Sage broker settings for first-party internal HTTP
  instead of reviving direct Vault, Oracle, or Warden cross-calls in sibling services.
- Do not pull or start LocalAI during first boot.
- Keep the public MySQL contract URL-first. Internal split MySQL envs are derived outputs, not first-class admin
  inputs.
- Keep Moon as the only public first-party service by default; other services should stay on the internal Warden
  network.
- Keep full JSDoc on exported Warden `.mjs` source and test files. `npm test` is expected to fail when doc coverage
  regresses.
- Keep `npm run docker:healthcheck` aligned with Warden's real runtime plan; it is the default cross-service smoke path
  for contributors and agents.
- Keep Moon -> Sage -> Warden managed-service updates scoped to the sibling first-party services. Warden and MySQL stay
  manual unless the product requirements explicitly change.
- Keep Warden update jobs durable through the shared broker instead of leaving them in process-local memory only.
- Keep LocalAI manual. Warden may cache the last Sage-synced LocalAI selection in `warden/runtime`, but Sage/Vault stay
  the durable owner of Oracle/LocalAI settings.
- Keep LocalAI starts readiness-gated. Warden should not report success until `GET /readyz` or the `GET /v1/models`
  fallback succeeds.
- Keep the official LocalAI AIO images, but boot them with the Oracle-safe `text-to-text.yaml` preload set instead of
  the full bundled model list so startup does not hang on optional speech or media models.
- Keep LocalAI AIO runtime mounts and hardware flags aligned with the selected preset:
  - `cpu`: no extra device flags
  - `nvidia`: `--gpus all`
  - `intel`: `--device /dev/dri --group-add video`
  - `amd`: `--device /dev/kfd --device /dev/dri --group-add video`
- If service boot order, network topology, LocalAI image selection, first-boot auth, or Docker test mode changes,
  update the Warden docs.
