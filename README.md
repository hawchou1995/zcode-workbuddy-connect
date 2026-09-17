# workbuddy-connect

Use the models inside the **WorkBuddy desktop app** from ZCode (or any
OpenAI-compatible client), with zero configuration.

A port of [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
(MIT) from the DeepSeek Harness plugin API to ZCode's, keeping the original's
wire behaviour and discarding the parts that have no ZCode equivalent.

```
ZCode ──(OpenAI chat-completions)──▶ 127.0.0.1:39271 ──▶ copilot.tencent.com
                                       local endpoint        (WorkBuddy)
```

## Why this shape

The upstream plugin registered models into DSH's own provider registry and drew
a settings card in DSH's UI. ZCode has **no "register an LLM provider" plugin
slot**, so a literal port is impossible. What ZCode *does* have is native
support for third-party models configured as
`api.type: "openai-chat-completions"` with a `baseUrl` and API key — and the
original plugin already contained a loopback OpenAI-compatible shim
(`src/shim.ts`). Extracting that shim into a standalone service and pointing a
ZCode provider at it yields something the original could not give: the models
appear as first-class entries in ZCode's model selector, driving the normal agent
loop with tool calls, images and streaming.

The discarded parts are the ones with no ZCode surface: the settings card, the
Composer probe control, and the reasoning-level detection feature. Reasoning
levels now use the efforts the upstream catalog declares, with no probing
requests (which would have consumed credit with nowhere to show the result).

## Layout

```
.zcode-plugin/plugin.json      plugin manifest (skills + SessionStart hook)
skills/workbuddy-models/       operational skill for the agent
hooks/service-ensure.mjs       starts the endpoint at session start
src/                           the service (no dependencies; Node >= 18)
  upstream.js                  WorkBuddy wire client: chat, refresh, catalog, billing
  auth.js                      reads the desktop app's sign-in; refreshes into our own copy
  catalog.js                   model roster + static fallback
  server.js                    the loopback OpenAI-compatible endpoint
  loopback.js                  Host/Origin guards
  client-identity.js           desktop-shaped chat User-Agent
  app-version.js               installed-App version resolution
  config.js                    runtime paths
  cli.js                       command-line interface
bin/cli.mjs                    entry point
```

## Commands

```sh
node bin/cli.mjs serve              # run the endpoint (foreground)
node bin/cli.mjs status             # sign-in, credit, model roster
node bin/cli.mjs doctor             # diagnose credentials/upstream/endpoint
node bin/cli.mjs refresh            # re-pull the roster
node bin/cli.mjs setup              # (re)write the ZCode provider entry
node bin/cli.mjs service-status     # is it reachable; is autostart registered
node bin/cli.mjs install-service    # register a logon autostart launcher
node bin/cli.mjs uninstall-service  # remove it
node bin/cli.mjs logout             # drop our token copy (desktop app untouched)
node bin/cli.mjs token              # print the endpoint bearer
```

## Install

1. Put this directory anywhere and add its **path** to ZCode's
   `plugins.dirs` in `%USERPROFILE%\.zcode\cli\config.json`:

   ```json
   { "plugins": { "dirs": ["<absolute-path-to-this-repo>"] } }
   ```

   Plugins found this way get the marketplace id `inline` and are enabled by
   default. The listed directory **is** the plugin root — do not nest it.

2. Write the provider entry:

   ```sh
   node bin/cli.mjs setup
   ```

3. Restart ZCode. The `SessionStart` hook starts the endpoint; the models appear
   in the model selector under **WorkBuddy**.

`setup` refuses to guess: it writes the roster the upstream actually reports,
including each model's real context window and vision support.

## Design decisions

| Decision | Why |
|---|---|
| Standalone loopback service, not an MCP server | An MCP tool cannot drive ZCode's agent loop; a provider can. Native streaming, tool calls and images come for free. |
| Zero runtime dependencies | Node 18+ has `fetch`, `AbortSignal.timeout` and `http`. Fewer moving parts to break, and no install step. |
| CN variant only | This machine has only the CN app installed. The region gate is retained, so adding the international variant is a data change, not a refactor. |
| Fixed port + persisted bearer | The client records the bearer in its own config, so it must survive restarts. A per-process secret would break on every restart. |
| Credential copy kept separate from the desktop app | The app's sign-in file is read-only input. Refreshes go to our own state dir, so the plugin can never break the app's login. |
| Startup folder for autostart | `schtasks` needs elevation on this host (it fails outright); the Startup folder is per-user and needs none. |
| Heartbeats during silence | Reasoning models think for minutes; the upstream pads that with SSE comments. Dropping them (as the first port did) leaves the client seeing zero bytes and timing out on a working request. |

## Notes

- **Never write to WorkBuddy's own files.** The sign-in file is input only.
- **No credential ever reaches ZCode's config** other than the local endpoint's
  own bearer. The WorkBuddy token stays in the state directory, in memory, or on
  the wire to WorkBuddy.
- **Prices are informational.** Rates come from the upstream roster and are
  cached; an expired promotion is dropped (`rateUnknown`) rather than left
  claiming a discount.
- State lives in `%USERPROFILE%\.workbuddy-connect\`
  (`WORKBUDDY_CONNECT_HOME` overrides it).

## A note on what this talks to

The endpoint forwards to WorkBuddy's own internal API (`copilot.tencent.com`),
using the WorkBuddy desktop app's existing login. That API is **undocumented and
unofficial** — it is not a public integration surface, and it can change or break
without notice. This project therefore:

- makes **no stability promise** on the wire format, and
- inherits any terms the WorkBuddy service imposes on its own client.

It reads only the app's own sign-in file, never writes to it, and reuses session
the user already established — there is no bypass, no credential harvesting, and no
traffic to any host the desktop app does not already talk to. Use it with your own
account. This is a port of a project that already does the same thing publicly; the
caveats above are the original's, restated because they matter more than the
feature list.

**Never committed:** the credential copy, the endpoint bearer, and all runtime
state. See `.gitignore` — state lives in `%USERPROFILE%\.workbuddy-connect\`, and
`endpoint.json` there holds a bearer that would let a reader call *your* endpoint.

## Licence

MIT, following the original. The wire behaviour is itself ported by the original
project from [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT).