# Warden Agent Guide

Read this before editing `services/warden`.

## Role

Warden is Scriptarr's Docker orchestrator and first-boot source of truth. It seeds runtime defaults, derives the
Discord callback URL, parses the URL-first MySQL contract, owns `scriptarr-network`, and injects GPU/runtime flags for
managed services.

## Hard Rules

- Keep public runtime and setup details in `README.md` and [../../ServerAdmin.md](../../ServerAdmin.md).
- Warden should degrade safely when AI acceleration is unavailable.
- Do not reintroduce a setup wizard.
- Warden is the only first-party container admins should start manually. It must run as `scriptarr-warden` unless a
  narrower test or preview scope explicitly changes the name.
- Warden requires a Docker socket bind and should reconcile the rest of the managed Scriptarr containers from inside its
  own container.
- Warden owns the managed service env contract and should inject Sage broker settings plus Noona/Appa Discord env into
  the relevant sibling services instead of reviving direct Vault, Oracle, or Warden cross-calls.
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
- Keep LocalAI manual. Oracle owns the embedded LocalAI model cache/runtime; Sage/Vault stay the durable owner of
  Oracle/LocalAI settings.
- Do not revive the standalone `scriptarr-localai` sidecar by default. Warden should mount persistent LocalAI models
  and data into `scriptarr-oracle`, then let Oracle's embedded runtime handle install/start/remove/readiness.
- Keep Oracle LocalAI runtime mounts and hardware flags aligned with the selected preset:
  - `cpu`: no extra device flags
  - `nvidia`: `--runtime nvidia --gpus all` plus `/dev/nvidia0`, `/dev/nvidiactl`, `/dev/nvidia-uvm`, and
    `/dev/nvidia-uvm-tools` device bindings
  - `intel`: `--device /dev/dri --group-add video`
  - `amd`: `--device /dev/kfd --device /dev/dri --group-add video`
- If service boot order, network topology, embedded LocalAI runtime planning, first-boot auth, or Docker test mode changes,
  update the Warden docs.

## Coding Map

- Service definitions, env injection, network aliases, ports, volumes, and health commands live in
  `config/servicePlan.mjs`.
- Container reconciliation and drift handling live in `core/managedStackRuntime.mjs`; update orchestration lives in
  `core/updateRuntime.mjs`; legacy sidecar LocalAI lifecycle work lives in `core/localAiRuntime.mjs`.
- Docker CLI helpers live under `docker`; filesystem and storage layout helpers live under `filesystem`.
- Warden should reconcile sibling first-party services from inside the `scriptarr-warden` container through the Docker
  socket. Do not move this responsibility into Moon, Sage, or host scripts.
- Managed-service updates are for sibling services only. Warden itself and MySQL stay manual unless product
  requirements explicitly change.
- Prove Warden changes with `npm --workspace services/warden test`, then `npm run docker:healthcheck` for plan,
  network, health, update, or first-boot behavior.
