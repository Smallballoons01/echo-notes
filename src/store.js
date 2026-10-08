/**
 * The note store: in-memory index over the durable storage domain.
 *
 * The store is the single source of truth for note *metadata* and the only
 * writer of note bodies. Encryption is applied here rather than in the UI so
 * there is exactly one code path that can leak a plaintext note to disk.
 *
 * Storage layout (`storageDomain` tables):
 *   - `notes`     key = noteId, value = { id, createdAt, updatedAt, mood, tags, templateId, title, preview, encrypted, wordCount }
 *   - `revisions` key = `${noteId}#${seq}`, value = { noteId, seq, at, body }
 *   - `settings`  key = setting name, value = arbitrary JSON
 *
 * `preview` is deliberately *plaintext* and truncated: the list view and the
 * agent need to show something without unlocking. The body is the secret; a
 * 40-character preview is the documented trade-off, and encrypted notes mark
 * themselves so the UI can hide even that.
 *
 * @module echo-notes/store
 */

import { CryptoError, decryptNote, encryptNote } from './crypto.js'

/** Preview length kept in plaintext for the list view. */
export const PREVIEW_LENGTH = 40

/** Fields a note index row always carries. */
function emptyRow(id, now) {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    mood: null,
    tags: [],
    templateId: null,
    title: '',
    preview: '',
    encrypted: false,
    wordCount: 0,
    pinned: false,
  }
}

/**
 * Count "words" across scripts: CJK characters count individually, runs of
 * Latin letters/digits count as one word each.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const latin = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0
  return cjk + latin
}

/**
 * Derive a title from a body: the first non-empty line, stripped of Markdown
 * heading marks and capped.
 * @param {string} body
 * @returns {string}
 */
export function deriveTitle(body) {
  const line = String(body ?? '')
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0)
  if (!line) return ''
  return line.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').slice(0, 60)
}

/**
 * Build the plaintext preview used by the list view.
 * @param {string} body
 * @param {boolean} encrypted
 * @returns {string}
 */
export function derivePreview(body, encrypted) {
  if (encrypted) return ''
  const flattened = String(body ?? '').replace(/\s+/g, ' ').trim()
  return flattened.slice(0, PREVIEW_LENGTH)
}

/**
 * A note store bound to one vault session.
 *
 * Every mutating method is async because storage writes are async; the
 * in-memory maps are updated first so reads never await.
 */
export class NoteStore {
  /**
   * @param {object} options
   * @param {() => object | undefined} options.tables returns the open domain's tables, or undefined while locked
   * @param {() => Buffer | undefined} options.dataKey the unlocked 32-byte key, or undefined while locked
   * @param {() => number} [options.now] injectable clock for tests
   * @param {() => string} [options.idFactory] injectable id factory for tests
   */
  constructor(options) {
    this.tables = options.tables
    this.dataKey = options.dataKey
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? (() => defaultNoteId())
    this.encryptionEnabled = false
    /** @type {Map<string, any>} */
    this.rows = new Map()
    /** @type {Map<string, string>} */
    this.bodies = new Map()
    /** @type {{ noteId: string, seq: number, at: number, body: string }[]} */
    this.revisions = []
  }

  /** Load every persisted row into memory. Call once after the domain opens. */
  async hydrate() {
    const tables = this.tables()
    if (!tables) return
    for (const [id, stored] of tables.notes.entries()) {
      // The body lives in the same row but is kept out of the index row so the
      // list view never has to touch ciphertext. Split it on the way in.
      const { body, ...row } = stored
      this.rows.set(id, row)
      if (row.encrypted) this.encryptionEnabled = true
      if (typeof body === 'string') this.bodies.set(id, body)
    }
    for (const [, revision] of tables.revisions.entries()) this.revisions.push(revision)
    this.revisions.sort((a, b) => a.at - b.at)
  }

  /** Whether a data key is currently available. */
  get unlocked() {
    return this.dataKey() !== undefined
  }

  /**
   * Assert the vault is open; every body-touching operation requires it.
   * @returns {Buffer}
   */
  requireKey() {
    const key = this.dataKey()
    if (!key) throw new CryptoError('invalid-input', 'vault is locked: unlock it before reading or writing bodies')
    return key
  }

