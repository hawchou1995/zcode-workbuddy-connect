/**
 * WorkBuddy 5.6 at-rest credential protection: classification, the field
 * crypto contract, payload validation, and the key provider's resolution and
 * caching contract.
 *
 * Every fixture here is synthetic — a fixed test secret, a test-derived
 * protector key, fake tokens — so nothing real is committed or printed. The AAD
 * builder is additionally pinned against a verbatim transcription of the
 * reference builder (the app's own `buildAuthenticatedContextAad`), because a
 * silent AAD change is undetectable except by decryption failures in the field.
 *
 * No test spawns a subprocess: the helper, the discovery tools, and the
 * executable check all go through injected seams.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createHash } from 'node:crypto'
import {
  WORKBUDDY_ELECTRON_BIN_ENV,
  WORKBUDDY_CN_BUNDLE_ID,
  WorkBuddyAtRestKeyProvider,
  WorkBuddyElectronPathError,
  buildAuthenticatedContextAad,
  classifyDesktopAuthDocument,
  defaultDiscoveryFor,
  defaultWorkBuddyElectronPath,
  defaultWorkBuddyElectronPaths,
  deriveProtectorKey,
  keyIdsOf,
  openAuthField,
  parseAtRestPayload,
  reasonCodeOf,
  sealAuthFieldForTest,
  unwrapDesktopAuthDocument,
} from '../src/desktop-credential-protection.js'

const SECRET = Buffer.alloc(32, 7).toString('base64')
const PAYLOAD_TEXT = JSON.stringify({ version: 1, atRestSecretKey: SECRET })
const KEY = deriveProtectorKey(SECRET)
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

/** Verbatim transcription of the reference AAD builder from the app bundle. */
function referenceAad(keyId, context) {
  const PREFIX = Buffer.from('WB-AAD\0', 'ascii')
  const FRAMING_NAME = { file: 'WBEF1', field: 'WBEV1' }
  const FRAMING_TAG = { file: 1, field: 2 }
  const u32 = n => {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32BE(n)
    return b
  }
  const lp = s => {
    const b = Buffer.from(s, 'utf8')
    return Buffer.concat([u32(b.length), b])
  }
  return Buffer.concat([
    PREFIX, Buffer.from([1]),
    lp(FRAMING_NAME[context.framing]),
    lp('sym-v1'),
    u32(context.suite),
    lp(keyId),
    Buffer.from([FRAMING_TAG[context.framing]]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/**
 * Seal a field under the reference `file` framing. Production must REJECT
 * this — 5.6.x credential fields are `field`-framed only, and accepting other
 * framings would be guessing at formats the plugin has never seen.
 */
function sealWithFileFraming(key, plaintext) {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = Buffer.alloc(12, 3)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(referenceAad(keyId, { framing: 'file', suite: 1 }))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/** A full 5.6-shaped desktop document with both token fields sealed. */
function encryptedDocument(key = KEY, overrides = {}) {
  return JSON.stringify({
    auth: {
      accessToken: sealAuthFieldForTest(key, 'test-access-token'),
      refreshToken: sealAuthFieldForTest(key, 'test-refresh-token'),
      expiresAt: 1900000000,
      domain: 'www.workbuddy.ai',
      ...overrides,
    },
    account: { uid: 'uid-9', nickname: 'Tester', enterpriseId: 'ent-3' },
  })
}

/** Stand a real, readable file in for a discovered app bundle. */
async function fakeAppBundle(root, name = 'WorkBuddy.app') {
  const bundle = join(root, name, 'Contents', 'MacOS')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'Electron'), '# fake electron binary')
  await writeFile(join(root, name, 'Contents', 'Info.plist'), 'binary-plist')
  return join(root, name)
}

/**
 * Run `body` with this process pretending to be macOS.
 *
 * The discovery flow is deliberately macOS-only (upstream issue #48 §3.6), so
 * on any other platform it refuses by design. Stubbing the platform locally is
 * what lets the same tests exercise the discovery logic everywhere, against
 * injected tools and real temp files, without ever running mdfind.
 */
async function withDarwinPlatform(body) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try {
    return await body()
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
  }
}

/** A real, executable-flagged file to stand in for an Electron binary. */
async function fakeBinary(name = 'workbuddy-electron') {
  const path = join(await mkdtemp(join(tmpdir(), 'wb-binary-')), name)
  await writeFile(path, '# fake electron binary')
  await chmod(path, 0o755)
  return path
}

describe('desktop auth classification', () => {
  it('reads the four formats apart', () => {
    assert.deepEqual(classifyDesktopAuthDocument(''), { format: 'absent' })
    assert.deepEqual(classifyDesktopAuthDocument('   \n'), { format: 'absent' })
    assert.equal(classifyDesktopAuthDocument('not json').format, 'unrecognized')
    assert.equal(classifyDesktopAuthDocument('[1,2]').format, 'unrecognized')
    assert.equal(classifyDesktopAuthDocument('{"auth":{"accessToken":"at","refreshToken":"rt"}}').format, 'plaintext')
    const encrypted = classifyDesktopAuthDocument(encryptedDocument())
    assert.equal(encrypted.format, 'encrypted')
    if (encrypted.format !== 'encrypted') return
    assert.deepEqual(keyIdsOf(encrypted.wrapped.fields), [KEY_ID])
    assert.deepEqual([...encrypted.wrapped.fields].map(field => field.field).sort(), ['accessToken', 'refreshToken'])
  })

  it('treats a wrapper whose envelope will not decode as unrecognized, not encrypted', () => {
    const broken = JSON.stringify({
      auth: { accessToken: { '$wbEncrypted': 1, envelope: '%%%not-base64%%%' } },
    })
    assert.equal(classifyDesktopAuthDocument(broken).format, 'unrecognized')
    const truncated = JSON.stringify({
      auth: { refreshToken: { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify({ suite: 1, keyId: KEY_ID, nonce: 'AAAA' }), 'utf8').toString('base64') } },
    })
    assert.equal(classifyDesktopAuthDocument(truncated).format, 'unrecognized')
  })

  it('accepts the flat panel shape and a mixed plaintext/encrypted document', () => {
    const flat = JSON.stringify({
      accessToken: sealAuthFieldForTest(KEY, 'test-access-token'),
      refreshToken: 'plaintext-refresh',
    })
    const classified = classifyDesktopAuthDocument(flat)
    assert.equal(classified.format, 'encrypted')
    if (classified.format !== 'encrypted') return
    assert.deepEqual(classified.wrapped.fields.map(field => field.field), ['accessToken'])
  })

  it('rejects a wrapper whose envelope is not the 12-byte-nonce / 16-byte-tag shape', () => {
    const wrongSizes = JSON.stringify({
      auth: {
        accessToken: { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify({ suite: 1, keyId: KEY_ID, nonce: Buffer.alloc(8, 1).toString('base64'), authTag: Buffer.alloc(16, 1).toString('base64'), ciphertext: Buffer.alloc(8, 1).toString('base64') }), 'utf8').toString('base64') },
      },
    })
    assert.equal(classifyDesktopAuthDocument(wrongSizes).format, 'unrecognized')
    const wrongTag = JSON.stringify({
      auth: {
        accessToken: { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify({ suite: 1, keyId: KEY_ID, nonce: Buffer.alloc(12, 1).toString('base64'), authTag: Buffer.alloc(8, 1).toString('base64'), ciphertext: Buffer.alloc(8, 1).toString('base64') }), 'utf8').toString('base64') },
      },
    })
    assert.equal(classifyDesktopAuthDocument(wrongTag).format, 'unrecognized')
    // Base64 that decodes but does not round-trip (stray characters) is rejected
    // before any key material is involved.
    const nonCanonical = JSON.stringify({
      auth: {
        accessToken: { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify({ suite: 1, keyId: KEY_ID, nonce: `${Buffer.alloc(12, 1).toString('base64')}!!`, authTag: Buffer.alloc(16, 1).toString('base64'), ciphertext: Buffer.alloc(8, 1).toString('base64') }), 'utf8').toString('base64') },
      },
    })
    assert.equal(classifyDesktopAuthDocument(nonCanonical).format, 'unrecognized')
  })

  it('rejects a key id that is not 16 lowercase hexadecimal characters', () => {
    for (const keyId of ['9127DEA1B44020A7', '9127dea1b44020', '9127dea1b44020a7z', '']) {
      const document = JSON.stringify({
        auth: {
          accessToken: { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify({ suite: 1, keyId, nonce: Buffer.alloc(12, 1).toString('base64'), authTag: Buffer.alloc(16, 1).toString('base64'), ciphertext: Buffer.alloc(8, 1).toString('base64') }), 'utf8').toString('base64') },
        },
      })
      assert.equal(classifyDesktopAuthDocument(document).format, 'unrecognized', `keyId ${keyId} must not be accepted`)
    }
  })
})

