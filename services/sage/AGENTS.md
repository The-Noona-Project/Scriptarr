# Sage Agent Guide

Read this before editing `services/sage`.

## Role

Sage is Scriptarr's Moon-facing auth and browser-safe orchestration broker.

## Hard Rules

- Browsers should talk to Moon, and Moon should talk to Sage.
- Keep Discord auth, first-admin claim, session handling, and policy checks centralized here.
- Avoid bypassing Sage from Moon for convenience.
