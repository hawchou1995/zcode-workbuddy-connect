/**
 * WorkBuddy credential resolution. The primary source is the WorkBuddy
 * desktop app's own auth file, read-only; a plugin-owned copy under the
 * service's state directory holds token refreshes so the desktop file is
 * never written. The effective credential is whichever of the two belongs to
 * the currently signed-in account and expires later.
 *
 * @module zcode-workbuddy-connect/auth
 */

import { readFile, rm, stat, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { regionOf } from './upstream.js'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

/** Basename of the desktop app's own auth file in the shared auth directory. */
export const DESKTOP_AUTH_FILENAME = 'workbuddy-desktop.info'
/** Basename of the international app's auth file (same directory, different app). */
export const DESKTOP_AUTH_AI_FILENAME = 'workbuddy-desktop-ai.info'

const DESKTOP_AUTH_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth', DESKTOP_AUTH_FILENAME]

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'
/** Env variable overriding the international desktop auth-file location. */
export const WORKBUDDY_AI_AUTH_FILE_ENV = 'WORKBUDDY_AI_AUTH_FILE'

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
  if (typeof value !== 'number' || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Platform-default candidates for one variant's auth file, in probe order.
 * Windows probes both AppData roots: current builds write under
 * `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). The two
 * apps share the directory and differ only in basename.
 *
 * @param {string} desktopFilename which variant's file to look for
 */
export function defaultDesktopAuthCandidates(desktopFilename = DESKTOP_AUTH_FILENAME) {
  const relative = ['CodeBuddyExtension', 'Data', 'Public', 'auth', desktopFilename]
  const home = homedir()
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    const roaming = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    return [
      join(local, ...relative),
      join(roaming, ...relative),
    ]
  }
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...relative)]
  }
  return [join(home, '.config', ...relative)]
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(parsed)) return undefined
  let auth
  let identity
  if (isObject(parsed['auth'])) {
    auth = parsed['auth']
    identity = isObject(parsed['account']) ? parsed['account'] : {}
  } else {
    auth = parsed
    identity = parsed
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  return {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs: typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: 'desktop',
  }
}

/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(parsed)) return undefined
  if (parsed['version'] !== OWN_FORMAT_VERSION) return undefined
  if (!isObject(parsed['credential'])) return undefined
  // The owned copy stores the normalized credential itself (camelCase
  // `expiresAtMs`, identity fields at the top level), NOT the desktop document
  // shape. Round-tripping through parseWorkBuddyAuth would read `expiresAt`
  // and an `account` object, find neither, and drop uid/enterprise/nickname.
  const stored = parsed['credential']
  const accessToken = typeof stored['accessToken'] === 'string' ? stored['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
  const enterpriseId = optionalString(stored['enterpriseId'])
  const nickname = optionalString(stored['nickname'])
  return {
    accessToken,
    refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
    expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalString(stored['domain']) ?? '',
    uid: optionalString(stored['uid']) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: 'own',
  }
}

function isENOENT(error) {
  return (error?.code) === 'ENOENT'
}

/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin (or
 * already expired), keep the refreshed credential in the plugin-owned copy,
 * and never write the desktop app's file. A failed refresh still returns a
 * not-yet-expired token so an unreachable refresh endpoint does not take down
 * a working session.
 */
export class WorkBuddyCredentialStore {
  /**
   * @param {object} options
   * @param {(credential: object) => Promise<object>} options.refresh performs the upstream token refresh
   * @param {string} options.ownPath plugin-owned credential copy path
   * @param {string} [options.desktopPath] explicit desktop auth-file path   * @param {string} [options.desktopFilename] basename for the platform-default probe (variant selection)
   * @param {string} [options.authFileEnv] env var overriding the desktop path (default WORKBUDDY_AUTH_FILE)
   * @param {string} [options.appName] display name for diagnostics ('WorkBuddy' | 'WorkBuddy AI')
   * @param {number} [options.refreshMarginMs] refresh this long before expiry
   */
  constructor(options) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath
    this.desktopPathOverride = options.desktopPath
    this.desktopFilename = options.desktopFilename ?? DESKTOP_AUTH_FILENAME
    this.authFileEnv = options.authFileEnv ?? WORKBUDDY_AUTH_FILE_ENV
    this.appName = options.appName ?? 'WorkBuddy'
    this.inflight = undefined
  }

  /**
   * Configuration precedence for the desktop file: the configured path, then
   * the environment variable, then the platform defaults.
   */
  resolveDesktopCandidates() {
    const fromEnv = process.env[this.authFileEnv]
    const explicit = this.desktopPathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return defaultDesktopAuthCandidates(this.desktopFilename)
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath() {
    return this.resolveDesktopCandidates()[0]
  }

  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath() {
    return this.ownPath
  }

  /** Read the freshest stored credential without refreshing anything. */
  async current() {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    // Identity beats expiry. The own copy is written by this service's own
    // refreshes, so after the user switches accounts in the desktop app the
    // copy still belongs to the *previous* account — and may well expire
    // later, because we refreshed it. Preferring it by expiry would send the
    // old account's uid in `X-User-Id` and answer as the wrong user. The
    // desktop file is the authority on who is signed in now.
    if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve() {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      throw new Error(
        `workbuddy: no signed-in ${this.appName} account found; sign in once in the ${this.appName} desktop app`
        + ` (expected ${desktop} or ${this.authFileEnv})`,
 )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status() {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...(credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
        ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
        ...(credential.domain === '' ? {} : { domain: credential.domain }),
        ...(credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId }),
        uid: credential.uid,
        region: regionOf(credential.domain),
        source: credential.source,
      }
    } catch (error) {
      // A region mismatch (or an unreadable file) is a *diagnosable* signed-out
      // state, not a silent one.
      return { state: 'signed-out', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Remove the plugin-owned copy; the desktop file is untouched. */
  async logout() {
    await rm(this.ownPath, { force: true })
  }

  needsRefresh(credential) {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  async refreshNow(credential) {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...(outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain }),
        source: 'own',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
  }

  /** Atomic write of the plugin-owned copy (temp file + rename). */
  async saveOwn(credential) {
    const document = { version: OWN_FORMAT_VERSION, credential }
    await mkdir(dirname(this.ownPath), { recursive: true })
    const temp = `${this.ownPath}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.ownPath)
  }

  /**
   * Read the first desktop candidate that exists. Only an absent file (ENOENT)
   * falls through to the next candidate; a file that is present but unparsable
   * is authoritative for its slot, so a stale older-version file never
   * silently wins over a broken newer one.
   */
  async readDesktop() {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        return parseWorkBuddyAuth(await readFile(desktopPath, 'utf8'))
      } catch (error) {
        if (!isENOENT(error)) throw error
      }
    }
    return undefined
  }

  async readOwn() {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch {
      return undefined
    }
  }

  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  async desktopFilePresent() {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        if ((await stat(desktopPath)).isFile()) return true
      } catch {
        // absent or not a regular file — try the next candidate
      }
    }
    return false
  }
}