describe('field decryption', () => {
  it('builds the exact AAD the verified reference script builds for credential fields', () => {
    assert.deepEqual(
      buildAuthenticatedContextAad('9127dea1b44020a7', 1),
      referenceAad('9127dea1b44020a7', { framing: 'field', suite: 1 }),
    )
  })

  it('round-trips a sealed field and rejects wrong keys or tampered tags', () => {
    const sealed = sealAuthFieldForTest(KEY, 'round-trip')
    const classified = classifyDesktopAuthDocument(JSON.stringify({ auth: { accessToken: sealed } }))
    assert.equal(classified.format, 'encrypted')
    if (classified.format !== 'encrypted') return
    const wrapped = classified.wrapped.fields[0]
    assert.equal(openAuthField(KEY, wrapped.envelope), 'round-trip')
    assert.equal(openAuthField(Buffer.alloc(32, 9), wrapped.envelope), undefined)
    const tampered = { ...wrapped.envelope, authTag: Buffer.from(wrapped.envelope.authTag) }
    tampered.authTag[0] ^= 0xff
    assert.equal(openAuthField(KEY, tampered), undefined)
    // A tampered ciphertext fails the tag check the same way.
    const tamperedCipher = { ...wrapped.envelope, ciphertext: Buffer.from(wrapped.envelope.ciphertext) }
    tamperedCipher.ciphertext[0] ^= 0xff
    assert.equal(openAuthField(KEY, tamperedCipher), undefined)
  })

  it('rejects an envelope sealed under the file framing instead of guessing', () => {
    const sealed = sealWithFileFraming(KEY, 'file-framed')
    const classified = classifyDesktopAuthDocument(JSON.stringify({ auth: { refreshToken: sealed } }))
    assert.equal(classified.format, 'encrypted')
    if (classified.format !== 'encrypted') return
    assert.equal(openAuthField(KEY, classified.wrapped.fields[0].envelope), undefined)
  })

  it('classifies a wrapper with an unsupported suite as unrecognized, not encrypted', () => {
    const keyId = createHash('sha256').update(KEY).digest('hex').slice(0, 16)
    const inner = JSON.stringify({ suite: 2, keyId, nonce: Buffer.alloc(12, 1).toString('base64'), authTag: Buffer.alloc(16, 1).toString('base64'), ciphertext: Buffer.alloc(8, 1).toString('base64') })
    const document = JSON.stringify({ auth: { accessToken: { '$wbEncrypted': 1, envelope: Buffer.from(inner, 'utf8').toString('base64') } } })
    assert.equal(classifyDesktopAuthDocument(document).format, 'unrecognized')
  })

  it('rebuilt plaintext keeps identity and expiry fields and drops the wrappers', () => {
    const classified = classifyDesktopAuthDocument(encryptedDocument())
    assert.equal(classified.format, 'encrypted')
    if (classified.format !== 'encrypted') return
    const text = unwrapDesktopAuthDocument(classified, field => `opened-${field.field}`)
    const parsed = JSON.parse(text)
    assert.equal(parsed.auth.accessToken, 'opened-accessToken')
    assert.equal(parsed.auth.refreshToken, 'opened-refreshToken')
    assert.equal(parsed.auth.expiresAt, 1900000000)
    assert.equal(parsed.auth.domain, 'www.workbuddy.ai')
    assert.equal(parsed.auth.accessToken.$wbEncrypted, undefined)
    assert.deepEqual(parsed.account, { uid: 'uid-9', nickname: 'Tester', enterpriseId: 'ent-3' })
  })

  it('surfaces a field that cannot be opened instead of passing a token through', () => {
    const classified = classifyDesktopAuthDocument(encryptedDocument())
    assert.equal(classified.format, 'encrypted')
    if (classified.format !== 'encrypted') return
    assert.throws(
      () => unwrapDesktopAuthDocument(classified, () => {
        throw new Error('could not be decrypted')
      }),
      /could not be decrypted/,
    )
  })
})

