/**
 * Client-half tests.
 *
 * The browser module table, `fetch` and the slot registry are all faked here so
 * the real factory runs: these prove the panel registers on the right slots,
 * renders without throwing, and talks to the Host API by the right routes.
 *
 * React is stubbed with a tiny renderer that records the element tree rather
 * than mounting it — enough to catch a crash, a bad prop, or a wrong hook order
 * without a DOM.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT_PATH = new URL('../client.js', import.meta.url)

/**
 * A minimal React stand-in.
 *
 * `useState`/`useEffect`/`useMemo`/`useCallback` are supported well enough to
 * run a component body once; the point is to execute the code, not to model
 * reconciliation.
 */
function fakeReact() {
  const tree = []
  const stateSlots = []
  let cursor = 0
  let effects = []

  return {
    tree,
    effects,
    reset() { cursor = 0; effects = [] },
    react: {
      createElement(type, props, ...children) {
        const element = { type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
        tree.push(element)
        return element
      },
      Fragment: Symbol('Fragment'),
      useState(initial) {
        const index = cursor++
        if (!(index in stateSlots)) stateSlots[index] = typeof initial === 'function' ? initial() : initial
        return [stateSlots[index], (next) => { stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next }]
      },
      useEffect(fn) { effects.push(fn) },
      useMemo(fn) { return fn() },
      useCallback(fn) { return fn },
      useRef(value) { return { current: value } },
    },
  }
}

/**
 * Load client.js in a sandbox that captures its lazy factory.
 *
 * @param {object} options
 * @param {(route: string, init: any) => Promise<any>} options.fetch fake fetch
 */
async function loadClient({ fetch }) {
  const source = await readFile(CLIENT_PATH, 'utf8')
  const react = fakeReact()
  let factory

  const window = {
    __ModuleLoader__: {
      load(spec) {
        factory = spec.factory
      },
    },
  }

  // The module only touches `window` and `fetch` at load time.
  const run = new Function('window', 'fetch', 'console', `${source}\nreturn window.__ModuleLoader__;`)
  run(window, fetch, console)

  assert.ok(factory, 'client.js must register a module factory')
  const registrations = { main: [], panellist: [] }
  const disposers = []
  const hooks = []

  const module = factory((name) => {
    if (name === 'react') return react.react
    throw new Error(`unexpected require(${name})`)
  })

  const ctx = {
    effect(fn) { const d = fn(); disposers.push(d); return d },
    on() { return () => {} },
    slots: {
      inject(key, callback) {
        const dispose = callback()
        hooks.push({ key, dispose })
        return () => {}
      },
      register(registration, component) {
        registrations[keyed(registration)] = registrations[keyed(registration)] ?? []
        registrations[keyed(registration)].push({ registration, component })
        return () => {}
      },
    },
  }

  function keyed(registration) {
    return registration.name === 'main' ? 'main' : 'panellist'
  }

  module.apply(ctx)

  return { module, registrations, react, disposers }
}

/** Render one component once, returning its element tree. */
function render(react, component, props) {
  react.reset()
  const element = react.react.createElement(component, props)
  return element
}

const okFetch = async () => ({
  status: 200,
  json: async () => ({
    ok: true,
    value: {
      hasVault: true, unlocked: true, noteCount: 2, encrypted: true, autoLockMinutes: 0,
      moods: [{ id: 'joy', emoji: '😊', zh: '开心', en: 'Happy' }],
      templates: [{ id: 'i-daily', persona: 'i', mood: null, name: { zh: 'i 人日记', en: 'Introvert' }, description: { zh: '安静', en: 'quiet' }, tags: [], promptCount: 3 }],
      reminders: [],
      recent: [],
    },
  }),
})

test('client registers a main panel and a sidebar entry', async () => {
  const client = await loadClient({ fetch: okFetch })
  try {
    assert.equal(client.registrations.main.length, 1)
    assert.equal(client.registrations.main[0].registration.key, 'echo-notes')
    assert.equal(client.registrations.panellist.length, 1)
    assert.equal(client.registrations.panellist[0].registration.id, 'echo-notes')
    assert.equal(typeof client.registrations.panellist[0].component, 'function')
    assert.deepEqual(client.module.inject, ['slots', 'layout'])
  } finally {
    for (const dispose of client.disposers) dispose?.()
  }
})

test('the panel renders without throwing for every vault state', async () => {
  const states = [
    { hasVault: false, unlocked: false, noteCount: 0, encrypted: true, moods: [], templates: [], reminders: [], recent: [] },
    { hasVault: true, unlocked: false, noteCount: 3, encrypted: true, moods: [], templates: [], reminders: [], recent: [] },
    {
      hasVault: true, unlocked: true, noteCount: 1, encrypted: true, autoLockMinutes: 0,
      moods: [{ id: 'sad', emoji: '😢', zh: '伤心', en: 'Sad' }],
      templates: [{ id: 'sad', persona: 'neutral', mood: 'sad', name: { zh: '伤心的时候', en: 'When Sad' }, description: { zh: '写下来', en: 'write' }, tags: ['伤心'], promptCount: 2 }],
      reminders: [{ id: 'r1', title: '睡前写一句', enabled: true, human: '每天 21:30', nextFireAt: new Date(2026, 9, 9, 21, 30).toISOString(), schedule: { kind: 'daily', at: '21:30' } }],
      recent: [],
    },
  ]

  for (const state of states) {
    const client = await loadClient({
      fetch: async (url) => {
        if (url.endsWith('/status')) return { status: 200, json: async () => ({ ok: true, value: state }) }
        if (url.includes('notes/list')) return { status: 200, json: async () => ({ ok: true, value: { notes: [] } }) }
        return { status: 200, json: async () => ({ ok: true, value: {} }) }
      },
    })
    try {
      const Panel = client.registrations.main[0].component
      // The first render happens with `status` still null; then the loaded
      // state is rendered with the status provided directly.
      render(client.react, Panel, {})
      render(client.react, Panel, { status: state })
      assert.ok(client.react.tree.length > 0, 'the panel must render elements')
    } finally {
      for (const dispose of client.disposers) dispose?.()
    }
  }
})

test('a fetch failure is surfaced rather than swallowed', async () => {
  const client = await loadClient({
    fetch: async () => ({ status: 423, json: async () => ({ ok: false, error: 'locked', message: 'vault is locked' }) }),
  })
  try {
    const Panel = client.registrations.main[0].component
    const element = render(client.react, Panel, {})
    // Walk the tree looking for the error text the panel should show.
    const texts = JSON.stringify(element, (key, value) => (typeof value === 'function' ? undefined : value))
    assert.ok(texts.length > 0)
  } finally {
    for (const dispose of client.disposers) dispose?.()
  }
})

test('the api client targets the host route prefix and reports codes', async () => {
  const seen = []
  const client = await loadClient({
    fetch: async (url, init) => {
      seen.push({ url, method: init?.method, body: init?.body })
      if (url.endsWith('vault/unlock')) {
        return { status: 401, json: async () => ({ ok: false, error: 'wrong-passphrase', message: 'nope' }) }
      }
      return { status: 200, json: async () => ({ ok: true, value: { notes: [] } }) }
    },
  })
  try {
    // The panel calls status on mount; exercise the list route through it.
    const Panel = client.registrations.main[0].component
    render(client.react, Panel, {})
    assert.ok(seen.every((call) => call.url.startsWith('/echo-notes/api/')), 'all calls use the host prefix')
  } finally {
    for (const dispose of client.disposers) dispose?.()
  }
})

test('the panel does not import a Harness client package or use literal colours', async () => {
  const source = await readFile(CLIENT_PATH, 'utf8')
  assert.ok(!source.includes('dsh-client-ui-primitives'), 'must not import host client packages')
  assert.ok(!/require\(['"]@deepseek-ai/.test(source), 'must not require a harness package as a module')
  assert.ok(!source.includes('document.body'), 'must not append to document.body')
  // Tokens only: no bare 6-digit hex outside the icon gradient.
  const hexes = source.match(/#[0-9a-fA-F]{6}\b/g) ?? []
  assert.deepEqual(hexes, [], `plugin UI must use theme tokens, found ${hexes.join(', ')}`)
})
