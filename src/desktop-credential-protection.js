/**
 * WorkBuddy 5.6.x at-rest credential protection: classification, key
 * resolution, and field decryption for the desktop app's encrypted auth file.
 *
 * Since WorkBuddy 5.6 the desktop app encrypts `auth.accessToken` and
 * `auth.refreshToken` at rest (`buildPolicy: "fields"`, on by default), so the
 * plugin reads `{$wbEncrypted:1, envelope}` wrappers instead of token strings
 * (issues #39/#40 upstream). Everything needed to open them lives on the same
 * machine:
 *
 * - the sealed payload (`{version:1, atRestSecretKey}`) comes from the
 *   WorkBuddy-modified Electron's private `workbuddyStorage` binding, reached
 *   by running *its own* binary once with `ELECTRON_RUN_AS_NODE=1`;
 * - `protectorKey = sha256(atRestSecretKey, utf8)` opens the envelopes with
 *   AES-256-GCM; the AAD builder below is transcribed from the app's own
 *   `buildAuthenticatedContextAad` (verified live against 5.6.2 by the
 *   upstream author, and re-verified end to end on Windows against 5.6.2 by
 *   this port).
 *
 * The plugin process itself can never call `_linkedBinding` (it runs in
 * ZCode's Node, not the forked Electron), so the helper is spawned. The key is
 * cached in memory only, single-flight, and re-resolved when an envelope names
 * a different key id. Neither the payload, the key, nor any token is ever
 * logged; error messages carry sizes, ids, and exit codes only.
 *
 * @module zcode-workbuddy-connect/desktop-credential-protection
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

/**
 * Env variable that overrides the WorkBuddy Electron binary used as the key helper.
 * @type {'WORKBUDDY_ELECTRON_BIN'}
 */
export const WORKBUDDY_ELECTRON_BIN_ENV = 'WORKBUDDY_ELECTRON_BIN'

/**
 * Reason codes a signed-out state can carry. The code travels with the error
 * so the caller can promote it to a `reasonCode` without re-deriving the cause
 * from prose. Mirrors the upstream `WorkBuddySignedOutReasonCode` set.
 * @type {readonly string[]}
 */
export const WORKBUDDY_SIGNED_OUT_REASON_CODES = [
  'no-credential',
  'credential-region-mismatch',
  'encrypted-credential-unreadable',
  'electron-binary-not-found',
  'electron-binary-ambiguous',
  'electron-binary-unavailable',
  'electron-path-invalid',
  'electron-discovery-incomplete',
]

/** The four states a desktop auth document can be read as. */
export const DESKTOP_AUTH_FORMATS = ['absent', 'plaintext', 'encrypted', 'unrecognized']

/** Platform-default Electron binary for the CN app, confirmed only on macOS (5.6.2). */
const MACOS_CN_ELECTRON_PATH = '/Applications/WorkBuddy.app/Contents/MacOS/Electron'

/**
 * Windows install locations for the two products. The desktop app ships a
 * per-product directory under `C:\Program Files`, and the binary at its root is
 * the very Electron the app runs on — the same one the upstream macOS default
 * points at.
 *
 * DEVIATION FROM UPSTREAM (deliberate, documented in the goal contract):
 * upstream refuses to guess app locations because on macOS it has a real
 * discovery mechanism (Spotlight by bundle id) and a policy against static
 * candidates. Neither applies here: there is no Windows discovery mechanism in
 * upstream at all, so on Windows the only way to open an encrypted credential
 * is a static default or `WORKBUDDY_ELECTRON_BIN`. These two paths were verified
 * live on this machine (the helper returns `{version:1, atRestSecretKey}` from
 * each). They are not a search — a wrong product is never selected, because the
 * path names one product, and every failure is reported rather than retried
 * against the other product's binary.
 */
const WINDOWS_ELECTRON_RELATIVE_PATHS = {
  cn: ['WorkBuddy', 'WorkBuddy.exe'],
  ai: ['WorkBuddyAI', 'WorkBuddyAI.exe'],
}

