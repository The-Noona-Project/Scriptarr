# Warden Agent Guide

Read this before editing `services/warden`.

## Role

Warden is Scriptarr's Docker orchestrator and first-boot source of truth. It seeds runtime defaults, derives the
Discord callback URL, parses the URL-first MySQL contract, owns `scriptarr-network`, selects the correct LocalAI image
for the host hardware, and exposes manual LocalAI lifecycle actions after install.

## Hard Rules

- Keep public runtime and setup details in `README.md` and [../../ServerAdmin.md](../../ServerAdmin.md).
- Warden should degrade safely when AI acceleration is unavailable.
- Do not reintroduce a setup wizard.
- Warden is the only first-party container admins should start manually. It must run as `scriptarr-warden` unless a
  narrower test or preview scope explicitly changes the name.
- Warden requires a Docker socket bind and should reconcile the rest of the managed Scriptarr containers from inside its
  own container.
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
- If service boot order, network topology, LocalAI image selection, first-boot auth, or Docker test mode changes,
  update the Warden docs.
