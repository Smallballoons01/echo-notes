/**
 * Integration tests for the Host half.
 *
 * These drive the plugin through a fake Cordis context that records tool
 * registrations, HTTP routes and skill registrations, then call the recorded
 * handlers exactly as the Harness would — so the real `execute`, the real
 * `operations`, and the real vault are all exercised.
 *
 * The module is imported directly from this package. Runtime-facing packages
 * are declared as peers and pinned in devDependencies for reproducible tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'

/** The profile is irrelevant to Host behavior; dependencies resolve from the package. */
async function importPlugin() {
  return { module: { apply, Config }, cleanup: async () => {} }
}

/**
 * A fake Cordis context capturing every registration the plugin makes.
 *
 * Storage is backed by real in-memory maps so persisted state round-trips.
 */
function fakeContext() {
  const tables = new Map()
  const registrations = { tools: [], routes: [], skills: [], effects: [] }
  const effectDisposers = []

  const table = (domain, tableName) => {
    const key = `${domain}/${tableName}`
    if (!tables.has(key)) tables.set(key, new Map())
    const store = tables.get(key)
    return {
      get: (k) => store.get(k),
      entries: () => store.entries(),
      keys: () => store.keys(),
      get size() { return store.size },
      put: async (k, v) => { store.set(k, v) },
      delete: async (k) => store.delete(k),
      update: async (k, fn) => { const next = fn(store.get(k)); store.set(k, next); return next },
    }
  }

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect(factory, _label) {
      const disposer = factory()
      registrations.effects.push(disposer)
      effectDisposers.push(disposer)
      return disposer
    },
    get(name) {
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    tools: {
      register(definition) {
        registrations.tools.push(definition)
        return () => {}
      },
    },
    skills: {
      register(skill) {
        registrations.skills.push(skill)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        registrations.routes.push(route)
        return () => {}
      },
    },
    storageDomain: {
      async open(spec) {
        return { name: spec.name, table: (name) => table(spec.name, name), close: async () => {} }
      },
    },
  }
  return { ctx, registrations, disposeAll: () => effectDisposers.forEach((d) => d?.()) }
}

/** Invoke a registered HTTP route with a JSON body and return the parsed reply. */
async function callRoute(route, path, body, method = 'POST', headers = { host: 'localhost' }) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const req = {
    url: path,
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload
    },
  }
  let status
  let responseBody
  const res = {
    writeHead(code) { status = code },
    end(text) { responseBody = text },
  }
  await route.handler(req, res)
  return { status, body: responseBody ? JSON.parse(responseBody) : undefined }
}

/** Start a plugin instance and return helpers for driving it. */
async function startPlugin(name, config) {
  const { module, cleanup } = await importPlugin(name)
  const fake = fakeContext()
  module.apply(fake.ctx, config ?? {})
  const route = fake.registrations.routes[0]
  const tool = fake.registrations.tools[0]
  assert.ok(route, 'the plugin must register an HTTP route')
  assert.ok(tool, 'the plugin must register a tool')

  return {
    tool,
    skill: fake.registrations.skills[0],
    cleanup,
    disposeAll: fake.disposeAll,
    call: (path, body, method) => callRoute(route, `/echo-notes/api${path}`, body, method),
    callWithHeaders: (path, body, method, headers) =>
      callRoute(route, `/echo-notes/api${path}`, body, method, headers),
    callWithHost: (path, body, method, headers) =>
      callRoute(route, `/echo-notes/api${path}`, body, method, headers),
    callRaw: (path, raw) => callRouteRaw(route, `/echo-notes/api${path}`, raw),
    run: async (args) => tool.execute(args, { signal: new AbortController().signal, agent: undefined }),
  }
}

/** Invoke a route with a raw, possibly malformed, request body. */
async function callRouteRaw(route, path, raw) {
  const req = {
    url: path,
    method: 'POST',
    headers: { host: 'localhost' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw) },
  }
  let status
  let responseBody
  const res = { writeHead(code) { status = code }, end(text) { responseBody = text } }
  await route.handler(req, res)
  return { status, body: responseBody ? JSON.parse(responseBody) : undefined }
}

const unique = () => `echo-notes-it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** Restrict model-facing schemas to keywords/types common across Agent APIs. */
function assertStandardJsonSchema(schema, path = '$') {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${path} is a schema object`)
  const supported = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  if (schema.type !== undefined) assert.ok(supported.has(schema.type), `${path}.type=${schema.type} is portable`)
  if (schema.properties) for (const [key, child] of Object.entries(schema.properties)) assertStandardJsonSchema(child, `${path}.properties.${key}`)
  if (schema.items) assertStandardJsonSchema(schema.items, `${path}.items`)
  if (schema.oneOf) for (const [index, child] of schema.oneOf.entries()) assertStandardJsonSchema(child, `${path}.oneOf[${index}]`)
}

