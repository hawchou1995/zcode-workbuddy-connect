# ADR 0002 — Declare the widest context window, and cap output via `optionSpecs`

Status: accepted (2026-09-18)

## Context

The port must register each WorkBuddy model with ZCode carrying its real limits.
Two limits matter, and the second one has a trap in it.

**Context window.** The upstream catalog reports two different numbers: a soft
`contextWindow.defaultLength` (300 000 for many models) and the hard
`maxInputTokens` (1 000 000 for those same models). It also occasionally ships
`contextWindow.supportedLengths`, a list of selectable tiers whose maximum
equals `maxInputTokens`.

Declaring the soft default makes ZCode compact the conversation far earlier
than the model can actually accept, wasting most of the window. A live probe
confirmed the hard number is the honest one: a 312 856-token prompt was
accepted while 1 294 869 tokens was rejected with "> 1048576 maximum".

**Output ceiling.** ZCode's provider schema lives only as compiled zod inside
`ZCode\resources\app.asar` (there is no JSON Schema file shipped). Reading that
schema out of `out/host/index.js` shows the rule object is `.strict()`, and the
two writable paths are:

```
config.properties   { contextWindow, inputFormat.{supportsImage,Video,Pdf},
                      supportsToolCall, supportsJsonSchemaOutput,
                      supportsNativeWebSearch, supportsMidConversationSystem,
                      requiresMfjsToolSchema }
config.optionSpecs  { reasoningLevel:{values,map}, maxOutputTokens:{max,map} }
```

There is **no `maxTokens` property**. An output limit belongs in
`optionSpecs.maxOutputTokens.max`, which is the ceiling ZCode enforces on the
value a user may select — the CLI throws "maxOutputTokens is outside the model
option range" above it.

The trap: because the schema is strict and ZCode's failure mode is to discard
the **entire** personal provider config and fall back to an empty one, a single
unrecognised key does not break one model — it silently removes every provider
the user had (OpenRouter, DeepSeek, …), with nothing surfaced anywhere.

## Decision

Take the **maximum** for both limits, and write them through the two paths the
schema actually accepts.

- `properties.contextWindow` = `max(contextWindow, ...supportedContextWindows)`
  — the widest window the upstream admits.
- `optionSpecs.maxOutputTokens.max` = the upstream's own `maxOutputTokens`,
  taken per model rather than guessed. `map` is **omitted**: the shipped
  `openai-chat-completions` API rule already supplies
  `{'max_completion_tokens': maxOutputTokens}`, and a hand-written expression
  with a typo in the option-map mini-language would fail validation and take the
  whole document down with it.

Both are gated behind a new `docs/validate-provider-config.mjs`, which mirrors
the strict schema and now runs on every `setup` write: the document is
serialised to a temp file, validated, and only then renamed over the real path.
A rejected document is never written and the offending key is printed.

`serve` applies the same intent to `/v1/models` via the catalogue's
`useMaximumContextWindow` switch, which had existed in `catalog.js` but was
never wired to anything. `--default-context-window` restores the softer number.

## Consequences

**Gained.** ZCode plans against the real window instead of the conservative
one, and the output-budget control is bounded by what the model can actually
produce. All 36 models carry both values (verified: 0 rules missing
`maxOutputTokens`).

**A latent defect fixed.** The `setup` template for a *missing* config file
contained a `provider: []` key that is not in the schema — writing it produced a
document ZCode would discard wholesale. Found by the new validator on its first
run against a throwaway path.

**A host policy recorded, not worked around.** `install-service` writes its
launcher to the Startup folder, and this host refuses script files there
(`.vbs`, `.cmd`, `.bat`, `.ps1` all return `EPERM` while `.txt` in the same
folder succeeds). That is a deliberate security control, so the command now
reports it plainly and points at the `SessionStart` hook — which is the path
that actually starts the endpoint, and was verified to bring it up from a cold
stop.

## Alternatives rejected

- **Writing `properties.maxTokens`** — not in the schema; this is the exact
  mistake the original comment warned about, and it costs the whole document.
- **Supplying `optionSpecs.maxOutputTokens.map` as well** — redundant against
  the built-in API rule, and adds an expression-language failure mode for no
  gain.
- **Trusting `contextWindow.defaultLength`** — understates the window by up to
  3.3× and makes the agent compact early.
- **Validating in-process instead of via a subprocess** — the validator is
  meant to be runnable by hand for diagnosis; a copy that could drift from the
  schema mirror would be worse than none.
