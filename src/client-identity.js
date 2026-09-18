/**
 * Desktop-client identity for chat requests.
 *
 * Chat carries the User-Agent shape the official desktop client composes —
 * `WorkBuddy/<v> WorkBuddy/<v>` — where the product token names the app that
 * owns the region's requests. Versions come from the installed App when it can
 * be read, degrade to a saved value, and finally to a compiled-in constant.
 * Never the legacy CLI UA: the upstream gateway has been observed to reject
 * that shape for chat.
 *
 * Scope: chat requests ONLY. Refresh, catalog and billing keep the CLI-form UA.
 *
 * @module zcode-workbuddy-connect/client-identity
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { savedVersionPath } from './config.js'
import { FALLBACK_APP_VERSION, FALLBACK_CN_APP_VERSION, readBundleVersion, resolveAppVersion, validAppVersion } from './app-version.js'

/** Basename of the CN saved-version cache. */
export const CN_APP_VERSION_FILENAME = '.workbuddy-app-version.json'

/**
 * Whether a value is a CLI version that may reach a header. Tolerates a
 * prerelease suffix; anything with whitespace, CR or LF never passes.
 */
export function validCliVersion(value) {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value)
}

/**
 * Path of the bundled agent CLI's package.json inside an installed App.
 * On Windows the App ships unpacked resources next to the executable; on
 * macOS it is `app.asar.unpacked` inside the bundle.
 */
function cliPackagePaths(root) {
  return process.platform === 'darwin'
    ? [join(root, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'package.json')]
    : [
        join(root, 'resources', 'app.asar.unpacked', 'cli', 'package.json'),
        join(root, 'resources', 'cli', 'package.json'),
      ]
}

/**
 * The bundled agent CLI's real version, or undefined when it does not resolve.
 *
 * `cli/package.json` ships a `0.0.0` placeholder in `version` with the real
 * version in `publishConfig.customPackage.version`; a valid non-placeholder
 * `version` wins, otherwise the custom-package value applies, and unreadable
 * or invalid metadata yields undefined (the caller drops the `CLI/…` token
 * rather than guessing).
 */
export async function readCliVersion(root) {
  for (const path of cliPackagePaths(root)) {
    let document
    try {
      document = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      continue
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) continue
    const declared = document['version']
    if (validCliVersion(declared) && declared !== '0.0.0') return declared
    const publishConfig = document['publishConfig']
    const customPackage = typeof publishConfig === 'object' && publishConfig !== null && !Array.isArray(publishConfig)
      ? publishConfig['customPackage'] : undefined
    const customVersion = typeof customPackage === 'object' && customPackage !== null ? customPackage['version'] : undefined
    if (validCliVersion(customVersion)) return customVersion
  }
  return undefined
}

/**
 * Build the chat User-Agent for one region.
 *
 * Throws on an invalid version rather than interpolating one into a header;
 * `resolveChatIdentity` never produces such an identity, so the throw is a
 * last gate against future call-site mistakes, not an expected path.
 */