  /**
   * Create a note.
   *
   * @param {{ body?: string, mood?: string | null, tags?: string[], templateId?: string | null, title?: string, createdAt?: number, id?: string }} input
   * @returns {Promise<any>} the stored row
   */
  async create(input = {}) {
    const key = this.requireKey()
    const body = String(input.body ?? '')
    const id = input.id ?? this.idFactory()
    const createdAt = input.createdAt ?? this.now()
    const row = emptyRow(id, createdAt)
    row.mood = input.mood ?? null
    row.tags = normaliseTags(input.tags)
    row.templateId = input.templateId ?? null
    row.title = input.title ?? deriveTitle(body)
    row.wordCount = countWords(body)
    row.encrypted = input.encrypted === true || this.encryptionEnabled
    row.preview = derivePreview(body, row.encrypted)

    this.rows.set(id, row)
    this.bodies.set(id, body)
    await this.persistRow(row)
    await this.persistBody(id, body)
    return { ...row }
  }

  /**
   * Update a note's body and/or metadata, recording a revision when the body changes.
   *
   * @param {string} id
   * @param {{ body?: string, mood?: string | null, tags?: string[], title?: string, pinned?: boolean }} patch
   * @returns {Promise<any | undefined>}
   */
  async update(id, patch) {
    const key = this.requireKey()
    const row = this.rows.get(id)
    if (!row) return undefined

    if (patch.body !== undefined) {
      const body = String(patch.body)
      const storedPrevious = this.bodies.get(id) ?? ''
      const previous = row.encrypted
        ? decryptNote(storedPrevious, key, id)
        : storedPrevious
      if (previous !== body) {
        await this.recordRevision(id, previous, row.updatedAt)
      }
      this.bodies.set(id, body)
      row.wordCount = countWords(body)
      row.preview = derivePreview(body, row.encrypted)
      if (patch.title === undefined) row.title = deriveTitle(body)
    }
    if (patch.mood !== undefined) row.mood = patch.mood
    if (patch.tags !== undefined) row.tags = normaliseTags(patch.tags)
    if (patch.title !== undefined) row.title = patch.title
    if (patch.pinned !== undefined) row.pinned = Boolean(patch.pinned)

    row.updatedAt = this.now()
    await this.persistRow(row)
    if (this.bodies.has(id)) await this.persistBody(id, this.bodies.get(id))
    return { ...row }
  }

  /**
   * Read one note, decrypting its body.
   * @param {string} id
   * @returns {Promise<{ row: any, body: string } | undefined>}
   */
  async read(id) {
    const row = this.rows.get(id)
    if (!row) return undefined
    return { row: { ...row }, body: await this.readBody(id) }
  }

  /**
   * Decrypt just the body of a note.
   * @param {string} id
   * @returns {Promise<string>}
   */
  async readBody(id) {
    const row = this.rows.get(id)
    if (!row) return ''
    const stored = this.bodies.get(id)
    if (stored === undefined) return ''
    if (!row.encrypted) return stored
    return decryptNote(stored, this.requireKey(), id)
  }

  /**
   * Delete a note and its revisions.
   * @param {string} id
   * @returns {Promise<boolean>} whether anything was removed
   */
  async remove(id) {
    const row = this.rows.get(id)
    if (!row) return false
    this.rows.delete(id)
    this.bodies.delete(id)
    const tables = this.tables()
    if (tables) {
      await tables.notes.delete(id)
      for (const revision of this.revisions.filter((entry) => entry.noteId === id)) {
        await tables.revisions.delete(`${id}#${revision.seq}`)
      }
    }
    this.revisions = this.revisions.filter((entry) => entry.noteId !== id)
    return true
  }