describe('at-rest payload validation', () => {
  it('accepts the 5.6 payload shape', () => {
    assert.deepEqual(parseAtRestPayload(PAYLOAD_TEXT), { atRestSecretKey: SECRET })
  })

  it('rejects unparsable, wrong-version, non-canonical, wrong-size, and all-zero secrets', () => {
    assert.equal(parseAtRestPayload('garbage'), undefined)
    assert.equal(parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: SECRET })), undefined)
    assert.equal(parseAtRestPayload(JSON.stringify({})), undefined)
    // "short" decodes fine but re-encodes differently: not canonical base64.
    assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: 'short' })), undefined)
    assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(31, 1).toString('base64') })), undefined)
    assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32, 0).toString('base64') })), undefined)
    assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: '' })), undefined)
    assert.equal(parseAtRestPayload('[1]'), undefined)
  })
})

describe('at-rest key provider', () => {
  it('caches one source resolution per key id', async () => {
    let calls = 0
    const provider = new WorkBuddyAtRestKeyProvider({ source: async () => { calls += 1; return PAYLOAD_TEXT } })
    assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
    assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
    assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
    assert.equal(calls, 1)
  })

  it('shares one in-flight resolution between concurrent callers', async () => {
    let calls = 0
    let release = () => {}
    const gate = new Promise(resolve => { release = resolve })
    const provider = new WorkBuddyAtRestKeyProvider({
      source: async () => { calls += 1; await gate; return PAYLOAD_TEXT },
    })
    const first = provider.protectorKeyFor([KEY_ID])
    const second = provider.protectorKeyFor([KEY_ID])
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(calls, 1)
    assert.equal(a, b)
  })

  it('re-resolves once when an envelope names a different key id', async () => {
    const otherSecret = Buffer.alloc(32, 11).toString('base64')
    const otherPayload = JSON.stringify({ version: 1, atRestSecretKey: otherSecret })
    const otherKey = deriveProtectorKey(otherSecret)
    const otherId = createHash('sha256').update(otherKey).digest('hex').slice(0, 16)
    const answers = [PAYLOAD_TEXT, otherPayload, PAYLOAD_TEXT]
    let calls = 0
    const provider = new WorkBuddyAtRestKeyProvider({ source: async () => { calls += 1; return answers[calls - 1] ?? '' } })
    assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
    assert.deepEqual(await provider.protectorKeyFor([otherId]), otherKey)
    // The rotated key is now cached: the old id forces the third resolution.
    assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
    assert.equal(calls, 3)
  })

  it('refuses envelopes sealed by a different installation, naming both key ids', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({ source: async () => PAYLOAD_TEXT })
    await assert.rejects(
      () => provider.protectorKeyFor(['ffffffffffffffff']),
      error => {
        assert.ok(error instanceof WorkBuddyElectronPathError)
        assert.equal(error.reasonCode, 'encrypted-credential-unreadable')
        assert.match(error.message, /does not match the credential's envelope \(id ffffffffffffffff\)/)
        return true
      },
    )
  })

  it('refuses an envelope that names no key id at all', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({ source: async () => PAYLOAD_TEXT })
    await assert.rejects(() => provider.protectorKeyFor([]), /carries no key ids/)
  })

  it('reports an unusable payload without echoing its content', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({ source: async () => 'not-json-at-all' })
    await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), /unusable at-rest payload/)
    await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
      assert.ok(!error.message.includes('not-json'))
      return true
    })
  })

  it('reports a helper that returned an unusable payload, without echoing it', async () => {
    const binary = await fakeBinary()
    // A helper that prints whitespace: `spawnAt` trims it, but the seam does
    // not, so the seam sees a non-empty string and the payload validation is
    // what rejects it — with a diagnosis that never echoes the text.
    const provider = new WorkBuddyAtRestKeyProvider({ electronPath: binary, spawnHelper: async () => '   ' })
    await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
      assert.equal(error.reasonCode, 'encrypted-credential-unreadable')
      assert.match(error.message, /unusable at-rest payload/)
      return true
    })
  })

  it('reports a helper that could not run, naming the binary and the reason only', async () => {
    // The real spawn path against a plain Node binary: the private
    // `workbuddyStorage` binding does not exist there, so the helper exits
    // non-zero. This is the one seam that runs a subprocess — a plain Node,
    // never the WorkBuddy app — and the error carries the path plus the exit
    // code, not anything the helper printed.
    const provider = new WorkBuddyAtRestKeyProvider({ electronPath: process.execPath, timeoutMs: 20_000 })
    await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
      assert.equal(error.reasonCode, 'encrypted-credential-unreadable')
      assert.match(error.message, /the WorkBuddy key helper \(.*\) (exited with code|timed out or was killed|produced no payload)/)
      return true
    })
  })

  it('reports a helper that failed, with the binary path and reason only', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      spawnHelper: async () => { throw new Error('boom-secret-should-not-leak') },
      electronPath: '/definitely/not/here',
    })
    await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
      assert.equal(error.reasonCode, 'electron-path-invalid')
      assert.match(error.message, /not available at \/definitely\/not\/here/)
      return true
    })
  })

  it('spawns the resolved default path exactly once, and passes the payload through', async () => {
    const calls = []
    const defaultPath = await fakeBinary()
    const provider = new WorkBuddyAtRestKeyProvider({
      defaultElectronPaths: [defaultPath],
      discovery: 'none',
      spawnHelper: async path => { calls.push(path); return PAYLOAD_TEXT },
    })
    assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
    assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
    assert.deepEqual(calls, [defaultPath])
  })

  it('uses the configured path as-is and never falls back to a default', async () => {
    const calls = []
    const chosenPath = await fakeBinary()
    const otherPath = await fakeBinary()
    const provider = new WorkBuddyAtRestKeyProvider({
      electronPath: chosenPath,
      defaultElectronPaths: [otherPath],
      discovery: 'macos-workbuddy',
      spawnHelper: async path => { calls.push(path); return PAYLOAD_TEXT },
    })
    await provider.protectorKeyFor([KEY_ID])
    assert.deepEqual(calls, [chosenPath])
  })

  it('prefers the env variable over the platform default', async () => {
    const previous = process.env[WORKBUDDY_ELECTRON_BIN_ENV]
    process.env[WORKBUDDY_ELECTRON_BIN_ENV] = '/opt/wb-from-env'
    try {
      const provider = new WorkBuddyAtRestKeyProvider({ defaultElectronPaths: ['/opt/workbuddy/WorkBuddy.exe'] })
      assert.equal(provider.helperPath(), '/opt/wb-from-env')
    } finally {
      if (previous === undefined) delete process.env[WORKBUDDY_ELECTRON_BIN_ENV]
      else process.env[WORKBUDDY_ELECTRON_BIN_ENV] = previous
    }
  })

  it('treats a blank env variable as unconfigured, and defaults to no discovery and no default path', async () => {
    const previous = process.env[WORKBUDDY_ELECTRON_BIN_ENV]
    process.env[WORKBUDDY_ELECTRON_BIN_ENV] = '   '
    try {
      // The no-arg default must be the safe one: a provider that was never told
      // which product it serves cannot reach for another product's binary.
      const bare = new WorkBuddyAtRestKeyProvider()
      assert.equal(bare.helperPath(), undefined)
      await assert.rejects(() => bare.protectorKeyFor([KEY_ID]), error => {
        assert.equal(error.reasonCode, 'electron-binary-unavailable')
        assert.match(error.message, /set WORKBUDDY_ELECTRON_BIN/)
        return true
      })
    } finally {
      if (previous === undefined) delete process.env[WORKBUDDY_ELECTRON_BIN_ENV]
      else process.env[WORKBUDDY_ELECTRON_BIN_ENV] = previous
    }
  })
})

