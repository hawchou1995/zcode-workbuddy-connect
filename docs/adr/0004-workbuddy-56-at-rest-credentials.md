# ADR 0004 — Read a 5.6 sign-in by opening its at-rest envelopes

Status: accepted (2026-09-25)

## Context

Since WorkBuddy 5.6 the desktop app no longer writes its sign-in as plain JSON.
`auth.accessToken` and `auth.refreshToken` arrive as `{$wbEncrypted:1, envelope}`
wrappers (`buildPolicy: "fields"`, on by default), each sealed with AES-256-GCM
under a per-machine at-rest key. The plugin's credential path had been "read the
file, parse the JSON, take the token", so on a current install it read two
objects where it expected two strings — and the desktop file is the identity
authority for the region, so a file the plugin cannot read is a signed-out state
it cannot even explain.

Nothing in the plugin's own process can open those envelopes. The at-rest key is
delivered by the app's Electron-modified runtime through a private binding,
`process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`, which
returns `{version:1, atRestSecretKey}` — and that binding does not exist in
ZCode's stock Node, where this plugin runs. The format and its failure modes were
established from the app bundle and from upstream's issue reports (#39/#40 in
`corrinehu/dsh-workbuddy-connect`); the authenticated-context AAD is a
transcription of the app's own `buildAuthenticatedContextAad`.

## Decision

**Classify the document before parsing it.** `classifyDesktopAuthDocument`
returns `absent`, `plaintext`, `encrypted` or `unrecognized`. A plaintext
document keeps going through the parser it always did, so the ordinary path is
unchanged. An encrypted document is *opened*, never skipped. An unrecognized one
fails loudly and names the path, because the desktop file outranks the
plugin-owned copy wherever it exists: quietly preferring the copy would let a
stale account sign the user in. An empty file is the one case that falls through
to the next candidate — an empty file cannot be authoritative about anything.

**Open envelopes by running the app's own binary once as Node.** The helper is
spawned as `<Electron> -e` with the one-line binding read and
`ELECTRON_RUN_AS_NODE=1`, and only the payload reaches stdout. The plugin never
copies the app's runtime, never patches it, and never starts it as a GUI.

**Derive the protector key with `sha256(atRestSecretKey, utf8)`**, cache it in
memory only, single-flight, and key that cache by the derived key's own id
(`sha256` of the key, first 16 hex characters). An envelope naming a different id
re-resolves the payload once: an app update or a fresh sign-in reseals the file,
and a stale key must never be used against a fresh envelope.

**Transcribe the AAD instead of guessing at it.** The `WB-AAD\0` prefix, the
`WBEV1` framing under `sym-v1`, the suite number, the length-prefixed key id and
the trailing context bytes are all constants of the app's own builder. Credential
fields are always suite 1 under the field framing; the neighbouring framings
(`WBEF1`/`WBER1`/`WBES1`) belong to other document kinds and are deliberately
left unimplemented — opening a credential is not a place to guess at a format.

**Auto-discover one product, on the platforms where it was verified.** The CN
app gets a platform default on Windows and macOS, and on macOS a Spotlight search
by bundle id that *proves* identity — a candidate declaring a different bundle id
is excluded, several Spotlight rows for one bundle collapse via realpath, a row
that is provably gone is skipped, and anything that could not be checked is
reported as incomplete rather than as "the app is missing". More than one
survivor is an error, not a coin toss. Everything else — Linux, and the
international app off Windows — gets `WORKBUDDY_ELECTRON_BIN` only, and a missing
binary there is reported as "not configured", never as "searched and failed".

This is a **deliberate deviation from upstream**, which refuses static
candidates. The refusal fits macOS, where a real discovery mechanism exists; it
does not transfer to Windows, which has none, and where the only alternative to a
static default is asking the user for an env var to run their own installed app.
The two Windows defaults are the app's own install directories and were verified
live.

**Never let a secret out, and never let one into a log.** The payload, the key
and the tokens are used in memory and written nowhere new. Error text carries
sizes, key ids and exit codes only — deliberately not helper stdout or stderr,
which can hold paths or crash dumps.

## Consequences

**Gained.** A current WorkBuddy install works with no configuration on Windows
and macOS (CN). When it cannot work, the diagnosis is specific: a signed-out
state carries a `reasonCode` (`encrypted-credential-unreadable`,
`electron-binary-not-found`, `electron-binary-ambiguous`,
`electron-binary-unavailable`, `electron-discovery-incomplete`,
`electron-path-invalid`), and `doctor` prints the file's format, the binary the
unlock would use, and whether that binary exists — all without spawning or
decrypting anything for the report itself.

**Cost.** The plugin executes a foreign binary. It is the app's own, from a path
that names exactly one product, and only ever with `ELECTRON_RUN_AS_NODE=1`, so
no GUI or app code path runs; but the capability is real, and it is bounded by
refusing every location that has not been verified rather than by adding
fallbacks.

**Cost.** The desktop file can now be a hard failure where it used to be
invisible: a sealed file this plugin cannot open reports "fix or remove the
file" instead of silently falling back. That is intended — the alternative is
signing the user in as whoever the plugin-owned copy last belonged to.

## Alternatives rejected

- **Read the token fields as opaque objects** (what a naive port does) — the
  install is healthy and the plugin says signed-out. Useless.
- **Reimplement the binding in ZCode's Node** — the key material is produced by
  the app's modified runtime; there is nothing to reimplement outside it.
- **Read a DPAPI/Keychain secret directly** — the at-rest key is not held by the
  OS credential store; it is delivered through the app's binding.
- **Search the filesystem for any WorkBuddy install** — executing an
  unidentified binary is not something a credential reader should do on a guess.
  Upstream's refusal is kept everywhere the layout has not been verified live.
- **Copy the decrypted tokens into the plugin-owned store and be done** — that
  copy exists for refresh continuity, not as a second authority, and putting the
  token in a second place on disk buys nothing the envelope open does not.