export function chatUserAgent(identity, region) {
  if (!validAppVersion(identity.clientVersion)) {
    throw new Error(`invalid client version for chat User-Agent: ${JSON.stringify(identity.clientVersion)}`)
  }
  if (identity.cliVersion !== undefined && !validCliVersion(identity.cliVersion)) {
    throw new Error(`invalid CLI version for chat User-Agent: ${JSON.stringify(identity.cliVersion)}`)
  }
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`]
  if (identity.cliVersion !== undefined) parts.push(`CLI/${identity.cliVersion}`)
  return parts.join(' ')
}

/** The region's compiled-in fallback identity: desktop form, no CLI segment. */
export function fallbackChatIdentity(region) {
  return { clientVersion: region === 'global' ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION }
}

/**
 * Resolve the installed CN desktop App in the conventional install roots.
 * Mirrors the macOS probe with Windows locations; a missing App is normal.
 */
async function installedCnApp() {
  const candidates = []
  if (process.platform === 'darwin') {
    candidates.push('/Applications/WorkBuddy.app')
  } else if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    const roaming = process.env['APPDATA']
    const programFiles = process.env['ProgramFiles'] ?? 'C:/Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'
    for (const base of [local && join(local, 'Programs'), roaming && join(roaming, 'Programs'), programFiles, programFilesX86]) {
      if (!base) continue
      candidates.push(join(base, 'WorkBuddy'), join(base, 'WorkBuddy AI'))
    }
  }
  for (const root of candidates) {
    for (const infoPath of [
      join(root, 'resources', 'app', 'package.json'),
      join(root, 'Contents', 'Info.plist'),
    ]) {
      const version = await readBundleVersion(infoPath)
      if (version !== undefined && validAppVersion(version)) return { version, root }
    }
    // Windows Apps typically carry the version on the executable's file name
    // nowhere; a plain `package.json` at the root is the common fallback.
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      if (validAppVersion(pkg?.['version'])) return { version: pkg['version'], root }
    } catch {
      // not installed here
    }
  }
  return undefined
}

const cache = new Map()

/**
 * Resolve the chat identity for one region: installed App → region's saved
 * value → compiled-in fallback. Never throws — a missing App, an unreadable
 * manifest, a failed cache write, or a reader that throws outright all
 * degrade to {@link fallbackChatIdentity}; resolution never blocks a message.
 */
export async function resolveChatIdentity(region, options = {}) {
  const injectable = options.installedCn !== undefined
    || options.resolveIntl !== undefined
    || options.cliVersion !== undefined
    || options.cnSavedPath !== undefined
  if (!injectable) {
    const cached = cache.get(region)
    if (cached !== undefined) return cached
  }
  let identity
  try {
    identity = region === 'global'
      ? await resolveGlobalIdentity(options)
      : await resolveCnIdentity(options)
  } catch {
    // A reader that throws must not block a message and must not pin this
    // degraded answer for the process lifetime: return the fallback without
    // caching it, so a later call can resolve properly again.
    return fallbackChatIdentity(region)
  }
  if (!injectable) cache.set(region, identity)
  return identity
}

/** CN: installed App → CN saved cache → CN fallback. */
async function resolveCnIdentity(options) {
  const savedPath = options.cnSavedPath ?? savedVersionPath()
  const installed = await (options.installedCn ?? installedCnApp)()
  if (installed !== undefined && validAppVersion(installed.version)) {
    const cliVersion = await (options.cliVersion ?? readCliVersion)(installed.root)
    const identity = {
      clientVersion: installed.version,
      ...(cliVersion !== undefined && validCliVersion(cliVersion) ? { cliVersion } : {}),
    }
    // Best-effort remember of the App version only: the CLI version is read
    // live from the install tree whenever it exists, and once the App is gone
    // the degradation omits the `CLI/…` token rather than continuing to claim
    // a version whose source no longer exists.
    try {
      await mkdir(dirname(savedPath), { recursive: true })
      await writeFile(savedPath, `${JSON.stringify({ version: identity.clientVersion, observedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // Identity resolved; losing the memory of it is not a failure.
    }
    return identity
  }
  try {
    const saved = JSON.parse(await readFile(savedPath, 'utf8'))
    if (typeof saved === 'object' && saved !== null && validAppVersion(saved['version'])) {
      return { clientVersion: saved['version'] }
    }
  } catch {
    // Absent or malformed cache: fall through to the compiled-in constant.
  }
  return fallbackChatIdentity('cn')
}

/** International: `app-version.js`'s installed → saved → fallback chain. */
async function resolveGlobalIdentity(options) {
  const info = await (options.resolveIntl ?? resolveAppVersion)()
  const clientVersion = validAppVersion(info.version) ? info.version : FALLBACK_APP_VERSION
  let cliVersion
  if (info.root !== undefined) {
    const read = await (options.cliVersion ?? readCliVersion)(info.root)
    if (read !== undefined && validCliVersion(read)) cliVersion = read
  }
  return { clientVersion, ...(cliVersion === undefined ? {} : { cliVersion }) }
}