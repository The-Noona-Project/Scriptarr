# Portal Agent Guide

Read this before editing `services/portal`.

## Role

Portal handles Discord onboarding, requests, notifications, subscriptions, and the Oracle chat bridge.

## Hard Rules

- Do not reintroduce Kavita or Komf dependencies.
- Moon and Discord requests must converge on one moderated request flow.
- Oracle integration is read-only for v1 status lookup plus chat.