/** The variant ids this port knows about. */
const VARIANTS = ['cn', 'ai']

/**
 * Platform-default Electron binary candidates for one variant, in probe order.
 *
 * - `cn`: Windows + macOS. macOS keeps the upstream default path (and, with
 *   discovery enabled, Spotlight as the fallback); Windows uses the install
 *   location above.
 * - `ai`: Windows only. On macOS and Linux there is no verified layout, so
 *   nothing is defaulted and `WORKBUDDY_ELECTRON_BIN` stays the only route —
 *   upstream's deliberate `discovery: 'none'` for the international product.
 *
 * @param {string} [variant] `'cn'` | `'ai'`
 * @returns {string[]} zero or more absolute paths, in probe order
 */
export function defaultWorkBuddyElectronPaths(variant = 'cn') {
  if (!VARIANTS.includes(variant)) return []
  if (process.platform === 'win32') {
    const roots = [...new Set([
      process.env['ProgramFiles'],
      process.env['ProgramW6432'],
      'C:\\Program Files',
    ].filter(root => typeof root === 'string' && root !== ''))]
    return roots.map(root => join(root, ...WINDOWS_ELECTRON_RELATIVE_PATHS[variant]))
  }
  if (process.platform === 'darwin') {
    return variant === 'cn' ? [MACOS_CN_ELECTRON_PATH] : []
  }
  return []
}

/**
 * The Electron binary the default helper would use for diagnostics, or
 * `undefined` where no default has been verified on this platform/variant.
 *
 * @param {string} [variant] `'cn'` | `'ai'`
 * @returns {string | undefined}
 */
export function defaultWorkBuddyElectronPath(variant = 'cn') {
  return defaultWorkBuddyElectronPaths(variant)[0]
}

/** Whether any automatic discovery may run for a variant on this platform. */
export function defaultDiscoveryFor(variant) {
  // Only the CN app has a verified layout and a verified credential chain.
  // macOS Spotlight discovery applies only to it; Windows and Linux get no
  // discovery at all (upstream issue #48 §3.6 keeps that scope).
  if (variant === 'cn' && process.platform === 'darwin') return 'macos-workbuddy'
  return 'none'
}

/**
 * Whether a raw value is the 5.6 field wrapper, with its inner envelope
 * decodable. The wrapper is `{$wbEncrypted:1, envelope:<base64 of a JSON
 * {suite,keyId,nonce,authTag,ciphertext>}`; anything claiming the flag whose
 * envelope cannot be decoded makes the whole document unrecognized rather
 * than encrypted, because no key could ever open it.
 *
 * @param {'accessToken'|'refreshToken'} field
 * @param {unknown} value
 * @returns {{ field: 'accessToken'|'refreshToken', envelope: { suite: number, keyId: string, nonce: Buffer, authTag: Buffer, ciphertext: Buffer } } | undefined}
 */