describe('platform default paths', () => {
  it('names one candidate per product on Windows, and none outside it', () => {
    const isWindows = process.platform === 'win32'
    const cn = defaultWorkBuddyElectronPaths('cn')
    const ai = defaultWorkBuddyElectronPaths('ai')
    if (isWindows) {
      assert.ok(cn.length > 0)
      assert.ok(cn[0].endsWith('WorkBuddy\\WorkBuddy.exe'))
      assert.ok(ai.length > 0)
      assert.ok(ai[0].endsWith('WorkBuddyAI\\WorkBuddyAI.exe'))
      // The two products never share a path.
      assert.ok(!cn.some(path => ai.includes(path)))
    } else {
      assert.deepEqual(cn, [])
      assert.deepEqual(ai, [])
    }

  })

  it('defaults the macOS app for cn only', () => {
    const isDarwin = process.platform === 'darwin'
    const isWindows = process.platform === 'win32'
    // The international app has a verified layout on Windows only; on macOS
    // nothing is defaulted and `WORKBUDDY_ELECTRON_BIN` stays the only route.
    if (!isWindows) assert.deepEqual(defaultWorkBuddyElectronPaths('ai'), [])
    if (isDarwin) {
      assert.deepEqual(defaultWorkBuddyElectronPaths('cn'), ['/Applications/WorkBuddy.app/Contents/MacOS/Electron'])
      assert.equal(defaultWorkBuddyElectronPath('cn'), '/Applications/WorkBuddy.app/Contents/MacOS/Electron')
    } else if (!isWindows) {
      assert.deepEqual(defaultWorkBuddyElectronPaths('cn'), [])
      assert.equal(defaultWorkBuddyElectronPath('cn'), undefined)
    }
  })

  it('declines to look for anything for an unknown variant id', () => {
    assert.deepEqual(defaultWorkBuddyElectronPaths('other'), [])
    assert.equal(defaultWorkBuddyElectronPath('other'), undefined)
  })

  it('enables Spotlight discovery for cn on darwin only', () => {
    assert.equal(defaultDiscoveryFor('cn'), process.platform === 'darwin' ? 'macos-workbuddy' : 'none')
    assert.equal(defaultDiscoveryFor('ai'), 'none')
  })
})

