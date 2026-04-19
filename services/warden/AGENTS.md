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
- Do not pull or start LocalAI during first boot.
- Keep the public MySQL contract URL-first. Internal split MySQL envs are derived outputs, not first-class admin
  inputs.
- Keep Moon as the only public first-party service by default; other services should stay on the internal Warden
  network.
- If service boot order, network topology, LocalAI image selection, first-boot auth, or Docker test mode changes,
  update the Warden docs.
