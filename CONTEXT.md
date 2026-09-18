# workbuddy-connect

**WorkBuddy** — the models in the WorkBuddy desktop app (CN), exposed to ZCode as
an OpenAI-compatible model provider. A port of
`corrinehu/dsh-workbuddy-connect` (MIT) from the DeepSeek Harness plugin API to
ZCode's.

- **Provider entry**: `workbuddy` in `%USERPROFILE%\.zcode\v2\provider_config.json`
- **Endpoint**: `http://127.0.0.1:39271/v1` (loopback only)
- **State**: `%USERPROFILE%\.workbuddy-connect\`
- **Roster**: 36 models across two regions — CN (16): GLM-5.3 / 5.3-Flash /
  5.2 / 5.1 / 5v-Turbo, DeepSeek-V4-Pro / V4.1-Flash, Kimi-K3-1 / K2.8-Preview /
  K2.7 / K2.6, MiniMax-M3, Hy4-preview / Hy3 (free) / Hy3-X, Auto; AI (20,
  `wbai:` prefixed): GPT-5.6 Sol / Terra / Luna, GPT-5.5 / 5.4, GPT-6-Astra,
  Gemini-3.5-Flash, GLM-5.3 / 5.2, Kimi-K3 / K2.8-Preview / K2.6,
  DeepSeek-V4.1-Flash (free), Hy4-preview / Hy3 (free), Auto / Fast / Balanced /
  Primary / Deep
- **Skill**: `workbuddy-models` — how to operate and troubleshoot it

## Start / stop

```sh
node bin/cli.mjs serve            # foreground
node bin/cli.mjs service-status   # is it up?
node bin/cli.mjs doctor           # full diagnosis
```

A `SessionStart` hook starts the endpoint automatically and verifies it came up.
If it could not, it says so with the command to run — it never claims success on
the strength of a spawn call alone.

## Why a local service

ZCode's plugin API cannot register an LLM provider, and DSH's can. Rather than
reimplementing the model plumbing against a capability that does not exist, the
original's loopback OpenAI-compatible shim became a standalone service, and
ZCode's own third-party-model support points at it. See
`docs/adr/0001-loopback-provider-for-zcode.md`.

## Files

| Path | Role |
|---|---|
| `.zcode-plugin/plugin.json` | manifest: skills + the `SessionStart` hook |
| `skills/workbuddy-models/SKILL.md` | operating and troubleshooting skill |
| `hooks/service-ensure.mjs` | self-verifying endpoint starter |
| `src/upstream.js` | WorkBuddy wire client |
| `src/auth.js` | credential discovery and refresh |
| `src/catalog.js` | model roster (+ static fallback) |
| `src/server.js` | the endpoint |
| `src/loopback.js` | Host/Origin guards |
| `src/client-identity.js`, `src/app-version.js` | desktop-shaped chat identity |
| `src/config.js` | runtime paths |
| `src/cli.js`, `bin/cli.mjs` | CLI |

Upstream: <https://github.com/corrinehu/dsh-workbuddy-connect>