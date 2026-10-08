/** NoteStore unit tests with a fake durable KV backend. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NoteStore, countWords, dayKey, deriveTitle, normaliseTags } from '../src/store.js'
import { createKeyring, unlockKeyring } from '../src/crypto.js'

function fakeTables() {
  const make = () => {
    const data = new Map()
    return {
      get: (key) => data.get(key), entries: () => data.entries(), keys: () => data.keys(),
      get size() { return data.size },
      put: async (key, value) => { data.set(key, value) },
      delete: async (key) => data.delete(key),
      update: async (key, fn) => { const value = fn(data.get(key)); data.set(key, value); return value },
    }
  }
  return { notes: make(), revisions: make(), settings: make() }
}

async function unlockedStore() {
  const tables = fakeTables()
  const keyring = await createKeyring('test passphrase')
  const key = await unlockKeyring('test passphrase', keyring)
  let now = new Date(2026, 2, 10, 9).getTime()
  let id = 0
  const store = new NoteStore({ tables: () => tables, dataKey: () => key, now: () => now, idFactory: () => `note-${++id}` })
  await store.hydrate()
  return { store, tables, advance(ms) { now += ms } }
}

test('creates, reads and indexes a note', async () => {
  const { store } = await unlockedStore()
  const row = await store.create({ body: '# 今天\n下雨了', mood: 'sad', tags: [' 雨天 ', '#雨天'] })
  assert.equal(row.title, '今天')
  assert.equal(row.mood, 'sad')
  assert.deepEqual(row.tags, ['雨天'])
  assert.equal((await store.read(row.id)).body, '# 今天\n下雨了')
})

test('refuses body operations while locked', async () => {
  const tables = fakeTables()
  const store = new NoteStore({ tables: () => tables, dataKey: () => undefined })
  await assert.rejects(() => store.create({ body: 'secret' }), /vault is locked/)
})

test('updates preserve previous body as revision', async () => {
  const { store, advance } = await unlockedStore()
  const row = await store.create({ body: 'first' })
  advance(1000)
  await store.update(row.id, { body: 'second' })
  assert.deepEqual(store.history(row.id).map((entry) => entry.body), ['first'])
  assert.equal((await store.read(row.id)).body, 'second')
})

test('does not record unchanged body as revision', async () => {
  const { store } = await unlockedStore()
  const row = await store.create({ body: 'same' })
  await store.update(row.id, { body: 'same' })
  assert.equal(store.history(row.id).length, 0)
})

test('filters by time, mood, tags and template; searches text', async () => {
  const { store, advance } = await unlockedStore()
  const first = await store.create({ body: 'Alice went home', mood: 'joy', tags: ['work'], templateId: 'joy' })
  advance(1000)
  await store.create({ body: 'rainy day', mood: 'sad', tags: ['home'], templateId: 'sad' })
  assert.equal(store.list({ moods: ['joy'] }).length, 1)
  assert.equal(store.list({ tags: ['work'] })[0].id, first.id)
  assert.equal(store.list({ templateId: 'sad' }).length, 1)
  assert.equal(store.list({ from: first.createdAt + 1 }).length, 1)
  assert.equal(store.list({ text: 'alice' }).length, 1)
})

test('orders newest first, supports ascending and pinned-first', async () => {
  const { store, advance } = await unlockedStore()
  const older = await store.create({ body: 'older' })
  advance(1000)
  const newer = await store.create({ body: 'newer' })
  assert.deepEqual(store.list().map((row) => row.id), [newer.id, older.id])
  assert.deepEqual(store.list({ order: 'asc' }).map((row) => row.id), [older.id, newer.id])
  await store.update(older.id, { pinned: true })
  assert.equal(store.list({ pinnedFirst: true })[0].id, older.id)
})

test('enables encryption and persists note body ciphertext without preview', async () => {
  const { store, tables } = await unlockedStore()
  const row = await store.create({ body: 'private words' })
  await store.enableEncryption()
  const saved = tables.notes.get(row.id)
  assert.equal(saved.encrypted, true)
  assert.equal(saved.preview, '')
  assert.ok(!saved.body.includes('private words'))
  assert.equal((await store.read(row.id)).body, 'private words')
})

test('notes created after encryption is enabled persist as ciphertext', async () => {
  const { store, tables } = await unlockedStore()
  await store.create({ body: 'seed note' })
  await store.enableEncryption()
  const created = await store.create({ body: 'new private note' })
  const stored = tables.notes.get(created.id)
  assert.equal(stored.encrypted, true)
  assert.ok(!stored.body.includes('new private note'))
  assert.equal((await store.read(created.id)).body, 'new private note')
})

test('editing an encrypted note keeps the body and new revision encrypted at rest', async () => {
  const { store, tables } = await unlockedStore()
  const note = await store.create({ body: 'before edit' })
  await store.enableEncryption()
  await store.update(note.id, { body: 'after edit' })
  const stored = tables.notes.get(note.id)
  const revision = [...tables.revisions.entries()][0][1]
  assert.ok(!stored.body.includes('after edit'))
  assert.ok(!revision.body.includes('before edit'))
  assert.deepEqual(store.history(note.id).map((entry) => entry.body), ['before edit'])
  assert.equal((await store.read(note.id)).body, 'after edit')
})

test('encrypted note and revision survive hydration', async () => {
  const tables = fakeTables()
  const keyring = await createKeyring('test passphrase')
  const key = await unlockKeyring('test passphrase', keyring)
  const first = new NoteStore({ tables: () => tables, dataKey: () => key, idFactory: () => 'persisted' })
  await first.hydrate()
  await first.create({ body: 'before' })
  await first.update('persisted', { body: 'after' })
  await first.enableEncryption()
  const second = new NoteStore({ tables: () => tables, dataKey: () => key })
  await second.hydrate()
  assert.equal((await second.read('persisted')).body, 'after')
  assert.deepEqual(second.history('persisted').map((entry) => entry.body), ['before'])
})

test('disabling encryption restores bodies and revision plaintext', async () => {
  const { store, tables } = await unlockedStore()
  const row = await store.create({ body: 'before' })
  await store.update(row.id, { body: 'after' })
  await store.enableEncryption()
  await store.disableEncryption()
  assert.equal(tables.notes.get(row.id).body, 'after')
  assert.equal([...tables.revisions.entries()][0][1].body, 'before')
  assert.deepEqual(store.history(row.id).map((entry) => entry.body), ['before'])
})

test('rejects ciphertext moved between note identities', async () => {
  const { store, tables } = await unlockedStore()
  const a = await store.create({ body: 'note A' })
  const b = await store.create({ body: 'note B' })
  await store.enableEncryption()
  const bodyA = tables.notes.get(a.id).body
  await tables.notes.update(b.id, (current) => ({ ...current, body: bodyA }))
  store.bodies.set(b.id, bodyA)
  await assert.rejects(() => store.readBody(b.id), /authentication/)
})

test('deletes notes and associated revisions', async () => {
  const { store } = await unlockedStore()
  const row = await store.create({ body: 'one' })
  await store.update(row.id, { body: 'two' })
  assert.equal(await store.remove(row.id), true)
  assert.equal(store.list().length, 0)
  assert.equal(store.history(row.id).length, 0)
})

test('stats summarize mood, day, tags and streak', async () => {
  const { store, advance } = await unlockedStore()
  await store.create({ body: 'one', mood: 'joy', tags: ['work'] })
  advance(24 * 60 * 60 * 1000)
  await store.create({ body: 'two', mood: 'sad', tags: ['home'] })
  const stats = store.stats()
  assert.equal(stats.total, 2)
  assert.equal(stats.byMood.joy, 1)
  assert.equal(stats.byTag.home, 1)
  assert.equal(stats.streakDays, 2)
})

test('utility functions normalize tags, titles, word counts and local dates', () => {
  assert.deepEqual(normaliseTags([' a ', '#b', 'a', 3]), ['a', 'b'])
  assert.equal(deriveTitle('## Heading\nbody'), 'Heading')
  assert.equal(countWords('你好 hello'), 3)
  assert.equal(dayKey(new Date(2026, 2, 10, 23).getTime()), '2026-03-10')
})