  /**
   * List notes filtered along the axes the product cares about: time, mood, tag, template and text.
   *
   * @param {{
   *   from?: number, to?: number, moods?: string[], tags?: string[], templateId?: string,
   *   text?: string, limit?: number, order?: 'asc' | 'desc', pinnedFirst?: boolean
   * }} [filter]
   * @returns {any[]}
   */
  list(filter = {}) {
    const {
      from,
      to,
      moods,
      tags,
      templateId,
      text,
      limit,
      order = 'desc',
      pinnedFirst = false,
    } = filter

    let rows = [...this.rows.values()]
    if (from !== undefined) rows = rows.filter((row) => row.createdAt >= from)
    if (to !== undefined) rows = rows.filter((row) => row.createdAt <= to)
    if (moods && moods.length > 0) rows = rows.filter((row) => row.mood !== null && moods.includes(row.mood))
    if (tags && tags.length > 0) {
      rows = rows.filter((row) => tags.every((tag) => row.tags.includes(tag)))
    }
    if (templateId) rows = rows.filter((row) => row.templateId === templateId)
    if (text) {
      const needle = text.toLowerCase()
      rows = rows.filter((row) => {
        const storedBody = this.bodies.get(row.id) ?? ''
        const body = row.encrypted
          ? decryptNote(storedBody, this.requireKey(), row.id)
          : storedBody
        return matchesText(row, body, needle)
      })
    }

    // Tie-break on id so two notes created in the same millisecond still have a
    // stable, meaningful order: `sort` is stable, which would otherwise leave
    // same-timestamp notes in insertion order regardless of direction.
    rows.sort((a, b) => {
      const byTime = order === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt
      if (byTime !== 0) return byTime
      return order === 'asc' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
    })
    if (pinnedFirst) {
      rows.sort((a, b) => Number(b.pinned) - Number(a.pinned))
    }
    if (limit !== undefined && limit >= 0) rows = rows.slice(0, limit)
    return rows.map((row) => ({ ...row }))
  }

  /**
   * Aggregate counts for the "how have I been" view.
   *
   * @param {{ from?: number, to?: number }} [range]
   * @returns {{ total: number, byMood: Record<string, number>, byDay: Record<string, number>, byTag: Record<string, number>, streakDays: number, words: number }}
   */
  stats(range = {}) {
    const rows = this.list({ from: range.from, to: range.to, order: 'asc' })
    const byMood = {}
    const byDay = {}
    const byTag = {}
    let words = 0

    for (const row of rows) {
      if (row.mood) byMood[row.mood] = (byMood[row.mood] ?? 0) + 1
      const day = dayKey(row.createdAt)
      byDay[day] = (byDay[day] ?? 0) + 1
      for (const tag of row.tags) byTag[tag] = (byTag[tag] ?? 0) + 1
      words += row.wordCount
    }

    return { total: rows.length, byMood, byDay, byTag, streakDays: streakOf(new Set(Object.keys(byDay)), this.now()), words }
  }

  /**
   * Encrypt every plaintext note body in place.
   *
   * This is the "turn encryption on" migration. It re-wraps each body with the
   * note id as AAD, so a body cannot later be swapped between notes.
   *
   * @returns {Promise<{ migrated: number }>}
   */
  async enableEncryption() {
    this.requireKey()
    this.encryptionEnabled = true
    let migrated = 0
    for (const row of this.rows.values()) {
      if (row.encrypted) continue
      row.encrypted = true
      row.preview = ''
      const body = this.bodies.get(row.id) ?? ''
      await this.persistBody(row.id, body)
      await this.persistRow(row)
      migrated += 1
    }

    // Revision bodies are diary text too. Encrypt them in the same migration,
    // binding each ciphertext to its note id and sequence number.
    for (const revision of this.revisions) {
      if (revision.encrypted) continue
      revision.body = encryptNote(
        revision.body,
        this.requireKey(),
        `${revision.noteId}#revision-${revision.seq}`,
      )
      revision.encrypted = true
      const tables = this.tables()
      if (tables) await tables.revisions.put(`${revision.noteId}#${revision.seq}`, revision)
    }
    return { migrated }
  }

  /**
   * Decrypt every body back to plaintext.
   *
   * Only reachable through an explicit, user-confirmed action: it removes the
   * protection that the product promises.
   *
   * @returns {Promise<{ migrated: number }>}
   */
  async disableEncryption() {
    this.encryptionEnabled = false
    let migrated = 0
    for (const row of this.rows.values()) {
      if (!row.encrypted) continue
      const body = await this.readBody(row.id) // decrypt with the current flag still set
      row.encrypted = false
      this.bodies.set(row.id, body)
      row.preview = derivePreview(body, false)
      await this.persistBody(row.id, body)
      await this.persistRow(row)
      migrated += 1
    }

    for (const revision of this.revisions) {
      if (!revision.encrypted) continue
      revision.body = decryptNote(
        revision.body,
        this.requireKey(),
        `${revision.noteId}#revision-${revision.seq}`,
      )
      revision.encrypted = false
      const tables = this.tables()
      if (tables) await tables.revisions.put(`${revision.noteId}#${revision.seq}`, revision)
    }
    return { migrated }
  }

