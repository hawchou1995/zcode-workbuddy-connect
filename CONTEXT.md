# zcode-workbuddy-connect

**WorkBuddy** — the models in the WorkBuddy desktop app, exposed to ZCode as
OpenAI-compatible model providers. A port of
`corrinehu/dsh-workbuddy-connect` (MIT) from the DeepSeek Harness plugin API to
ZCode's.

- **Provider entries**: `workbuddy` (CN, root mount) and `workbuddy-ai`
  (international, `/ai` mount) in `%USERPROFILE%\.zcode\v2\provider_config.json`
- **Endpoint**: `http://127.0.0.1:39271/v1` (CN) and
  `http://127.0.0.1:39271/ai/v1` (WorkBuddy AI) — loopback only
- **State**: `%USERPROFILE%\.zcode-workbuddy-connect\`
- **Roster**: 36 models across two regions — CN (16, root mount): GLM-5.3 /
  5.3-Flash / 5.2 / 5.1 / 5v-Turbo, DeepSeek-V4-Pro / V4.1-Flash, Kimi-K3-1 /
  K2.8-Preview / K2.7 / K2.6, MiniMax-M3, Hy4-preview / Hy3 (free) / Hy3-X,
  Auto; AI (20, `/ai` mount): GPT-5.6 Sol / Terra / Luna, GPT-5.5 / 5.4,
  GPT-6-Astra, Gemini-3.5-Flash, GLM-5.3 / 5.2, Kimi-K3 / K2.8-Preview / K2.6,
  DeepSeek-V4.1-Flash (free), Hy4-preview / Hy3 (free), Auto / Fast / Balanced /
  Primary / Deep. Both mounts use the upstream ids verbatim.
- **Skill**: `workbuddy-models` — how to operate and troubleshoot it

## Glossary

Terms that are easy to conflate in this project, and what each one means here.

**Region** — which WorkBuddy backend a credential belongs to. `cn` for the
domestic app, `global` for the international one ("WorkBuddy AI"). Chosen from
the credential's `domain`, not from configuration. The two share seven model ids
(`glm-5.3`, `glm-5.2`, `hy3`, `hy4-preview`, `deepseek-v4.1-flash`,
`kimi-k2.8-preview`, `kimi-k2.6`) with different windows and rates, so a region
is part of a request's identity, never an incidental attribute.

**Mount** — the URL path segment that selects a region on this endpoint: the
root for CN, `/ai` for international. This is the *only* channel a client has
for naming a region, because ZCode sends no provider identifier of any kind (no
header, no query parameter, no body field) and never calls `/models` to learn a
roster. See `docs/adr/0003-region-by-url-path.md`.

**Model id** — always the bare upstream id (`glm-5.3`), never region-prefixed.
The same bare id legitimately appears under both providers; ZCode's picker
groups rows under a provider header and renders the raw id as the row text, so
the duplication is unambiguous to the user and the id stays readable. A leading
`wbai:` is still *accepted* on a chat request for back-compatibility (and wins
over the mount), but nothing emits it anymore.

**Context window** — the widest prompt the model accepts, from the upstream's
`maxInputTokens`. Deliberately **not** the upstream's `contextWindow.defaultLength`,
which is a softer tier the UI offers and can be up to 3.3× smaller; declaring
that one makes ZCode compact the conversation early and waste the window. See
`docs/adr/0002-widest-window-and-output-ceiling.md`.

**Output ceiling** — the largest output budget a user may select for a model,
written to ZCode as `optionSpecs.maxOutputTokens.max`. Not a wire parameter:
the actual `max_completion_tokens` sent upstream comes from the built-in API
rule's expression, and this value only bounds what ZCode will let the user pick.
There is no `maxTokens` property, and adding one costs the entire provider
config (below).

**Strict schema** — the zod schema ZCode parses `provider_config.json` with, in
which every rule object is `.strict()`. One unrecognised key fails the whole
document, and ZCode's failure mode is to discard **all** personal providers and
start empty, with no error shown. This is why `setup` validates through
`docs/validate-provider-config.mjs` before the write lands.

**Credential copy** — this service's own token store under the state directory.
The WorkBuddy desktop app's sign-in file is *read-only* input; refreshes are
written only to the copy, so the plugin can never break the app's login.
Identity beats expiry when the two disagree, because the copy may still belong
to a previously signed-in account.

**Endpoint bearer** — the secret ZCode presents to the loopback endpoint, held
in `endpoint.json` (mode 0600). Distinct from the WorkBuddy credential: it never
travels upstream, and it must be *stable* rather than per-process because ZCode
records it in its own config.

**At-rest envelope** — how WorkBuddy 5.6+ stores the two token fields in the
desktop auth file: a `{$wbEncrypted:1, envelope}` wrapper opened with
AES-256-GCM, under a key derived from the app's own `atRestSecretKey`. The key
is in neither the file nor this plugin's process. See
`docs/adr/0004-workbuddy-56-at-rest-credentials.md`.

**Key helper** — the app's own Electron binary, run once as plain Node
(`ELECTRON_RUN_AS_NODE=1`) and asked for the private `workbuddyStorage`
binding's payload. Resolved from a platform default, macOS Spotlight (CN only)
or `WORKBUDDY_ELECTRON_BIN`; never from a search that could run the other
product's binary.

**Desktop auth format** — `absent` / `plaintext` / `encrypted` /
`unrecognized`, as `doctor` reports it. `encrypted` is the healthy state of a
current install, not an error. `unrecognized` is the one that must fail loudly:
the desktop file outranks the plugin-owned copy wherever it exists.


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
| `src/desktop-credential-protection.js` | 5.6 at-rest envelope classification, key resolution, field decryption |
| `src/catalog.js` | model roster (+ static fallback) |
| `src/server.js` | the endpoint |
| `src/loopback.js` | Host/Origin guards |
| `src/client-identity.js`, `src/app-version.js` | desktop-shaped chat identity |
| `src/config.js` | runtime paths |
| `src/cli.js`, `bin/cli.mjs` | CLI |
| `tests/` | `node --test` suites: envelope crypto, credential integration, platform defaults, Spotlight discovery |
| `docs/validate-provider-config.mjs` | strict-schema mirror; gates every `setup` write |
| `docs/verify-endpoint.mjs` | end-to-end check against a live endpoint |
| `docs/adr/0001-…` | why a loopback provider rather than a plugin/MCP server |
| `docs/adr/0002-…` | widest window + output ceiling, and the strict-schema trap |
| `docs/adr/0003-…` | region by URL path, not by an id prefix |
| `docs/adr/0004-…` | WorkBuddy 5.6 at-rest envelopes, the key helper, and the discovery policy |

Upstream: <https://github.com/corrinehu/dsh-workbuddy-connect>

## Limits written into ZCode

`setup` declares both limits per model, taking the maximum of what the upstream
admits: `properties.contextWindow` from `maxInputTokens` (not the softer
`defaultLength`) and `optionSpecs.maxOutputTokens.max` from the upstream's own
`maxOutputTokens`. `serve` reports the same window through `/v1/models`.

Because ZCode's rule schema is strict and a stray key discards the *entire*
provider config, `setup` writes to a temp file, runs
`node docs/validate-provider-config.mjs`, and only renames it into place if the
document passes. Run that validator by hand after any manual edit.
