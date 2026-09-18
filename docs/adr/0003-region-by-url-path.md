# ADR 0003 — Separate the regions by URL path, not by an id prefix

Status: accepted (2026-09-18)

## Context

The two WorkBuddy regions share **seven** model ids with different windows and
rates: `glm-5.3`, `glm-5.2`, `hy3`, `hy4-preview`, `deepseek-v4.1-flash`,
`kimi-k2.8-preview`, `kimi-k2.6`. One id therefore cannot stand for both, and
something has to distinguish them.

The original port did it by renaming: international models were exposed as
`wbai:glm-5.3`. That prefix did two jobs at once — routing a chat request to the
right credential store, and keeping the two rows apart.

It also leaked into the one place it hurts most. Reading ZCode's renderer out of
`resources/app.asar` shows the model picker rows render `e.name`, which is the
**raw model id and nothing else**:

```js
// styles-ou2or4Yg.js, model-row renderer
jsx('span', { className: `min-w-0 truncate`, title: e.name, children: e.name })
```

So `wbai:` was not an internal wire detail; it was literally the text the user
read in the model list.

The same investigation settled what alternatives exist:

- **The picker groups by provider.** Each provider contributes a submenu whose
  header is `providerName`, so `glm-5.3` under "WorkBuddy" and `glm-5.3` under
  "WorkBuddy AI" are already unambiguous, and the closed trigger even shows
  `WorkBuddy/glm-5.3`.
- **There is no display-name mechanism.** The personal-provider schema is
  `.strict()` with no `name`/`displayName`/`label`/`alias` key, and the
  `settings.modelProvider.modelDisplayName` i18n string has zero references
  outside its own dictionary — dead UI. A model cannot be given a friendlier
  label.
- **Identity is `(providerId, modelId)`.** Cross-provider id collisions are
  legal and preserved; nothing suffixes or renames ids.
- **ZCode sends no provider identifier.** No header, no query parameter, no body
  field names the provider, and it never calls `/models` to learn the roster.
  The baseUrl is used essentially verbatim (`<baseUrl>/chat/completions`, with
  one trailing slash trimmed).

## Decision

Route by **URL path**, and leave the model ids bare.

```
CN             http://127.0.0.1:39271/v1/chat/completions
International  http://127.0.0.1:39271/ai/v1/chat/completions
```

`setup` writes one provider per region with its own `baseUrl` and its own bare
`modelIds`. The endpoint resolves the variant from the request path
(`routePath`), so `/v1/models` lists only the CN roster and `/ai/v1/models` only
the international one — each client sees 16 or 20 bare ids rather than a union
of 36.

A leading `wbai:` on a model id is still accepted and still selects the
international store, so a client configured the old way keeps working; the
prefix is stripped before the body goes upstream. `setup` also retires leftover
`wbai:`-prefixed model rules from the user's document, since they name models
that no longer exist under that spelling.

## Consequences

**Gained.** The model list reads as model names again. The region is a property
of the *connection*, which is where the user configures it, rather than of the
*name*, which only the display consumed.

**Cost.** Two baseUrls instead of one — a client that hard-codes `/v1` for
everything reaches only the CN region. Accepted because the only such client is
`setup` itself, which writes both, and the `wbai:` fallback covers hand-written
configs.

**Not a compatibility break for ZCode.** It has no notion of a shared endpoint
between providers; two providers pointing at two paths is the ordinary shape.

## Alternatives rejected

- **`api.headers` on each provider rule** — this would be the tidiest signal,
  but it cannot be trusted to reach the upstream client: the header set is
  assembled through several merge layers (`kEt`, `qVr`, `gN6`), and on a
  `127.0.0.1` baseUrl some of them are skipped entirely. Path routing depends on
  none of that.
- **The `Authorization` bearer** — ZCode does send it, but both providers share
  one endpoint bearer by design; giving each its own would mean two secrets to
  rotate and would still leave the regions indistinguishable to any other
  client.
- **Renaming one region's ids** (the status quo) — the only place the id is ever
  read by a human is the picker, so the cost lands entirely on the user and the
  benefit is zero.
- **One provider listing all 36 ids** — impossible: ZCode's `personalModelIds`
  is a flat list, and the two `glm-5.3` entries would collide within a single
  provider (the schema allows only one rule per provider+model).
