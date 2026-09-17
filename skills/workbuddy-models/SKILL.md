---
name: workbuddy-models
description: Operate the WorkBuddy model provider — start/stop the local endpoint, check sign-in and remaining credit, list or refresh the model roster, and troubleshoot "model fails to respond" errors. Use when the user asks about WorkBuddy models in ZCode, the provider shows no models, a WorkBuddy model errors out, credit balance, or the login state of the WorkBuddy desktop app.
when_to_use: The user mentions WorkBuddy, the WorkBuddy provider, a WorkBuddy model (GLM-5.3, DeepSeek-V4-Pro, Kimi-K3, MiniMax-M3, Hy3, GLM-5v-Turbo), or reports that a model from this provider fails.
---

# WorkBuddy models in ZCode

This plugin exposes the models inside the **WorkBuddy desktop app** (CN) as a
ZCode model provider. The desktop app's models are reachable only with the app's
own login, and only through an internal API that rejects ordinary OpenAI
clients, so a small local service translates between the two:

```
ZCode ──(OpenAI chat-completions)──▶ 127.0.0.1:39271 ──▶ copilot.tencent.com
                                       local endpoint        (WorkBuddy)
```

The service reads the WorkBuddy desktop app's sign-in file (read-only), refreshes
tokens into its own state directory, and runs the model roster as a provider.
Everything lives outside the app: nothing here writes to WorkBuddy's files.

## Where things are

| Thing | Path |
|---|---|
| Service + CLI | `${ZCODE_PLUGIN_ROOT}` |
| State (token copy, endpoint bearer, logs) | `%USERPROFILE%\.workbuddy-connect` |
| Provider entry | `%USERPROFILE%\.zcode\v2\provider_config.json` |
| WorkBuddy sign-in (read-only) | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |

All CLI commands below are run as `node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" <command>`.

## The one thing that usually matters

The provider only works while the local endpoint is running. A `SessionStart`
hook starts it automatically, but a locked-down host can refuse a detached
spawn, so the first check for any "model not responding" report is always:

```sh
node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" service-status
```

- **`endpoint … up (N models)`** — the service is fine; look elsewhere.
- **`endpoint … NOT reachable`** — start it in a terminal:
  `node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" serve`

## Commands

| Command | What it does |
|---|---|
| `serve` | Run the endpoint in the foreground (`--port` to change, default 39271) |
| `service-status` | Is the endpoint reachable; is autostart registered |
| `status` | Sign-in state, token expiry, remaining credit, the whole model roster |
| `refresh` | Re-pull the model roster from the upstream |
| `doctor` | Credentials, upstream reachability, catalog, credit — for diagnosis |
| `setup` | Rewrite the ZCode provider entry from the live roster |
| `install-service` / `uninstall-service` | Register/remove a logon autostart launcher |
| `logout` | Drop the service's own token copy (the desktop app is untouched) |

## Diagnosing a failure

Work through these in order; each one is cheap and they are ordered by how often
they are the cause.

1. **Is the endpoint up?** `service-status`. If not reachable, start it.
2. **Is WorkBuddy still signed in?** `doctor`. The desktop app's token expires;
   when it does, the fix is to open the WorkBuddy app once. The plugin cannot
   sign in on the user's behalf and must never be asked to.
3. **Does the model still exist?** `refresh` then `status`. The upstream roster
   changes often — models appear and disappear — so a model that worked last
   month may simply be gone.
4. **Is there credit left?** `status` prints the remaining credit and any
   promotional badges. `402` from the endpoint means insufficient credit, and no
   local fix exists.
5. **Read the log.** `%USERPROFILE%\.workbuddy-connect\service.log` records hook
   and startup decisions; the running service also prints to its console.

## Boundaries — do not cross these

- **Never write to the WorkBuddy desktop app's own files.** The sign-in file is
  read-only input. Token refreshes go to
  `%USERPROFILE%\.workbuddy-connect\.workbuddy-auth.json` and nowhere else; that
  separation is what stops this plugin from breaking the desktop app's login.
- **Never ask for or handle the user's WorkBuddy password.** The plugin reuses
  the desktop app's existing session by design; there is no credential to type.
- **Do not hand-edit the token** in `endpoint.json` while the service is running
  — the service holds the bearer in memory from startup, so a hand-edited value
  will not match and every request will 401. Change it with `--token` and
  restart, or delete `endpoint.json` and let it regenerate.
- **Do not "fix" a missing model by adding it to the provider config by hand.**
  Run `setup`: it writes the roster the upstream actually reports, including the
  per-model context window and vision flags.

## Notes on behaviour worth knowing

- **Reasoning models think for a long time before their first token.** The
  endpoint emits SSE heartbeat comments during that silence so the connection
  and the client's read timeout survive it. A long pause before the first word
  is normal, not a hang.
- **Tool calls are repaired in transit.** The upstream streams tool-call
  fragments in an unusual shape (the id and function name ride on the first
  fragment only, and the finish event repeats). The endpoint reassembles them,
  so a client sees one clean `tool_calls` array.
- **Prices are informational.** Rates come from the upstream roster and are
  cached; a promotion that expires is dropped rather than left claiming a
  discount. `rateUnknown` means the cached rate can no longer be trusted.