  /**
   * Revisions of one note, newest last.
   * @param {string} noteId
   * @returns {Array<{ seq: number, at: number, body: string }>}
   */
  history(noteId) {
    return this.revisions
      .filter((entry) => entry.noteId === noteId)
      .map((entry) => ({
        seq: entry.seq,
        at: entry.at,
        body: entry.encrypted
          ? decryptNote(entry.body, this.requireKey(), `${noteId}#revision-${entry.seq}`)
          : entry.body,
      }))
  }

  /** @param {string} id @param {string} body */
  async persistBody(id, body) {
    const row = this.rows.get(id)
    const tables = this.tables()
    if (!row || !tables) return
    const value = row.encrypted ? encryptNote(body, this.requireKey(), id) : body
    this.bodies.set(id, value)
    await tables.notes.update(id, (current) => ({ ...current, body: value }))
  }

  /** @param {any} row */
  async persistRow(row) {
    const tables = this.tables()
    if (!tables) return
    const existing = tables.notes.get(row.id)
    const body = existing?.body
    await tables.notes.put(row.id, body === undefined ? { ...row } : { ...row, body })
  }

  /**
   * @param {string} noteId
   * @param {string} previousBody
   * @param {number} at
   */
  async recordRevision(noteId, previousBody, at) {
    if (!previousBody) return
    const seq = this.revisions.filter((entry) => entry.noteId === noteId).length + 1
    const row = this.rows.get(noteId)
    const storedBody = row?.encrypted
      ? encryptNote(previousBody, this.requireKey(), `${noteId}#revision-${seq}`)
      : previousBody
    const revision = { noteId, seq, at, body: storedBody, encrypted: row?.encrypted === true }
    this.revisions.push(revision)
    const tables = this.tables()
    if (tables) await tables.revisions.put(`${noteId}#${seq}`, revision)
  }
}

/**
 * Case-insensitive match across title, tags, preview and plaintext body.
 *
 * An encrypted body is matched against its *decrypted* form because the store
 * already holds it decrypted in memory while unlocked; a locked vault cannot
 * search bodies at all and this function is never reached with ciphertext as
 * `body` (the caller passes the decrypted body it already has).
 *
 * @param {any} row
 * @param {string} body
 * @param {string} needle already lowercased
 * @returns {boolean}
 */
function matchesText(row, body, needle) {
  if (row.title.toLowerCase().includes(needle)) return true
  if (row.tags.some((tag) => tag.toLowerCase().includes(needle))) return true
  if (row.preview.toLowerCase().includes(needle)) return true
  if (body.toLowerCase().includes(needle)) return true
  return false
}

/**
 * Normalise a tag list: strings only, trimmed, de-duplicated, order preserved.
 * @param {unknown} tags
 * @returns {string[]}
 */
export function normaliseTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  const result = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const trimmed = tag.trim().replace(/^#/, '')
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/**
 * Local `YYYY-MM-DD` key for a timestamp. Local, not UTC: a diary's day is the
 * writer's day.
 * @param {number} timestamp
 * @returns {string}
 */
export function dayKey(timestamp) {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Longest run of consecutive days ending today or yesterday.
 * @param {Set<string>} days
 * @param {number} nowTimestamp
 * @returns {number}
 */
export function streakOf(days, nowTimestamp) {
  if (days.size === 0) return 0
  let streak = 0
  const cursor = new Date(nowTimestamp)
  // A streak stays alive if the writer has not written *yet* today, so start
  // from yesterday when today is missing.
  if (!days.has(dayKey(cursor.getTime()))) {
    cursor.setDate(cursor.getDate() - 1)
    if (!days.has(dayKey(cursor.getTime()))) return 0
  }
  for (;;) {
    if (!days.has(dayKey(cursor.getTime()))) return streak
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
}

/** Random, sortable-ish note id: timestamp prefix plus randomness. */
export function defaultNoteId() {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `n_${Date.now().toString(36)}_${suffix}`
}