describe('macOS Spotlight discovery', () => {
  /** Tools that record every call so "not called" can be asserted. */
  function recordingTools({ bundles = [], identifier = WORKBUDDY_CN_BUNDLE_ID, version = '5.6.2', findAppsError } = {}) {
    const calls = { findApps: 0, bundleIdentifier: 0, bundleVersion: 0 }
    return {
      calls,
      tools: {
        findApps: async () => {
          calls.findApps += 1
          if (findAppsError !== undefined) throw findAppsError
          return bundles
        },
        bundleIdentifier: async () => {
          calls.bundleIdentifier += 1
          return identifier
        },
        bundleVersion: async () => {
          calls.bundleVersion += 1
          return version
        },
      },
    }
  }

  it('does not search at all when the platform default already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-discovery-default-'))
    try {
      const bundle = await fakeAppBundle(root)
      const electronPath = join(bundle, 'Contents', 'MacOS', 'Electron')
      const { calls, tools } = recordingTools()
      await withDarwinPlatform(async () => {
        const provider = new WorkBuddyAtRestKeyProvider({
          discovery: 'macos-workbuddy',
          defaultElectronPaths: [electronPath],
          tools,
          spawnHelper: async path => {
            assert.equal(path, electronPath, 'the default binary is spawned as-is')
            return PAYLOAD_TEXT
          },
        })
        // Diagnostics name the default that will be used, never a search result.
        assert.equal(provider.helperPath(), electronPath)
        assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
      })
      assert.equal(calls.findApps, 0, 'a present default path must never start a search')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds the app, proves its identity, and spawns it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-discovery-found-'))
    try {
      const bundle = await fakeAppBundle(root)
      const electronPath = join(bundle, 'Contents', 'MacOS', 'Electron')
      const spawned = []
      await withDarwinPlatform(async () => {
        const { tools } = recordingTools({ bundles: [bundle] })
        const provider = new WorkBuddyAtRestKeyProvider({
          discovery: 'macos-workbuddy',
          defaultElectronPaths: ['/nonexistent/WorkBuddy.app/Contents/MacOS/Electron'],
          tools,
          spawnHelper: async path => { spawned.push(path); return PAYLOAD_TEXT },
        })
        assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
      })
      assert.deepEqual(spawned, [electronPath])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('excludes a candidate that declares a different bundle id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-discovery-other-'))
    try {
      const bundle = await fakeAppBundle(root)
      await withDarwinPlatform(async () => {
        const { calls, tools } = recordingTools({ bundles: [bundle], identifier: 'com.example.other' })
        const provider = new WorkBuddyAtRestKeyProvider({
          discovery: 'macos-workbuddy',
          defaultElectronPaths: [],
          tools,
        })
        await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
          assert.equal(error.reasonCode, 'electron-binary-not-found')
          return true
        })
        assert.ok(calls.bundleIdentifier >= 1, 'identity is checked before anything is executed')
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports more than one candidate as ambiguous and lists them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-discovery-many-'))
    try {
      const first = await fakeAppBundle(root, 'WorkBuddy.app')
      const second = await fakeAppBundle(root, 'WorkBuddy (old).app')
      await withDarwinPlatform(async () => {
        const { tools } = recordingTools({ bundles: [first, second] })
        const provider = new WorkBuddyAtRestKeyProvider({ discovery: 'macos-workbuddy', defaultElectronPaths: [], tools })
        await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
          assert.equal(error.reasonCode, 'electron-binary-ambiguous')
          assert.match(error.message, /WorkBuddy\.app/)
          assert.match(error.message, /WorkBuddy \(old\)\.app/)
          return true
        })
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports an unfinished check as incomplete, never as "the app is missing"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-discovery-incomplete-'))
    try {
      const bundle = await fakeAppBundle(root)
      await withDarwinPlatform(async () => {
        // An unreadable plist is "we could not check this candidate", so the
        // remaining candidate may not be claimed as unique.
        const tools = {
          findApps: async () => [bundle],
          bundleIdentifier: async () => undefined,
          bundleVersion: async () => '5.6.2',
        }
        const provider = new WorkBuddyAtRestKeyProvider({ discovery: 'macos-workbuddy', defaultElectronPaths: [], tools })
        await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
          assert.equal(error.reasonCode, 'electron-discovery-incomplete')
          return true
        })
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a failed search as incomplete rather than as an absent app', async () => {
    await withDarwinPlatform(async () => {
      const { tools } = recordingTools({ findAppsError: new Error('mdfind unavailable') })
      const provider = new WorkBuddyAtRestKeyProvider({ discovery: 'macos-workbuddy', defaultElectronPaths: [], tools })
      await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
        assert.equal(error.reasonCode, 'electron-discovery-incomplete')
        assert.match(error.message, /not proof that the app is missing/)
        return true
      })
    })
  })

  it('stops a hanging search at the discovery budget, independent of the helper timeout', async () => {
    await withDarwinPlatform(async () => {
      // A tool that respects its signal, like the real execFile-backed one
      // does: the discovery budget must be what stops a hanging search.
      const tools = {
        findApps: signal => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('the search was abandoned')), { once: true })
        }),
        bundleIdentifier: async () => WORKBUDDY_CN_BUNDLE_ID,
        bundleVersion: async () => '5.6.2',
      }
      const provider = new WorkBuddyAtRestKeyProvider({
        discovery: 'macos-workbuddy',
        defaultElectronPaths: [],
        tools,
        discoveryBudgetMs: 20,
        timeoutMs: 30_000,
      })
      await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
        assert.equal(error.reasonCode, 'electron-discovery-incomplete')
        return true
      })
    })
  })

  it('retries discovery after a failure, and caches only a success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-discovery-retry-'))
    try {
      const bundle = await fakeAppBundle(root)
      let attempts = 0
      const spawned = []
      await withDarwinPlatform(async () => {
        const provider = new WorkBuddyAtRestKeyProvider({
          discovery: 'macos-workbuddy',
          defaultElectronPaths: [],
          tools: {
            findApps: async () => { attempts += 1; return attempts === 1 ? [] : [bundle] },
            bundleIdentifier: async () => WORKBUDDY_CN_BUNDLE_ID,
            bundleVersion: async () => '5.6.2',
          },
          spawnHelper: async path => { spawned.push(path); return PAYLOAD_TEXT },
        })
        // A failed search is not cached as a permanent failure.
        await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
          assert.equal(error.reasonCode, 'electron-binary-not-found')
          return true
        })
        assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
        // The discovered path is what gets spawned, and only once.
        assert.deepEqual(spawned, [join(bundle, 'Contents', 'MacOS', 'Electron')])
        // The discovered path is cached, so a third request searches no more.
        assert.deepEqual(await provider.protectorKeyFor([KEY_ID]), KEY)
        assert.equal(attempts, 2)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to discover anything when discovery is off, even on darwin', async () => {
    await withDarwinPlatform(async () => {
      const { calls, tools } = recordingTools()
      const provider = new WorkBuddyAtRestKeyProvider({ discovery: 'none', defaultElectronPaths: [], tools })
      await assert.rejects(() => provider.protectorKeyFor([KEY_ID]), error => {
        assert.equal(error.reasonCode, 'electron-binary-unavailable')
        return true
      })
      assert.equal(calls.findApps, 0, 'discovery off means no search at all')
    })
  })
})
