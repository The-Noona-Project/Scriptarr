# Oracle Agent Guide

Read this before editing `services/oracle`.

## Role

Oracle is the Noona AI persona for Scriptarr, backed by LangChain JS with OpenAI-first defaults and optional LocalAI.

## Hard Rules

- Keep Oracle limited to text chat and read-only status lookup in v1.
- Oracle degradation must not make the rest of Scriptarr unhealthy.
- Keep Oracle off by default on fresh installs.
- Keep LocalAI communication OpenAI-compatible so Warden-selected images stay swappable.