test('registers exactly one tool, one route and one skill', async () => {
  const plugin = await startPlugin(unique())
  try {
    assert.equal(plugin.tool.name, 'echo_note')
    assert.ok(plugin.tool.description.includes('Echo Notes'))
    // The runtime accepts the raw JSON Schema directly; local validation in
    // the tool body enforces the required action and enum before dispatch.
    assert.equal(plugin.tool.parameters.type, 'object')
    assert.equal(plugin.tool.parameters.additionalProperties, false)
    assertStandardJsonSchema(plugin.tool.parameters)
    assertStandardJsonSchema(plugin.tool.output.schema)
    assert.deepEqual(plugin.tool.parameters.required, ['action'])
    assert.ok(plugin.tool.parameters.properties.action.enum.includes('write'))
    assert.equal(Object.hasOwn(plugin.tool.parameters.properties.action, 'required'), false)
    assert.equal(plugin.tool.parameters.properties.scheduleWeekdays.items.type, 'integer')
    assert.equal(plugin.tool.output.schema.type, 'object')
    assert.equal(plugin.skill.name, 'echo-notes')
    assert.ok(plugin.skill.content.includes('passphrase'), 'the skill must cover the privacy rule')
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('reports a fresh vault as locked with no notes', async () => {
  const plugin = await startPlugin(unique())
  try {
    const status = await plugin.call('/status', undefined, 'GET')
    assert.equal(status.status, 200)
    assert.equal(status.body.value.hasVault, false)
    assert.equal(status.body.value.unlocked, false)
    assert.equal(status.body.value.noteCount, 0)
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('creating a vault unlocks it and enables encryption by default', async () => {
  const plugin = await startPlugin(unique())
  try {
    const created = await plugin.call('/vault/create', { passphrase: 'a-good-passphrase' })
    assert.equal(created.status, 200)
    assert.equal(created.body.value.created, true)

    const status = await plugin.call('/status', undefined, 'GET')
    assert.equal(status.body.value.unlocked, true)
    assert.equal(status.body.value.hasVault, true)
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('refuses a weak passphrase and a duplicate vault', async () => {
  const plugin = await startPlugin(unique())
  try {
    const weak = await plugin.call('/vault/create', { passphrase: 'abc' })
    assert.equal(weak.status, 400)
    assert.equal(weak.body.error, 'weak-passphrase')

    await plugin.call('/vault/create', { passphrase: 'a-good-passphrase' })
    const again = await plugin.call('/vault/create', { passphrase: 'another-passphrase' })
    assert.equal(again.status, 409)
    assert.equal(again.body.error, 'vault-exists')
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('unlocking with the wrong passphrase fails with 401 and stays locked', async () => {
  const plugin = await startPlugin(unique())
  try {
    await plugin.call('/vault/create', { passphrase: 'correct-passphrase' })
    await plugin.call('/vault/lock', {})

    const bad = await plugin.call('/vault/unlock', { passphrase: 'wrong-passphrase' })
    assert.equal(bad.status, 401)
    assert.equal(bad.body.error, 'wrong-passphrase')

    const good = await plugin.call('/vault/unlock', { passphrase: 'correct-passphrase' })
    assert.equal(good.status, 200)
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('notes are unreadable while locked, at both the tool and the route', async () => {
  const plugin = await startPlugin(unique())
  try {
    await plugin.call('/vault/create', { passphrase: 'a-good-passphrase' })
    await plugin.call('/notes/write', { body: 'private entry', mood: 'calm' })
    await plugin.call('/vault/lock', {})

    const listed = await plugin.call('/notes/list', {})
    assert.equal(listed.status, 423, 'a locked vault refuses to list notes')

    const toolResult = await plugin.run({ action: 'list' })
    assert.equal(toolResult.ok, false)
    assert.equal(toolResult.error, 'locked')
    assert.ok(toolResult.message.includes('unlock'), 'the failure must tell the model what to do')
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('a passphrase change keeps existing notes readable', async () => {
  const plugin = await startPlugin(unique())
  try {
    await plugin.call('/vault/create', { passphrase: 'old-passphrase' })
    await plugin.call('/notes/write', { body: 'written before the change', mood: 'joy' })

    const changed = await plugin.call('/vault/changePassphrase', { current: 'old-passphrase', next: 'new-passphrase' })
    assert.equal(changed.status, 200)

    await plugin.call('/vault/lock', {})
    const withOld = await plugin.call('/vault/unlock', { passphrase: 'old-passphrase' })
    assert.equal(withOld.status, 401, 'the old passphrase must stop working')

    const withNew = await plugin.call('/vault/unlock', { passphrase: 'new-passphrase' })
    assert.equal(withNew.status, 200)

    const listed = await plugin.call('/notes/list', {})
    const note = listed.body.value.notes[0]
    const read = await plugin.call('/notes/read', { id: note.id })
    assert.equal(read.body.value.body, 'written before the change')
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('the HTTP API refuses a forged, non-local Host header', async () => {
  const plugin = await startPlugin(unique())
  try {
    const local = await plugin.call('/status', undefined, 'GET')
    assert.equal(local.status, 200, 'a local Host is accepted')

    // Same route, a Host that did not come from this machine: the diary must
    // not be readable by another process on the network.
    const forged = await plugin.callWithHost('/status', undefined, 'GET', { host: 'evil.example.com' })
    assert.equal(forged.status, 403)
    assert.equal(forged.body.error, 'forbidden')
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('rejects cross-origin POST writes but allows a matching local origin', async () => {
  const plugin = await startPlugin(unique())
  try {
    const blocked = await plugin.callWithHeaders(
      '/vault/create',
      { passphrase: 'a-good-passphrase' },
      'POST',
      { host: 'localhost', origin: 'https://attacker.example' },
    )
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.error, 'forbidden')

    const allowed = await plugin.callWithHeaders(
      '/vault/create',
      { passphrase: 'a-good-passphrase' },
      'POST',
      { host: 'localhost', origin: 'http://localhost' },
    )
    assert.equal(allowed.status, 200)
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('writes, lists, filters and searches notes through the tool', async () => {
  const plugin = await startPlugin(unique())
  try {
    await plugin.call('/vault/create', { passphrase: 'a-good-passphrase' })

    const first = await plugin.run({ action: 'write', body: '今天很开心', mood: 'joy', tags: ['工作'] })
    assert.equal(first.ok, true)
    assert.equal(first.created, true)
    assert.equal(first.note.mood, 'joy')
    assert.equal(first.note.title, '今天很开心')

    const second = await plugin.run({ action: 'write', body: '有点累', mood: 'tired', tags: ['工作', '加班'] })
    assert.equal(second.ok, true)

    const all = await plugin.run({ action: 'list' })
    assert.equal(all.ok, true)
    assert.equal(all.notes.length, 2)

    const byMood = await plugin.run({ action: 'list', moods: ['joy'] })
    assert.equal(byMood.notes.length, 1)

    const byTag = await plugin.run({ action: 'list', tags: ['工作'] })
    assert.equal(byTag.notes.length, 2)

    const searched = await plugin.run({ action: 'search', query: '累' })
    assert.equal(searched.notes.length, 1)
    assert.equal(searched.notes[0].mood, 'tired')

    const updated = await plugin.run({ action: 'write', id: first.note.id, body: '改成了别的', mood: 'calm' })
    assert.equal(updated.created, false)
    assert.equal(updated.note.mood, 'calm')

    const read = await plugin.run({ action: 'read', id: first.note.id })
    assert.equal(read.ok, true)
    assert.equal(read.body, '改成了别的')
    assert.equal(read.history.length, 1, 'the previous body is retained as a revision')

    const stats = await plugin.run({ action: 'stats' })
    assert.equal(stats.stats.total, 2)
    assert.equal(stats.stats.byMood.calm, 1)
    assert.equal(stats.stats.byMood.tired, 1)
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('the tool reports a vault that does not exist yet without throwing', async () => {
  const plugin = await startPlugin(unique())
  try {
    const status = await plugin.run({ action: 'status' })
    assert.equal(status.ok, true)
    assert.equal(status.hasVault, false)
    assert.equal(status.unlocked, false)

    const write = await plugin.run({ action: 'write', body: 'nope' })
    assert.equal(write.ok, false)
    assert.equal(write.error, 'locked')
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('render a template into a ready-to-write body, while locked', async () => {
  const plugin = await startPlugin(unique())
  try {
    const templates = await plugin.run({ action: 'templates' })
    assert.equal(templates.ok, true)
    assert.ok(templates.builtin.some((tpl) => tpl.id === 'i-daily'))
    assert.ok(templates.builtin.some((tpl) => tpl.id === 'e-daily'))
    assert.ok(templates.builtin.some((tpl) => tpl.mood === 'sad'))

    const started = await plugin.run({ action: 'start', templateId: 'i-daily' })
    assert.equal(started.ok, true)
    assert.equal(started.templateId, 'i-daily')
    assert.match(started.body, /i 人日记/)
    assert.match(started.body, /## /, 'prompts become headings')

    const byMood = await plugin.run({ action: 'start', mood: 'sad' })
    assert.equal(byMood.templateId, 'sad')
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('saving a custom template makes it selectable and shadow-capable', async () => {
  const plugin = await startPlugin(unique())
  try {
    await plugin.call('/vault/create', { passphrase: 'a-good-passphrase' })
    const saved = await plugin.call('/templates/save', {
      template: {
        id: 'my-own',
        persona: 'i',
        mood: null,
        name: { zh: '我的模版', en: 'Mine' },
        prompts: [{ zh: '今天怎么样？', en: 'How was today?' }],
        tags: ['自定义'],
      },
    })
    assert.equal(saved.status, 200)

    const rendered = await plugin.call('/templates/render', { id: 'my-own' })
    assert.match(rendered.body.value.body, /今天怎么样？/)

    // A custom template with a built-in's id must win.
    await plugin.call('/templates/save', {
      template: { id: 'i-daily', name: { zh: '覆盖版', en: 'Override' }, prompts: [{ zh: '被覆盖了', en: 'overridden' }], tags: [] },
    })
    const overridden = await plugin.call('/templates/render', { id: 'i-daily' })
    assert.match(overridden.body.value.body, /被覆盖了/)
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('reminders save, list and toggle with a human-readable schedule', async () => {
  const plugin = await startPlugin(unique())
  try {
    await plugin.call('/vault/create', { passphrase: 'a-good-passphrase' })

    const saved = await plugin.run({
      action: 'reminders',
      reminderTitle: '睡前写一句',
      reminderPrompt: '今天过得怎么样？',
      scheduleKind: 'daily',
      at: '21:30',
    })
    assert.equal(saved.ok, true)
    assert.ok(saved.saved, 'a reminder id is returned')

    const listed = await plugin.run({ action: 'reminders' })
    assert.equal(listed.reminderViews.length, 1)
    assert.equal(listed.reminderViews[0].human, '每天 21:30')
    assert.ok(listed.reminderViews[0].nextFireAt, 'a next fire time is reported')

    const toggled = await plugin.run({ action: 'reminders', reminderId: saved.saved, enabled: false })
    assert.equal(toggled.reminderViews[0].enabled, false)

    const removed = await plugin.run({ action: 'reminders', reminderId: saved.saved })
    assert.equal(removed.removed, saved.saved)

    const empty = await plugin.run({ action: 'reminders' })
    assert.equal(empty.reminderViews.length, 0)
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('an invalid reminder schedule is rejected with a readable reason', async () => {
  const plugin = await startPlugin(unique())
  try {
    await plugin.call('/vault/create', { passphrase: 'a-good-passphrase' })
    const bad = await plugin.call('/reminders/save', {
      reminder: { id: 'r1', title: 'bad', schedule: { kind: 'daily', at: '99:99' } },
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'bad-reminder')
    assert.match(bad.body.message, /HH:MM/)
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('an out-of-enum action is rejected by schema validation, and unknown routes 404', async () => {
  const plugin = await startPlugin(unique())
  try {
    // The tool's compiled schema rejects an unknown action before the plugin's
    // own dispatch runs, which is the stronger guarantee: the model cannot even
    // reach an unhandled branch.
    await assert.rejects(() => plugin.run({ action: 'nonsense' }), /one of/)

    const missing = await plugin.call('/does/not/exist', {})
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error, 'not-found')

    const wrongMethod = await plugin.call('/notes/list', undefined, 'GET')
    assert.equal(wrongMethod.status, 405)
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('malformed JSON is rejected with a clean 400 rather than a crash', async () => {
  const plugin = await startPlugin(unique())
  try {
    const result = await plugin.callRaw('/vault/unlock', '{not json')
    assert.equal(result.status, 400)
    assert.equal(result.body.error, 'bad-json')
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('auto-lock drops the key after the configured idle period', async () => {
  // The reminder loop enforces the lock. The check runs on a tick, so wait for
  // the idle deadline (0.05 min = 3s) plus at least one more tick (1s).
  const plugin = await startPlugin(unique(), { autoLockMinutes: 0.05, tickSeconds: 1 })
  try {
    await plugin.call('/vault/create', { passphrase: 'a-good-passphrase' })
    assert.equal((await plugin.call('/status', undefined, 'GET')).body.value.unlocked, true)

    await new Promise((resolve) => setTimeout(resolve, 4600))

    const status = await plugin.call('/status', undefined, 'GET')
    assert.equal(status.body.value.unlocked, false, 'an idle vault locks itself')
    assert.equal(status.body.value.hasVault, true, 'the keyring survives the lock')
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})

test('auto-lock is disabled by default, so an idle vault stays unlocked', async () => {
  const plugin = await startPlugin(unique(), { tickSeconds: 1 })
  try {
    await plugin.call('/vault/create', { passphrase: 'a-good-passphrase' })
    await new Promise((resolve) => setTimeout(resolve, 2500))
    assert.equal(
      (await plugin.call('/status', undefined, 'GET')).body.value.unlocked,
      true,
      'with autoLockMinutes unset the key stays resident',
    )
  } finally {
    plugin.disposeAll()
    await plugin.cleanup()
  }
})