function parseWrappedField(field, value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wrapped = /** @type {Record<string, unknown>} */ (value)
  if (wrapped['$wbEncrypted'] !== 1 || typeof wrapped['envelope'] !== 'string') return undefined
  let inner
  try {
    inner = JSON.parse(Buffer.from(wrapped['envelope'], 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined
  const parts = /** @type {Record<string, unknown>} */ (inner)
  const nonce = parseBase64(parts['nonce'], 12)
  const authTag = parseBase64(parts['authTag'], 16)
  const ciphertext = parseBase64(parts['ciphertext'])
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (typeof parts['suite'] !== 'number' || !Number.isInteger(parts['suite'])) return undefined
  // Suite 1 is the only scheme WorkBuddy 5.6.x defines for credential fields.
  // Anything else is a format this plugin has not seen, so the wrapper is not
  // claimed as encrypted — the document then reads as unrecognized and the
  // store reports a diagnosis instead of attempting a blind open.
  if (parts['suite'] !== 1) return undefined
  if (typeof parts['keyId'] !== 'string' || !/^[0-9a-f]{16}$/u.test(parts['keyId'])) return undefined
  return {
    field,
    envelope: {
      suite: parts['suite'],
      keyId: parts['keyId'],
      nonce,
      authTag,
      ciphertext,
    },
  }
}

/**
 * Decode a base64 value and check its exact byte length when given.
 *
 * @param {unknown} value
 * @param {number} [length]
 * @returns {Buffer | undefined}
 */
function parseBase64(value, length) {
  if (typeof value !== 'string' || value === '') return undefined
  let decoded
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
  // Buffer.from is lenient about stray characters; require the round-trip so a
  // tampered envelope is rejected before any key material is involved.
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined
  return length === undefined || decoded.length === length ? decoded : undefined
}

const AUTH_FIELDS = ['accessToken', 'refreshToken']

/**
 * Read a desktop auth document's format. `absent` is an empty file; `plaintext`
 * is any document the regular parser could read (even one without a token);
 * `encrypted` has at least one field in a decodable wrapper; everything else —
 * unparsable JSON, non-objects, wrappers whose envelope will not decode — is
 * `unrecognized`.
 *
 * @param {string} text
 * @returns {{format: 'absent'} | {format: 'plaintext'} | {format: 'encrypted', wrapped: { document: Record<string, unknown>, fields: { field: string, envelope: { suite: number, keyId: string, nonce: Buffer, authTag: Buffer, ciphertext: Buffer } }[] }} | {format: 'unrecognized'}}
 */
export function classifyDesktopAuthDocument(text) {
  if (text.trim() === '') return { format: 'absent' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { format: 'unrecognized' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { format: 'unrecognized' }
  const document = /** @type {Record<string, unknown>} */ (parsed)
  const auth = typeof document['auth'] === 'object' && document['auth'] !== null
    ? /** @type {Record<string, unknown>} */ (document['auth'])
    : document
  /** @type {{ field: string, envelope: { suite: number, keyId: string, nonce: Buffer, authTag: Buffer, ciphertext: Buffer } }[]} */
  const fields = []
  for (const field of AUTH_FIELDS) {
    const value = auth[field]
    if (typeof value === 'string') continue
    const wrapped = parseWrappedField(/** @type {'accessToken'|'refreshToken'} */ (field), value)
    // A field in *some* object that is not a decodable wrapper: not plaintext,
    // not usable. Treated as unrecognized below unless another field wrapped.
    if (wrapped === undefined && value !== undefined) return { format: 'unrecognized' }
    if (wrapped !== undefined) fields.push(wrapped)
  }
  if (fields.length === 0) return { format: 'plaintext' }
  return { format: 'encrypted', wrapped: { document, fields } }
}

/**
 * Distinct key ids across the wrapped fields, in field order.
 *
 * @param {readonly { envelope: { keyId: string } }[]} fields
 * @returns {string[]}
 */
export function keyIdsOf(fields) {
  return [...new Set(fields.map(wrapped => wrapped.envelope.keyId))]
}

/**
 * Decrypt a wrapped document into the plaintext text the regular parser reads.
 * The caller supplies `openField`; it must return the field's plaintext or
 * throw, because a field that cannot be opened must surface, never pass through
 * as an empty string.
 *
 * @param {{format: 'encrypted', wrapped: { document: Record<string, unknown>, fields: readonly { field: 'accessToken'|'refreshToken' }[] }}} classification
 * @param {(field: { field: 'accessToken'|'refreshToken' }) => string} openField
 * @returns {string}
 */
export function unwrapDesktopAuthDocument(classification, openField) {
  const wrapped = classification.wrapped
  const rebuilt = /** @type {Record<string, unknown>} */ (structuredClone(wrapped.document))
  const auth = typeof rebuilt['auth'] === 'object' && rebuilt['auth'] !== null
    ? /** @type {Record<string, unknown>} */ (rebuilt['auth'])
    : rebuilt
  for (const field of wrapped.fields) {
    auth[field.field] = openField(field)
  }
  return JSON.stringify(rebuilt)
}

/**
 * The authenticated-context AAD for one field envelope, transcribed from the
 * app bundle's `buildAuthenticatedContextAad`. Credential fields are always
 * suite 1 under the `field` framing (WBEV1); the framing family's other
 * members (WBEF1/WBER1/WBES1) belong to other document kinds and are
 * deliberately not implemented — opening a field is not a place to guess at
 * future formats.
 *
 * @param {string} keyId
 * @param {number} suite
 * @returns {Buffer}
 */
export function buildAuthenticatedContextAad(keyId, suite) {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lengthPrefixed = /** @param {string} value */ (value) => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  // No sequence numbers on credential fields; the final byte 0 mirrors the
  // reference script's default context.
  return Buffer.concat([
    prefix, Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/**
 * Open one envelope with a protector key; `undefined` when it will not open.
 * The accepted format is exactly what WorkBuddy 5.6.2 writes — suite 1 under
 * the `field` framing — so a failure means "not this format / wrong key", and
 * is reported as such rather than retried against other framings.
 *
 * @param {Buffer} key
 * @param {{ keyId: string, suite: number, nonce: Buffer, authTag: Buffer, ciphertext: Buffer }} envelope
 * @returns {string | undefined}
 */
export function openAuthField(key, envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Seal one field with the exact format `openAuthField` reads. Test helper — it
 * exists so the round-trip test proves the port against itself and against a
 * transcription of the reference builder, without ever committing a real key.
 *
 * @param {Buffer} key
 * @param {string} plaintext
 * @param {number} [suite]
 * @returns {{ '$wbEncrypted': 1, envelope: string }}
 */
export function sealAuthFieldForTest(key, plaintext, suite = 1) {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAuthenticatedContextAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/**
 * Validate the helper's payload against the app's own rules: `version:1` and
 * a canonical-base64 32-byte, non-all-zero secret. `undefined` otherwise.
 *
 * @param {string} text
 * @returns {{ atRestSecretKey: string } | undefined}
 */
export function parseAtRestPayload(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const payload = /** @type {Record<string, unknown>} */ (parsed)
  if (payload['version'] !== 1) return undefined
  const secret = payload['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') return undefined
  let decoded
  try {
    decoded = Buffer.from(secret, 'base64')
  } catch {
    return undefined
  }
  if (decoded.length !== 32) return undefined
  if (decoded.toString('base64') !== secret) return undefined
  if (decoded.every(byte => byte === 0)) return undefined
  return { atRestSecretKey: secret }
}

/**
 * Derive the protector key from the payload's secret (sha256 over its UTF-8 string).
 *
 * @param {string} secret
 * @returns {Buffer}
 */
export function deriveProtectorKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** The enveloped key id a protector key answers for, exactly as envelopes name it. */
function keyIdOfProtectorKey(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** Absolute tool paths: never resolved through PATH, which a user can change. */
const MDFIND_BIN = '/usr/bin/mdfind'
const PLUTIL_BIN = '/usr/bin/plutil'

/** The CN app's bundle id; the only one this port resolves by discovery. */
export const WORKBUDDY_CN_BUNDLE_ID = 'com.tencent.workbuddy.mac'

/** One discovery subprocess's own limits. */
export const WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS = 3_000
/** Whole-discovery budget, independent of the helper's own timeout. */
export const WORKBUDDY_DISCOVERY_BUDGET_MS = 10_000
const MDFIND_MAX_OUTPUT_BYTES = 1024 * 1024
const PLUTIL_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Why a discovery step could not produce an answer. Every one of these means
 * "we do not know", explicitly *not* "the candidate does not exist" — the
 * distinction is what keeps a half-finished check from being mistaken for a
 * unique candidate.
 */
class DiscoveryIncompleteError extends Error {}

/**
 * A failure the caller must be able to classify. The code travels with the
 * error so the status layer can promote it to `reasonCode` without re-deriving
 * the cause from prose.
 */
export class WorkBuddyElectronPathError extends Error {
  /**
   * @param {string} reasonCode
   * @param {string} message
   */
  constructor(reasonCode, message) {
    super(message)
    this.name = 'WorkBuddyElectronPathError'
    this.reasonCode = reasonCode
  }
}

/**
 * Read the reason code off an arbitrary thrown value, when it carries one.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
export function reasonCodeOf(error) {
  return error instanceof WorkBuddyElectronPathError ? error.reasonCode : undefined
}

/** Whether a filesystem error reports an absent path (`existsSync` cannot tell). */
function isENOENT(error) {
  return (/** @type {NodeJS.ErrnoException | null} */ (error))?.code === 'ENOENT'
}

function discoveryIncomplete(detail) {
  return new WorkBuddyElectronPathError(
    'electron-discovery-incomplete',
    `the WorkBuddy application search did not finish (${detail});`
    + ' this is not proof that the app is missing',
  )
}

/** Whether a path exists and is executable; never throws. */
function isExecutable(path) {
  try {
    if (process.platform !== 'win32') {
      accessSync(path, constants.X_OK)
      return true
    }
    // Node maps X_OK to existence on Windows (there is no execute bit), so the
    // meaningful check is "this is a file we can open" — a directory, a missing
    // file, or a permission failure all read as unusable here.
    statSync(path).isFile()
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The default discovery tools: Spotlight for the bundle, `/usr/bin/plutil` for
 * identity. Every failure that means "we could not tell" — a missing tool, a
 * timeout, an oversized answer — is raised as {@link DiscoveryIncompleteError}
 * so it can never be silently read as "no such app".
 *
 * @returns {{ findApps: (signal: AbortSignal) => Promise<readonly string[]>, bundleIdentifier: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>, bundleVersion: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined> }}
 */
export function workBuddyDiscoveryTools() {
  /**
   * @param {string} bin
   * @param {readonly string[]} args
   * @param {number} maxBytes
   * @param {AbortSignal} signal
   * @returns {Promise<string>}
   */
  const runTool = (bin, args, maxBytes, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DiscoveryIncompleteError(`${bin} was not started: the discovery budget was already spent`))
        return
      }
      let settled = false
      const child = execFile(bin, [...args], { maxBuffer: maxBytes, timeout: WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS }, (error, stdout) => {
        if (settled) return
        settled = true
        if (error !== null && error !== undefined) {
          reject(new DiscoveryIncompleteError(`${bin} could not complete (${error.killed === true ? 'timed out' : String(error.code ?? 'unavailable')})`))
          return
        }
        resolve(stdout)
      })
      const abort = () => {
        if (settled) return
        settled = true
        child.kill()
        reject(new DiscoveryIncompleteError(`${bin} was abandoned: the discovery budget was spent`))
      }
      signal.addEventListener('abort', abort, { once: true })
      child.on('close', () => { signal.removeEventListener('abort', abort) })
    })

  return {
    findApps: async signal => {
      const out = await runTool(
        MDFIND_BIN,
        [`kMDItemCFBundleIdentifier == '${WORKBUDDY_CN_BUNDLE_ID}'`],
        MDFIND_MAX_OUTPUT_BYTES,
        signal,
      )
      return out.split('\n').map(line => line.trim()).filter(line => line.endsWith('.app'))
    },
    bundleIdentifier: async (bundlePath, signal) => {
      try {
        const out = await runTool(
          PLUTIL_BIN,
          ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')],
          PLUTIL_MAX_OUTPUT_BYTES,
          signal,
        )
        return out.trim()
      } catch {
        // An unreadable plist is "we could not check this one", not "this one
        // does not match" — the candidate stays unresolved and the whole
        // discovery reports incomplete rather than quietly dropping it.
        return undefined
      }
    },
    bundleVersion: async (bundlePath, signal) => {
      try {
        const out = await runTool(
          PLUTIL_BIN,
          ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')],
          PLUTIL_MAX_OUTPUT_BYTES,
          signal,
        )
        const version = out.trim()
        return version === '' ? undefined : version
      } catch {
        return undefined
      }
    },
  }
}

/**
 * In-memory protector-key resolver: one spawn per key id, single-flight, never
 * persisted. The cache is keyed by the id envelopes ask for, so an envelope
 * sealed under a rotated key triggers exactly one fresh resolution.
 */
export class WorkBuddyAtRestKeyProvider {
  /**
   * @param {{
   *   electronPath?: string,
   *   timeoutMs?: number,
   *   source?: () => Promise<string>,
   *   spawnHelper?: (electronPath: string) => Promise<string>,
   *   discovery?: 'none' | 'macos-workbuddy',
   *   defaultElectronPaths?: readonly string[] | null,
   *   tools?: { findApps: (signal: AbortSignal) => Promise<readonly string[]>, bundleIdentifier: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>, bundleVersion: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined> },
   *   discoveryBudgetMs?: number,
   * }} [options]
   */
  constructor(options = {}) {
    const fromEnv = process.env[WORKBUDDY_ELECTRON_BIN_ENV]?.trim()
    const envPath = fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
    // Explicit sources are authoritative and mutually exclusive with
    // discovery: naming a binary means "use this one", so an unusable one is
    // an error, not an invitation to go looking for another app.
    this.explicitPath = options.electronPath ?? envPath
    this.discovery = options.discovery ?? 'none'
    // `null` is "no default here"; `undefined` means the caller did not say,
    // and a port that was never told which product it serves must not reach for
    // one. The composition root passes the variant's defaults explicitly.
    this.defaultPaths = options.defaultElectronPaths === undefined
      ? []
      : [...options.defaultElectronPaths].filter(path => typeof path === 'string' && path !== '')
    this.tools = options.tools ?? workBuddyDiscoveryTools()
    this.discoveryBudgetMs = options.discoveryBudgetMs ?? WORKBUDDY_DISCOVERY_BUDGET_MS
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.spawnHelper = options.spawnHelper ?? (path => this.spawnAt(path))
    this.source = options.source ?? (() => this.spawnPayload())
    /**
     * The path discovery settled on, cached only on success. A failure leaves
     * this unset so the next attempt tries again — the user may install or move
     * the app without restarting ZCode.
     */
    this.discoveredPath = undefined
    /** @type {{ key: Buffer, keyId: string } | undefined} */
    this.cache = undefined
    /** @type {Promise<{ key: Buffer, keyId: string }> | undefined} */
    this.inflight = undefined
  }

  /**
   * The binary the default helper would use, for diagnostics.
   *
   * Reports a *discovery result* once one exists, so diagnostics describe what
   * would actually run rather than the default that was bypassed. Discovery
   * itself stays in {@link resolveElectronPath}: this accessor never triggers a
   * search (the constructor must remain I/O-free, and callers may ask before
   * any resolution has happened).
   *
   * @returns {string | undefined}
   */
  helperPath() {
    if (this.explicitPath !== undefined) return this.explicitPath
    if (this.discovery === 'none') return this.defaultPaths[0]
    return this.discoveredPath ?? this.defaultPaths[0]
  }

  /**
   * A protector key matching one of the requested envelope key ids. The first
   * id the cache answers wins; otherwise one spawn resolves the current key,
   * which must match a request — a mismatch means the envelopes were sealed by
   * a different install than the one this machine now runs, and no key we can
   * reach will open them.
   *
   * @param {readonly string[]} requested
   * @returns {Promise<Buffer>}
   */
  async protectorKeyFor(requested) {
    if (requested.length === 0) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'encrypted desktop credential carries no key ids',
      )
    }
    const cached = this.cache
    if (cached !== undefined && requested.includes(cached.keyId)) return cached.key
    this.inflight ??= this.source().then(text => this.ingest(text))
      .finally(() => {
        this.inflight = undefined
      })
    const resolved = await this.inflight
    if (!requested.includes(resolved.keyId)) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        `WorkBuddy's current at-rest key (id ${resolved.keyId}) does not match the credential's envelope (id ${requested.join(' or ')});`
        + ' the desktop credential was sealed by a different WorkBuddy installation',
      )
    }
    return resolved.key
  }

  /**
   * @param {string} text
   * @returns {{ key: Buffer, keyId: string }}
   */
  ingest(text) {
    const payload = parseAtRestPayload(text)
    if (payload === undefined) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'WorkBuddy key helper returned an unusable at-rest payload (expected {version:1, atRestSecretKey})',
      )
    }
    const key = deriveProtectorKey(payload.atRestSecretKey)
    const resolved = { key, keyId: keyIdOfProtectorKey(key) }
    this.cache = resolved
    return resolved
  }

  /**
   * The binary to spawn, or a diagnosable error saying why there is none.
   *
   * Order is the contract: an explicit path is used as-is and never falls back;
   * discovery runs only for a provider that was configured for it, and only
   * after the platform defaults have been tried and found unusable.
   *
   * @returns {Promise<string>}
   */
  async resolveElectronPath() {
    if (this.explicitPath !== undefined) {
      if (!isExecutable(this.explicitPath)) {
        throw new WorkBuddyElectronPathError(
          'electron-path-invalid',
          `the configured WorkBuddy Electron binary is not available at ${this.explicitPath};`
          + ` check ${WORKBUDDY_ELECTRON_BIN_ENV} or unset it to let the plugin look for the app itself`,
        )
      }
      return this.explicitPath
    }
    for (const defaultPath of this.defaultPaths) {
      if (isExecutable(defaultPath)) return defaultPath
    }
    if (this.discovery === 'none') {
      // Either the other product/platform with no default, or a platform with
      // no verified layout. Both are "not configured", never "we searched and
      // failed".
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no WorkBuddy Electron binary is configured for this platform;`
        + ` set ${WORKBUDDY_ELECTRON_BIN_ENV} to the app's Electron binary`,
      )
    }
    // A previously discovered path is re-checked rather than trusted: the app
    // may have been moved or removed since, and a stale path must not win.
    if (this.discoveredPath !== undefined) {
      if (isExecutable(this.discoveredPath)) return this.discoveredPath
      this.discoveredPath = undefined
    }
    const found = await this.discoverMacosApp()
    this.discoveredPath = found
    return found
  }

  /**
   * Resolve the CN app through Spotlight, then prove each candidate's identity
   * before it can be executed.
   *
   * @returns {Promise<string>}
   */
  async discoverMacosApp() {
    if (process.platform !== 'darwin') {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no WorkBuddy Electron binary is configured for this platform;`
        + ` set ${WORKBUDDY_ELECTRON_BIN_ENV} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs)
    try {
      let candidates
      try {
        candidates = await this.tools.findApps(controller.signal)
      } catch {
        throw discoveryIncomplete('the app search did not complete')
      }
      // Several Spotlight rows can name one bundle (path aliases, the
      // /System/Volumes/Data view). Identity + realpath collapse those into
      // one candidate; only genuinely distinct apps may count as "more than
      // one", or a single app would look ambiguous.
      const seen = new Map()
      let unresolved = false
      for (const candidate of candidates) {
        // A Spotlight index keeps rows for apps deleted since the last sweep,
        // and a stale row is a *decidable* exclusion: the candidate is gone,
        // which is not the same as "we could not check it". Skipping it here
        // is what stops one dead row from sinking a live app beside it —
        // upstream issue #48 §3.7.
        //
        // Only ENOENT qualifies. `existsSync` is not usable here: it answers
        // `false` for *any* error, so an EACCES/EPERM parent (or an
        // ENAMETOOLONG path) would be read as "this app was deleted" and a
        // live sibling would be chosen over a candidate we merely could not
        // inspect. `statSync` distinguishes them, and anything other than a
        // confirmed absence stays unresolved.
        try {
          statSync(candidate)
        } catch (error) {
          if (isENOENT(error)) continue
          unresolved = true
          continue
        }
        let bundleIdentifier
        try {
          bundleIdentifier = await this.tools.bundleIdentifier(candidate, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        if (bundleIdentifier === undefined) {
          unresolved = true
          continue
        }
        if (bundleIdentifier !== WORKBUDDY_CN_BUNDLE_ID) continue
        const electronPath = join(candidate, 'Contents', 'MacOS', 'Electron')
        if (!isExecutable(electronPath)) continue
        let identity
        try {
          identity = realpathSync(candidate)
        } catch {
          identity = candidate
        }
        if (seen.has(identity)) continue
        let version
        try {
          version = await this.tools.bundleVersion(candidate, controller.signal)
        } catch {
          // Version is display-only; an unreadable one must not sink an
          // otherwise identified candidate.
          version = undefined
        }
        seen.set(identity, { bundlePath: candidate, electronPath, ...(version === undefined ? {} : { version }) })
      }
      if (seen.size > 1) {
        const listed = [...seen.values()]
          .map(app => `  - ${app.bundlePath}${app.version === undefined ? '' : ` (${app.version})`}`)
          .join('\n')
        throw new WorkBuddyElectronPathError(
          'electron-binary-ambiguous',
          `more than one WorkBuddy application was found, so none was chosen:\n${listed}\n`
          + ` set ${WORKBUDDY_ELECTRON_BIN_ENV} to the one to use`,
        )
      }
      // A candidate nobody could check might have been a second copy, so its
      // existence forbids claiming the rest are unique.
      if (unresolved) throw discoveryIncomplete('some candidates could not be checked')
      if (seen.size === 0) {
        throw new WorkBuddyElectronPathError(
          'electron-binary-not-found',
          'no WorkBuddy application was found in the default location or the system index;'
          + ' if WorkBuddy is installed elsewhere, it may not be indexed yet',
        )
      }
      return [...seen.values()][0].electronPath
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  /** @returns {Promise<string>} */
  async spawnPayload() {
    return await this.spawnHelper(await this.resolveElectronPath())
  }

  /**
   * @param {string} electronPath
   * @returns {Promise<string>}
   */
  async spawnAt(electronPath) {
    return await new Promise((resolve, reject) => {
      execFile(electronPath, [HELPER_SCRIPT_ARGUMENT_FLAG, HELPER_SCRIPT], {
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }, (error, stdout) => {
        if (error !== null && error !== undefined) {
          // Code and reason only: stdout/stderr can carry paths or crash dumps,
          // and the payload must never appear in a message.
          const reason = error.killed === true
            ? `timed out or was killed after ${String(this.timeoutMs)}ms`
            : error.code !== undefined
              ? `exited with code ${String(error.code)}`
              : 'could not be started'
          reject(new WorkBuddyElectronPathError(
            'encrypted-credential-unreadable',
            `the WorkBuddy key helper (${electronPath}) ${reason}`,
          ))
          return
        }
        const output = stdout.trim()
        if (output === '') {
          reject(new WorkBuddyElectronPathError(
            'encrypted-credential-unreadable',
            `the WorkBuddy key helper (${electronPath}) produced no payload`,
          ))
          return
        }
        resolve(output)
      })
    })
  }
}

/**
 * The helper: run inside WorkBuddy's Electron as plain Node, where the private
 * `workbuddyStorage` binding exists, and print only the payload. It writes
 * nothing else, so whatever reaches stdout is the payload.
 */
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'
const HELPER_SCRIPT_ARGUMENT_FLAG = '-e'
