/**
 * Installed-App version resolution, used for the international catalog's
 * App-shaped User-Agent. Only the CN variant is wired up in this service, so
 * this module serves the shared validator and the fallback constant; the
 * international probe is kept because the region gate still routes an
 * international credential to it.
 *
 * @module zcode-workbuddy-connect/app-version
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { savedVersionPath } from './config.js'

/** Compiled-in international fallback. */
export const FALLBACK_APP_VERSION = '5.5.6'

/**
 * Compiled-in CN fallback for the `WorkBuddy/<v>` tokens.
 *
 * Observed on the CN desktop app; like the international fallback it is a
 * shape requirement, not a currency claim — the gateway has not been observed
 * to branch on it.
 */
export const FALLBACK_CN_APP_VERSION = '5.5.6'

/** Basename of the international saved-version cache. */
export const GLOBAL_APP_VERSION_FILENAME = '.workbuddy-ai-version.json'

/**
 * Whether a value is an App version that may reach a header. Tolerates a
 * prerelease suffix and a four-part build number; anything with whitespace,
 * CR or LF never passes — the value is interpolated into an HTTP header.
 */
export function validAppVersion(value) {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value)
}

/** The App-shaped User-Agent for the international catalog request. */
export function appUserAgent(version) {
  return `WorkBuddy AI/${version}`
}

/**
 * Read a version out of an App manifest.
 *
 * Handles the three shapes actually seen in the wild: a JSON `package.json`
 * with a `version` field, an XML `Info.plist` with `CFBundleShortVersionString`,
 * and undefined for anything else.
 */
export async function readBundleVersion(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  if (text.trimStart().startsWith('{')) {
    try {
      const pkg = JSON.parse(text)
      if (validAppVersion(pkg?.['version'])) return pkg['version']
      const product = pkg?.['productVersion'] ?? pkg?.['buildVersion']
      if (validAppVersion(product)) return product
    } catch {
      return undefined
    }
    return undefined
  }
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(text)
  return match !== null && validAppVersion(match[1]) ? match[1] : undefined
}

/**
 * International App version: installed bundle → saved cache → compiled-in
 * fallback. Never throws; a missing App or unreadable manifest degrades to
 * the constant.
 */
export async function resolveAppVersion() {
  const candidates = []
  if (process.platform === 'darwin') {
    candidates.push('/Applications/WorkBuddy AI.app')
  } else if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    const programFiles = process.env['ProgramFiles'] ?? 'C:/Program Files'
    if (local) candidates.push(join(local, 'Programs', 'WorkBuddy AI'))
    candidates.push(join(programFiles, 'WorkBuddy AI'))
  }
  for (const root of candidates) {
    for (const manifest of [
      join(root, 'resources', 'app', 'package.json'),
      join(root, 'Contents', 'Info.plist'),
      join(root, 'package.json'),
    ]) {
      const version = await readBundleVersion(manifest)
      if (version !== undefined) {
        await rememberVersion(version)
        return { version, root }
      }
    }
  }
  const savedPath = savedVersionPath()
  try {
    const saved = JSON.parse(await readFile(savedPath, 'utf8'))
    if (validAppVersion(saved?.['version'])) return { version: saved['version'] }
  } catch {
    // absent or malformed cache
  }
  return { version: FALLBACK_APP_VERSION }
}

async function rememberVersion(version) {
  try {
    const savedPath = savedVersionPath()
    await mkdir(dirname(savedPath), { recursive: true })
    await writeFile(savedPath, `${JSON.stringify({ version, observedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Best-effort memory; not a failure.
  }
}