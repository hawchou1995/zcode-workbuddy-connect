# Attribution

This project is a port of **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)**
(MIT, Copyright (c) 2026 Corrine Hu) from the DeepSeek Harness plugin API to
ZCode's.

The upstream project in turn ports its WorkBuddy wire behaviour from
**[Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)** (MIT).

## What came from where

**Brought over from the upstream (behaviour preserved deliberately, because it is
what makes the endpoint work at all):**

- The upstream HTTP client: chat streaming, token refresh, model catalog,
  credit/billing endpoints, error classification
- The wire quirks: forced `stream: true`, `developer` → `system` role rewrite,
  string-form `tool_choice`, the `X-No-*` / `X-User-Id` / `X-Product` header set
- The desktop-shaped chat `User-Agent` and its installed-App → saved → fallback
  resolution order
- The credential model: read the desktop app's sign-in file read-only, refresh
  into a separate plugin-owned copy, prefer identity over expiry
- The loopback OpenAI-compatible endpoint and its inbound hardening (loopback
  Host, loopback Origin, JSON content type, constant-time bearer check)
- The promotion/billing display rules, including dropping a rate that can no
  longer be stood behind rather than keep claiming a discount

**Rewritten for this port:**

- Everything that touched DSH APIs: the provider adapter, the settings card, the
  Composer probe control, the DSH-home path resolution, the atomic-write
  dependency. ZCode has no equivalents, so the provider half became
  configuration and the UI half was dropped.
- The shim became a standalone service rather than an in-process object.
- The endpoint bearer became persisted rather than per-process, because the
  client records it in a config file and it must survive restarts.
- Reasoning-level probing was dropped (see the README).
- SSE handling was rewritten after testing found three real defects in the port
  — see the git history.
- Windows is the primary target, so the App-version and credential probes cover
  Windows install roots rather than macOS bundles.

## Licence

MIT throughout. See [LICENSE](./LICENSE).
