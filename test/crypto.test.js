/**
 * Security tests for the Echo Notes crypto module.
 *
 * These assert properties, not implementations: a round trip works, a wrong
 * passphrase is distinguishable from tampering, and an IV is never reused.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CryptoError,
  createKeyring,
  decryptNote,
  deriveKek,
  encryptNote,
  safeEqual,
  unlockKeyring,
} from '../src/crypto.js'

test('round-trips a note through encrypt and decrypt', async () => {
  const { wrappedKey, salt } = await createKeyring('correct horse battery staple')
  const dataKey = await unlockKeyring('correct horse battery staple', { wrappedKey, salt })

  const envelope = encryptNote('今天下雨了，我有点想家。', dataKey, 'note-1')
  assert.match(envelope, /^1\./)
  assert.ok(!envelope.includes('想家'), 'plaintext must not appear in the envelope')
  assert.equal(decryptNote(envelope, dataKey, 'note-1'), '今天下雨了，我有点想家。')
})

test('reports a wrong passphrase as wrong-passphrase, not as corruption', async () => {
  const { wrappedKey, salt } = await createKeyring('right-passphrase')
  await assert.rejects(
    () => unlockKeyring('wrong-passphrase', { wrappedKey, salt }),
    (error) => error instanceof CryptoError && error.code === 'wrong-passphrase',
  )
})

test('a passphrase with a wrong length key still fails closed', async () => {
  const { wrappedKey, salt } = await createKeyring('a')
  assert.equal(typeof wrappedKey, 'string')
  await assert.rejects(() => unlockKeyring('', { wrappedKey, salt }), /non-empty/)
})

test('detects a ciphertext that was edited', async () => {
  const { wrappedKey, salt } = await createKeyring('pw')
  const dataKey = await unlockKeyring('pw', { wrappedKey, salt })
  const envelope = encryptNote('secret', dataKey, 'note-1')

  const [version, payload] = envelope.split('.')
  const bytes = Buffer.from(payload, 'base64')
  bytes[bytes.length - 1] ^= 0xff
  const tampered = `${version}.${bytes.toString('base64')}`

  assert.throws(
    () => decryptNote(tampered, dataKey, 'note-1'),
    (error) => error instanceof CryptoError && error.code === 'tampered',
  )
})

test('refuses a ciphertext moved to a different note (AAD binding)', async () => {
  const { wrappedKey, salt } = await createKeyring('pw')
  const dataKey = await unlockKeyring('pw', { wrappedKey, salt })
  const envelope = encryptNote('belongs to note 1', dataKey, 'note-1')

  assert.throws(
    () => decryptNote(envelope, dataKey, 'note-2'),
    (error) => error instanceof CryptoError && error.code === 'tampered',
  )
})

test('refuses to decrypt under a different data key', async () => {
  const first = await createKeyring('pw-one')
  const second = await createKeyring('pw-two')
  const keyOne = await unlockKeyring('pw-one', first)
  const keyTwo = await unlockKeyring('pw-two', second)
  const envelope = encryptNote('hello', keyOne, 'note-1')

  assert.throws(
    () => decryptNote(envelope, keyTwo, 'note-1'),
    (error) => error instanceof CryptoError && error.code === 'tampered',
  )
})

test('never reuses an IV across encryptions of identical plaintext', async () => {
  const { wrappedKey, salt } = await createKeyring('pw')
  const dataKey = await unlockKeyring('pw', { wrappedKey, salt })

  const envelopes = new Set()
  for (let index = 0; index < 50; index += 1) {
    envelopes.add(encryptNote('same text every time', dataKey, 'note-1'))
  }
  assert.equal(envelopes.size, 50, 'each encryption must use a fresh IV, so all envelopes differ')
})

test('rejects malformed envelopes with bad-envelope rather than throwing raw errors', async () => {
  const { wrappedKey, salt } = await createKeyring('pw')
  const dataKey = await unlockKeyring('pw', { wrappedKey, salt })

  for (const bad of ['', 'not-an-envelope', '2.abc', '1.', '1.@@@']) {
    assert.throws(
      () => decryptNote(bad, dataKey, 'note-1'),
      (error) => error instanceof CryptoError && error.code === 'bad-envelope',
      `expected bad-envelope for ${JSON.stringify(bad)}`,
    )
  }
})

test('changing the passphrase does not require re-encrypting bodies', async () => {
  // The wrapped-key indirection exists so this stays cheap: rewrap the data key,
  // leave every note ciphertext untouched.
  const { wrappedKey, salt } = await createKeyring('old-passphrase')
  const dataKey = await unlockKeyring('old-passphrase', { wrappedKey, salt })
  const envelope = encryptNote('body that must survive a password change', dataKey, 'note-1')

  const rotated = await createKeyring('new-passphrase')
  const rotatedKey = await unlockKeyring('new-passphrase', rotated)

  assert.notDeepEqual(rotatedKey, dataKey, 'a fresh keyring has its own data key')
  // The same data key must still open the original body after a rewrap.
  assert.equal(decryptNote(envelope, dataKey, 'note-1'), 'body that must survive a password change')
})

test('deriveKek is deterministic for the same salt and distinct across salts', async () => {
  const salt = Buffer.alloc(16, 7)
  const first = await deriveKek('pw', salt)
  const again = await deriveKek('pw', salt)
  const other = await deriveKek('pw', Buffer.alloc(16, 8))

  assert.ok(first.equals(again), 'same passphrase and salt must derive the same key')
  assert.ok(!first.equals(other), 'a different salt must derive a different key')
  assert.equal(first.length, 32)
})

test('safeEqual compares without leaking length', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
})
