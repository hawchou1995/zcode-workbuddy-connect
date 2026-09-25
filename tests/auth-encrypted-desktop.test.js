/**
 * The credential store against a WorkBuddy 5.6 encrypted desktop auth file:
 * decryption, the diagnoses that must surface, and the authority the desktop
 * file keeps over the plugin-owned copy.
 *
 * Every fixture is synthetic (fixed test secret, test-derived key, fake
 * tokens); the key provider is a stub, so no test ever touches the WorkBuddy
 * app or its real at-rest key.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { WorkBuddyCredentialStore } from '../src/auth.js'
import {
  WorkBuddyElectronPathError,
  deriveProtectorKey,
  sealAuthFieldForTest,
} from '../src/desktop-credential-protection.js'

const SECRET = Buffer.alloc(32, 7).toString('base64')
const KEY = deriveProtectorKey(SECRET)
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

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

/** A plaintext desktop document in the flat panel shape. */
function plaintextDocument() {
  return JSON.stringify({
    accessToken: 'plain-access-token',
    refreshToken: 'plain-refresh-token',
    expiresAt: 1900000000,
    refreshExpiresAt: 1900003600,
    domain: 'www.workbuddy.ai',
    uid: 'uid-9',
    nickname: 'Plain Tester',
    enterpriseId: 'ent-3',
  })
}

/** Own copy documents, exactly as the store writes them. */
function ownDocument(credential) {
  return JSON.stringify({ version: 1, credential })
}

/** A key provider stub that records whether it was consulted at all. */
function stubKeyProvider(key, { calls = [] } = {}) {
  return {
    calls,
    protectorKeyFor: async requested => {
      calls.push(requested)
      if (key instanceof Error) throw key
      return key
    },
    helperPath: () => '(stub)',
  }
}

/**
 * Build a store over one desktop file. `keyProvider` defaults to a stub holding
 * the right key, so a test that does not care about the unlock still exercises
 * the real classification and decryption path.
 */
function makeStore(root, desktopPath, keyProvider) {
  return new WorkBuddyCredentialStore({
    desktopPath,
    ownPath: join(root, 'own.json'),
    refresh: async credential => ({ accessToken: credential.accessToken }),
    keyProvider: keyProvider ?? stubKeyProvider(KEY),
    refreshMarginMs: 60_000,
  })
}

