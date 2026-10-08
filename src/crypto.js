/**
 * Encryption for Echo Notes.
 *
 * Design constraints, in priority order:
 *
 * 1. **The key never rests on disk in plaintext.** The passphrase is stretched
 *    with `scrypt` (memory-hard) into a key-encryption key; only a random data
 *    key wrapped by that KEK is stored. Changing the passphrase therefore never
 *    rewrites note bodies.
 * 2. **Per-note random IV, never reused.** A deterministic IV under one key is
 *    a catastrophic AES-GCM failure; every `encrypt` call draws fresh bytes.
 * 3. **Tampering is detected, not tolerated.** AES-256-GCM authenticates the
 *    ciphertext, and the note id is bound in as additional authenticated data
 *    so a ciphertext cannot be moved between notes.
 * 4. **Wrong passphrase is distinguishable from corrupt data.** A wrapped-key
 *    failure means "wrong passphrase"; a body failure means "corrupt or moved".
 *    The UI must tell these apart, so they are separate error codes.
 *
 * Runs on `node:crypto` only — no dependencies, so the same module is testable
 * in isolation and auditable by reading it.
 *
 * @module echo-notes/crypto
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

/** scrypt cost parameters. N=2^15 keeps an interactive unlock near ~100ms. */
export const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 })

/** Format version written into every envelope, so the format can evolve. */
export const ENVELOPE_VERSION = 1

/**
 * A typed failure with a stable `code` the UI and tools branch on.
 */
export class CryptoError extends Error {
  /**
   * @param {'wrong-passphrase' | 'tampered' | 'bad-envelope' | 'invalid-input'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'CryptoError'
    this.code = code
  }
}

/**
 * Derive a key-encryption key from a passphrase and salt.
 * @param {string} passphrase
 * @param {Buffer} salt
 * @returns {Promise<Buffer>}
 */
export async function deriveKek(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new CryptoError('invalid-input', 'passphrase must be a non-empty string')
  }
  return /** @type {Buffer} */ (await scrypt(passphrase, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  }))
}

/**
 * Create a fresh vault key material: a random data key wrapped by a passphrase.
 * @param {string} passphrase
 * @returns {Promise<{ wrappedKey: string, salt: string, verifier: string }>}
 */
export async function createKeyring(passphrase) {
  const salt = randomBytes(16)
  const kek = await deriveKek(passphrase, salt)
  const dataKey = randomBytes(32)
  const wrappedKey = seal(dataKey, kek, 'keyring')
  return {
    wrappedKey: wrappedKey.toString('base64'),
    salt: salt.toString('base64'),
    verifier: verifierOf(kek),
  }
}

/**
 * Unwrap the data key with a passphrase.
 * @param {string} passphrase
 * @param {{ wrappedKey: string, salt: string }} keyring
 * @returns {Promise<Buffer>} the raw 32-byte data key
 * @throws {CryptoError} with code `wrong-passphrase` when the KEK does not fit.
 */
export async function unlockKeyring(passphrase, keyring) {
  let kek
  try {
    kek = await deriveKek(passphrase, Buffer.from(keyring.salt, 'base64'))
  } catch (error) {
    if (error instanceof CryptoError) throw error
    throw new CryptoError('bad-envelope', 'keyring salt is not valid base64')
  }
  try {
    return open(Buffer.from(keyring.wrappedKey, 'base64'), kek, 'keyring')
  } catch {
    throw new CryptoError('wrong-passphrase', 'the passphrase does not unlock this vault')
  }
}

/**
 * Wrap an existing data key under a new passphrase.
 *
 * This is what makes a passphrase change cheap: note bodies are encrypted with
 * the *data key*, so changing the passphrase only rewraps that one key and
 * never touches a single note.
 *
 * @param {Buffer} dataKey the 32-byte data key to preserve
 * @param {string} passphrase the new passphrase
 * @returns {Promise<{ wrappedKey: string, salt: string, verifier: string }>}
 */
export async function wrapWith(dataKey, passphrase) {
  assertKey(dataKey)
  const salt = randomBytes(16)
  const kek = await deriveKek(passphrase, salt)
  return {
    wrappedKey: seal(dataKey, kek, 'keyring').toString('base64'),
    salt: salt.toString('base64'),
    verifier: verifierOf(kek),
  }
}

/**
 * A fast equality check for a derived key, used to confirm an unlock attempt
 * before touching any note.
 * @param {Buffer} kek
 * @returns {string}
 */
export function verifierOf(kek) {
  return createHashHex(kek)
}

/**
 * SHA-256 of a buffer as lowercase hex.
 * @param {Buffer} buffer
 * @returns {string}
 */
function createHashHex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Encrypt one plaintext under a data key.
 *
 * @param {string} plaintext
 * @param {Buffer} dataKey 32-byte key
 * @param {string} aad note identity bound into the tag (e.g. the note id)
 * @returns {string} base64 envelope `v1.iv.tag.ciphertext`
 */
export function encryptNote(plaintext, dataKey, aad) {
  const sealed = seal(Buffer.from(plaintext, 'utf8'), dataKey, aad)
  return `${ENVELOPE_VERSION}.${sealed.toString('base64')}`
}

/**
 * Decrypt one note body.
 *
 * @param {string} envelope base64 envelope produced by {@link encryptNote}
 * @param {Buffer} dataKey 32-byte key
 * @param {string} aad the same note identity used to encrypt
 * @returns {string} the original UTF-8 plaintext
 * @throws {CryptoError} `tampered` when authentication fails, `bad-envelope` on malformed input.
 */
export function decryptNote(envelope, dataKey, aad) {
  if (typeof envelope !== 'string') throw new CryptoError('bad-envelope', 'envelope must be a string')
  const parts = envelope.split('.')
  if (parts.length !== 2) throw new CryptoError('bad-envelope', 'envelope must have two segments')
  const [version, payload] = parts
  if (Number(version) !== ENVELOPE_VERSION) {
    throw new CryptoError('bad-envelope', `unsupported envelope version ${version}`)
  }
  let bytes
  try {
    bytes = Buffer.from(payload, 'base64')
  } catch {
    throw new CryptoError('bad-envelope', 'envelope payload is not valid base64')
  }
  try {
    return open(bytes, dataKey, aad).toString('utf8')
  } catch (error) {
    if (error instanceof CryptoError) throw error
    throw new CryptoError('tampered', 'note failed authentication: wrong key, edited, or moved between notes')
  }
}

/**
 * AES-256-GCM seal: `iv(12) | tag(16) | ciphertext`.
 * @param {Buffer} plaintext
 * @param {Buffer} key
 * @param {string} aad
 * @returns {Buffer}
 */
function seal(plaintext, key, aad) {
  assertKey(key)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(String(aad), 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

/**
 * AES-256-GCM open for the layout {@link seal} writes.
 * @param {Buffer} sealed
 * @param {Buffer} key
 * @param {string} aad
 * @returns {Buffer}
 */
function open(sealed, key, aad) {
  assertKey(key)
  if (sealed.length < 28) throw new CryptoError('bad-envelope', 'sealed payload is too short')
  const iv = sealed.subarray(0, 12)
  const tag = sealed.subarray(12, 28)
  const ciphertext = sealed.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(String(aad), 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * Reject a key of the wrong length with a clear code rather than a raw OpenSSL error.
 * @param {Buffer} key
 */
function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new CryptoError('invalid-input', 'key must be a 32-byte Buffer')
  }
}

/**
 * Constant-time comparison helper for verifiers.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
