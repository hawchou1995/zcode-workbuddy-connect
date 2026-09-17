# ADR 0001 — Expose WorkBuddy models as a loopback OpenAI-compatible provider

Status: accepted (2026-09-18)

## Context

`corrinehu/dsh-workbuddy-connect` is a **DeepSeek Harness (DSH) Cordis plugin**,
not a Claude Code plugin. It calls DSH APIs to (a) register WorkBuddy desktop-app
models into DSH's provider registry, (b) draw a settings card and a Composer
probe control into DSH's UI slots, and (c) host a loopback OpenAI-compatible
"shim" that applies WorkBuddy's wire quirks (`src/shim.ts`).

The task was to port it to ZCode and install it. Inspection of
`D:\Program Files\ZCode\resources\glm\zcode.cjs` and the installed plugin set
established that **ZCode's plugin API has no "register an LLM provider"
capability**. A plugin may contribute skills, commands, agents, hooks and MCP
servers — none of which can drive ZCode's model selector or agent loop.

A literal port is therefore impossible. Something had to be dropped or
re-shaped.

## Decision

Extract the shim into a **standalone, dependency-free Node service** exposing an
OpenAI-compatible endpoint on `127.0.0.1:39271`, and register it with ZCode the
way ZCode already supports third-party models: an
`api.type: "openai-chat-completions"` entry in
`%USERPROFILE%\.zcode\v2\provider_config.json`.

The plugin proper contributes three things: the service source, one operational
skill, and a `SessionStart` hook that starts the endpoint.

Discarded, because ZCode has no surface for them: the settings card, the
Composer probe control, and reasoning-level probing.

## Consequences

**Gained.** The models are first-class entries in ZCode's model selector,
driving the normal agent loop with streaming, tool calls and image input. This
is stronger than the MCP-server alternative, which could only ever have been
*one tool that asks a model something* — usable, but unable to participate in
ZCode's agent loop at all.

**Lost.** Credit/quota and promotion data is no longer displayed on a card; it
is reachable through `status` and `doctor`. Reasoning-level detection is gone:
the plugin now uses the efforts the upstream catalog declares, so no probing
requests are made. Given probes consume credit and ZCode has nowhere to render
their result, dropping them is a smaller loss than it first appears.

**Constraint inherited.** The provider is only usable while the endpoint is
running, which is a deployment obligation the DSH original did not have (DSH
loaded the plugin in-process). Mitigated by the `SessionStart` hook, which is
self-verifying: it probes the endpoint after spawning and reports plainly when it
could not start it, rather than leaving the failure to surface as an unexplained
connection error on the first message.

## Alternatives rejected

- **MCP server wrapping the models as tools** — cannot drive the agent loop;
  the models would never appear in the model selector.
- **Patching ZCode's provider registry from a plugin** — the capability does not
  exist in the plugin API, and fabricating it would break on every upgrade.
- **A per-process bearer** — the original shim used a fresh in-memory secret per
  process, which is correct for a client that resolves it in-process. Here the
  bearer is recorded in ZCode's config file, so it must survive restarts; it is
  generated once and persisted (mode 0600) instead.