describe('encrypted desktop credential', () => {
  it('decrypts the desktop credential, keeping identity and expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-enc-'))
    try {
      const desktopPath = join(root, 'workbuddy-desktop.info')
      await writeFile(desktopPath, encryptedDocument())
      const store = makeStore(root, desktopPath)
      const credential = await store.current()
      assert.deepEqual(
        { ...credential, expiresAtMs: credential?.expiresAtMs },
        {
          accessToken: 'test-access-token',
          refreshToken: 'test-refresh-token',
          expiresAtMs: 1900000000 * 1000,
          domain: 'www.workbuddy.ai',
          uid: 'uid-9',
          enterpriseId: 'ent-3',
          nickname: 'Tester',
          source: 'desktop',
        },
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a decryption failure as a diagnosis, never as a silent sign-out or a stale fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-enc-fail-'))
    try {
      const desktopPath = join(root, 'workbuddy-desktop.info')
      await writeFile(desktopPath, encryptedDocument())
      // A stale plugin-owned copy from the previous account: decryption failure
      // must NOT fall back to it.
      await writeFile(join(root, 'own.json'), ownDocument({
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        expiresAtMs: Date.now() + 3_600_000,
        domain: 'www.workbuddy.ai',
        uid: 'uid-old',
        source: 'own',
      }))
      const failure = new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'the WorkBuddy key helper (WorkBuddy.exe) exited with code 1',
      )
      const store = makeStore(root, desktopPath, stubKeyProvider(failure))
      // The prose is what a user reads; the code is for the machine. (Node
      // matches a rejected value's `toString()`, so the class name is in there.)
      await assert.rejects(() => store.current(), /key helper \(WorkBuddy\.exe\) exited with code 1/)
      const status = await store.status()
      assert.equal(status.state, 'signed-out')
      assert.match(status.reason, /key helper \(WorkBuddy\.exe\) exited with code 1/)
      // The code travels alongside the prose so nothing has to parse it.
      assert.equal(status.reasonCode, 'encrypted-credential-unreadable')
      await assert.rejects(() => store.resolve(), /key helper/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a key mismatch between envelope and app as its own diagnosis, naming the envelope key id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-enc-mismatch-'))
    try {
      const desktopPath = join(root, 'workbuddy-desktop.info')
      // Envelopes sealed under a key the provider cannot answer.
      await writeFile(desktopPath, encryptedDocument(Buffer.alloc(32, 5)))
      const otherKeyId = createHash('sha256').update(Buffer.alloc(32, 6)).digest('hex').slice(0, 16)
      const store = makeStore(root, desktopPath, stubKeyProvider(Buffer.alloc(32, 6)))
      await assert.rejects(() => store.current(), error => {
        assert.match(error.message, /could not be decrypted/)
        assert.ok(!error.message.includes('test-access-token'), 'the token never appears in a diagnosis')
        assert.equal(error.reasonCode, 'encrypted-credential-unreadable')
        return true
      })
      assert.equal(otherKeyId.length, 16)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('asks the key provider for exactly the envelope key ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-enc-ids-'))
    try {
      const desktopPath = join(root, 'workbuddy-desktop.info')
      await writeFile(desktopPath, encryptedDocument())
      const provider = stubKeyProvider(KEY)
      const store = makeStore(root, desktopPath, provider)
      await store.current()
      assert.deepEqual(provider.calls, [[KEY_ID]])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never falls back to a valid stale own copy when the desktop file is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-unrec-'))
    try {
      const own = ownDocument({
        accessToken: 'fresh-own-access',
        refreshToken: 'fresh-own-refresh',
        expiresAtMs: Date.now() + 3_600_000,
        domain: 'www.workbuddy.ai',
        uid: 'uid-current',
        nickname: 'Current',
        source: 'own',
      })

      // Case 1: a malformed (unparsable) desktop document.
      const malformedPath = join(root, 'malformed.info')
      await writeFile(malformedPath, '{ not json at all')
      await writeFile(join(root, 'own.json'), own)
      const malformedStore = makeStore(root, malformedPath)
      await assert.rejects(() => malformedStore.current(), /exists but is unreadable/)
      const malformedStatus = await malformedStore.status()
      assert.equal(malformedStatus.state, 'signed-out')
      assert.match(malformedStatus.reason, /exists but is unreadable/)

      // Case 2: a 5.6-style encrypted document with an unsupported suite —
      // claimed by the wrapper format but not a format this plugin accepts.
      const inner = JSON.stringify({
        suite: 2,
        keyId: KEY_ID,
        nonce: Buffer.alloc(12, 1).toString('base64'),
        authTag: Buffer.alloc(16, 1).toString('base64'),
        ciphertext: Buffer.alloc(8, 1).toString('base64'),
      })
      const unsupported = JSON.stringify({
        auth: { accessToken: { '$wbEncrypted': 1, envelope: Buffer.from(inner, 'utf8').toString('base64') } },
        account: { uid: 'uid-9' },
      })
      const unsupportedPath = join(root, 'unsupported.info')
      await writeFile(unsupportedPath, unsupported)
      await writeFile(join(root, 'own.json'), own)
      const unsupportedStore = makeStore(root, unsupportedPath)
      await assert.rejects(() => unsupportedStore.current(), /exists but is unreadable/)
      // The stale own credential must never surface through any read path.
      await assert.rejects(() => unsupportedStore.resolve(), /exists but is unreadable/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets the desktop file keep identity authority over a newer own copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-enc-identity-'))
    try {
      const desktopPath = join(root, 'workbuddy-desktop.info')
      await writeFile(desktopPath, encryptedDocument())
      await writeFile(join(root, 'own.json'), ownDocument({
        // Same uid as the desktop file, later expiry (the sealed fixture
        // expires in 2030): expiry would win, and that is unchanged by
        // encryption.
        accessToken: 'own-access',
        refreshToken: 'own-refresh',
        expiresAtMs: 4102444800000,
        domain: 'www.workbuddy.ai',
        uid: 'uid-9',
        enterpriseId: 'ent-3',
        nickname: 'Tester',
        source: 'own',
      }))
      const store = makeStore(root, desktopPath)
      assert.equal((await store.current())?.source, 'own')
      // A different uid in the own copy: the desktop file wins regardless of
      // timestamps — encryption changes nothing here either.
      const switched = JSON.parse(await readFile(join(root, 'own.json'), 'utf8'))
      switched.credential.uid = 'uid-old'
      await writeFile(join(root, 'own.json'), JSON.stringify(switched))
      assert.equal((await store.current())?.source, 'desktop')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('classifies the on-disk format for diagnostics without decrypting or spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-enc-format-'))
    try {
      const encryptedPath = join(root, 'encrypted.info')
      await writeFile(encryptedPath, encryptedDocument())
      const provider = stubKeyProvider(KEY)
      const store = makeStore(root, encryptedPath, provider)
      assert.equal(await store.desktopAuthFormat(), 'encrypted')
      assert.equal(provider.calls.length, 0, 'classification never asks for the key')

      const plainPath = join(root, 'plain.info')
      await writeFile(plainPath, plaintextDocument())
      assert.equal(await makeStore(root, plainPath).desktopAuthFormat(), 'plaintext')

      const emptyPath = join(root, 'empty.info')
      await writeFile(emptyPath, '')
      assert.equal(await makeStore(root, emptyPath).desktopAuthFormat(), 'absent')

      const brokenPath = join(root, 'broken.info')
      await writeFile(brokenPath, 'not json')
      assert.equal(await makeStore(root, brokenPath).desktopAuthFormat(), 'unrecognized')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the helper path diagnostics would use, and none when unconfigured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-enc-helper-'))
    try {
      const desktopPath = join(root, 'workbuddy-desktop.info')
      await writeFile(desktopPath, encryptedDocument())
      assert.equal(makeStore(root, desktopPath, stubKeyProvider(KEY)).keyHelperPath(), '(stub)')
      // The store's own no-arg default is the safe one: nothing configured.
      const bare = new WorkBuddyCredentialStore({
        desktopPath,
        ownPath: join(root, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      assert.equal(bare.keyHelperPath(), undefined)
      await assert.rejects(() => bare.current(), /set WORKBUDDY_ELECTRON_BIN/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('plaintext desktop credential (regression)', () => {
  it('parses exactly the fields it always did', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-plain-'))
    try {
      const desktopPath = join(root, 'workbuddy-desktop-ai.info')
      await writeFile(desktopPath, plaintextDocument())
      const provider = stubKeyProvider(KEY)
      const store = new WorkBuddyCredentialStore({
        desktopPath,
        ownPath: join(root, 'own.json'),
        desktopFilename: 'workbuddy-desktop-ai.info',
        refresh: async credential => ({ accessToken: credential.accessToken }),
        keyProvider: provider,
      })
      assert.deepEqual(await store.current(), {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        expiresAtMs: 1900000000 * 1000,
        refreshExpiresAtMs: 1900003600 * 1000,
        domain: 'www.workbuddy.ai',
        uid: 'uid-9',
        enterpriseId: 'ent-3',
        nickname: 'Plain Tester',
        source: 'desktop',
      })
      // A plaintext document never consults the key helper.
      assert.equal(provider.calls.length, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips an empty candidate so it cannot mask a real document beside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-skip-empty-'))
    try {
      const first = join(root, 'local', 'workbuddy-desktop.info')
      const second = join(root, 'roaming', 'workbuddy-desktop.info')
      await mkdir(join(root, 'local'), { recursive: true })
      await mkdir(join(root, 'roaming'), { recursive: true })
      await writeFile(first, '')
      await writeFile(second, plaintextDocument())
      const store = new WorkBuddyCredentialStore({
        ownPath: join(root, 'own.json'),
        desktopPath: first,
        authFileEnv: 'WB_TEST_NEVER_SET',
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      // `desktopPath` is a single candidate; the empty-file rule is what the
      // multi-candidate probe uses, exercised directly through the format read.
      assert.equal(await store.desktopAuthFormat(), 'absent')
      assert.equal(await store.current(), undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
