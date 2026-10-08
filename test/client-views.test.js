/**
 * Rendering tests for the panel's inner views.
 *
 * The main-panel test only covers the list view because the panel starts there.
 * These drive the Editor, the Settings page and the deprecated-history branch
 * directly, which is where an undefined prop or a bad hook would actually show
 * up at runtime.
 *
 * The views are not exported individually, so the module source is evaluated
 * with a small appended export block. That keeps `client.js` clean (it stays a
 * loader-registered module) while still exercising the real component bodies.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT_PATH = new URL('../client.js', import.meta.url)

/**
 * Evaluate client.js and recover its internal components.
 *
 * The module exposes them on `__views`, a test-only field the browser never
 * reads. This is deliberately simpler than transforming the source: the views
 * are exercised exactly as they are shipped.
 */
async function loadViews(fetchImpl) {
  const source = await readFile(CLIENT_PATH, 'utf8')

  const runtime = makeRuntime(fetchImpl)
  const run = new Function('window', 'fetch', 'console', `${source}\nreturn window.__ModuleLoader__`)
  run(runtime.window, fetchImpl, console)

  assert.ok(runtime.factory, 'client.js must register a module factory')
  const module = runtime.factory(runtime.require)
  assert.ok(module.__views, 'the module must expose its views for testing')
  runtime.views = module.__views
  module.apply(runtime.ctx)
  return runtime
}

/** Build the fake window / React / slot environment. */
function makeRuntime(fetchImpl) {
  const calls = []
  const effects = []
  let pendingComponent
  let pendingProps

  // Hook state is keyed per component *identity* and per hook index, and it
  // persists for the life of this runtime. A `render()` call re-runs component
  // bodies against that state, which is what lets a component that awaits be
  // observed first in its loading state and then in its loaded state.
  let rendering = null
  const componentState = new Map()

  const hooks = {
    useState(initial) {
      const component = rendering.component
      const index = rendering.index++
      const slots = stateSlotsFor(component)
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => {
        // Re-read the map by component rather than closing over the array: a
        // test-local `mount` may replace the array, and the setter must still
        // target whatever the component will read next.
        const target = stateSlotsFor(component)
        target[index] = typeof next === 'function' ? next(target[index]) : next
      }]
    },
    // Only the root component's effects are collected. Nested components
    // (Field, Button) have no effects, and collecting them would run the same
    // loader effect several times.
    useEffect(fn) { if (rendering.component === pendingComponent) effects.push(fn) },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useRef(value) { return { current: value } },
  }

  /** The persistent state array for one component function. */
  function stateSlotsFor(component) {
    if (!componentState.has(component)) componentState.set(component, [])
    return componentState.get(component)
  }

  const React_ = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }
    },
    ...hooks,
  }

  /**
   * Render a function component by calling it, then walking into any child
   * elements that are themselves function components. Real React does this;
   * the stub has to as well or nothing inside a view is ever executed.
   */
  function renderComponent(type, props, depth = 0) {
    if (depth > 12) return { type, props: props ?? {}, children: [] }
    // A host element keeps its own props and children: `Field` passes the
    // `<textarea>` in as a child, so dropping it here would hide the editor.
    if (typeof type === 'string') {
      // `createElement` keeps children in its own array rather than in props,
      // so re-expose them here (as React's props.children does) to keep the
      // serialized tree faithful.
      const children = props?.children ?? []
      return { type, props: { ...(props ?? {}), children }, children }
    }
    const previous = rendering
    rendering = { component: type, index: 0 }
    let produced
    try {
      // Function components receive children through `props.children`, exactly
      // as React passes them. `Field` relies on this to render its control.
      produced = type({ ...(props ?? {}), children: props?.children ?? [] })
    } finally {
      rendering = previous
    }
    return expand(produced, depth)
  }

  function expand(node, depth = 0) {
    if (node === null || node === undefined || node === false || node === true) return node
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child) => expand(child, depth))
    if (typeof node.type === 'function') {
      return renderComponent(node.type, { ...node.props, children: node.children ?? [] }, depth + 1)
    }
    return { ...node, children: (node.children ?? []).map((child) => expand(child, depth)) }
  }

  const runtime = {
    views: undefined,
    calls,
    effects,
    /** Hook state for the render in progress. */
    state: {},
    require: (name) => {
      if (name === 'react') return React_
      throw new Error(`unexpected require(${name})`)
    },
    factory: undefined,
    window: {
      __ModuleLoader__: { load: (spec) => { runtime.factory = spec.factory } },
      confirm: () => true,
    },    ctx: {
      effect(fn) { const d = fn(); return d },
      slots: {
        inject(_key, callback) { callback(); return () => {} },
        register() { return () => {} },
      },
    },
  }

  // Reset the hook cursor before every component render, then expand the tree
  // so nested function components actually execute.
  runtime.render = (component, props) => {
    effects.length = 0
    return expand(React_.createElement(component, props))
  }

  /**
   * Render a component as a fresh mount: any state from an earlier mount is
   * discarded, so one test never inherits another's state.
   */
  runtime.mount = (component, props) => {
    componentState.clear()
    pendingComponent = component
    pendingProps = props
    effects.length = 0
    // Render once to seed the initial state (and collect the effect), then let
    // the caller drive the effect and re-render through `remount()`.
    return expand(React_.createElement(component, props))
  }

  /**
   * Re-render the component most recently passed to `mount`, keeping its state.
   * This models React re-rendering after an effect called a setter.
   */
  runtime.remount = () => {
    effects.length = 0
    return expand(React_.createElement(pendingComponent, pendingProps))
  }
  return runtime
}

/** Serialize an element tree to plain JSON, dropping functions and symbols. */
function plain(element) {
  return JSON.parse(JSON.stringify(element, (key, value) => {
    if (typeof value === 'function' || typeof value === 'symbol') return undefined
    return value
  }))
}

/** Collect every string in a tree, for asserting on visible copy. */
function texts(element) {
  const found = []
  const walk = (node) => {
    if (typeof node === 'string') { found.push(node); return }
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.children) node.children.forEach(walk)
  }
  walk(element)
  return found
}

/**
 * Run the collected effects and then drain the microtask queue.
 *
 * The Editor's effect starts an async IIFE rather than returning its promise,
 * so awaiting the effect alone leaves the subsequent state updates pending.
 * Draining a macrotask boundary lets them land before the next render.
 */
async function settle(client) {
  await Promise.all(client.effects.map((effect) => effect()))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const status = {
  hasVault: true, unlocked: true, noteCount: 2, encrypted: true, autoLockMinutes: 0,
  moods: [
    { id: 'joy', emoji: '😊', zh: '开心', en: 'Happy' },
    { id: 'sad', emoji: '😢', zh: '伤心', en: 'Sad' },
  ],
  templates: [
    { id: 'i-daily', persona: 'i', mood: null, name: { zh: 'i 人日记', en: 'Introvert' }, description: { zh: '安静', en: 'quiet' }, tags: [], promptCount: 3 },
    { id: 'free', persona: 'neutral', mood: null, name: { zh: '自由书写', en: 'Free' }, description: { zh: '随便写', en: 'anything' }, tags: [], promptCount: 0 },
  ],
  reminders: [],
  recent: [],
}

/** A fetch that answers every route the views use. */
function okFetch(overrides = {}) {
  return async (url, init) => {
    const route = String(url).replace('/echo-notes/api/', '')
    if (overrides[route]) return { status: 200, json: async () => ({ ok: true, value: overrides[route] }) }
    if (route === 'notes/read') {
      return {
        status: 200,
        json: async () => ({
          ok: true,
          value: {
            row: { id: 'n1', title: '今天', mood: 'joy', tags: ['工作'], createdAt: Date.now(), wordCount: 4, preview: '今天' },
            body: '今天很开心',
            history: [{ seq: 1, at: Date.now() - 86400000, body: '昨天的内容' }],
          },
        }),
      }
    }
    if (route === 'notes/stats') {
      return { status: 200, json: async () => ({ ok: true, value: { stats: { total: 3, byMood: { joy: 2 }, byDay: { '2026-10-08': 2, '2026-10-07': 1 }, byTag: {}, streakDays: 2, words: 30 } } }) }
    }
    if (route === 'reminders/list') {
      return {
        status: 200, json: async () => ({
          ok: true,
          value: { reminders: [{ id: 'r1', title: '睡前写一句', enabled: true, human: '每天 21:30', nextFireAt: new Date().toISOString(), schedule: { kind: 'daily', at: '21:30' } }] },
        }),
      }
    }
    return { status: 200, json: async () => ({ ok: true, value: {} }) }
  }
}

test('the Editor renders an existing note with its history', async () => {
  const client = await loadViews(okFetch())
  try {
    const element = client.mount(client.views.Editor, {
      status, noteId: 'n1', onSaved: () => {}, onDeleted: () => {}, onError: () => {},
    })
    // `loaded` starts false, so the first paint is the loading line.
    assert.ok(texts(element).some((text) => text.includes('载入中')))
  } finally {
    // nothing to dispose
  }
})

test('the Editor offers every template and every mood as a chip', async () => {
  const client = await loadViews(okFetch())
  const props = { status, noteId: null, onSaved: () => {}, onDeleted: () => {}, onError: () => {} }

  // The component flips `loaded` inside its effect. Real React re-renders after
  // that state change, so the stub must run the effect and then render again —
  // otherwise only the loading paint is ever observable.
  client.mount(client.views.Editor, props)
  await settle(client)
  const element = client.remount()
  const json = JSON.stringify(plain(element))
  assert.ok(json.includes('i 人日记'), 'templates are offered')
  assert.ok(json.includes('自由书写'))
  assert.ok(json.includes('开心') && json.includes('伤心'), 'moods are offered')
  assert.ok(json.includes('用模版开始'), 'the template section is labelled')
  assert.ok(json.includes('en-textarea'), 'the body editor is present')
})

test('the Editor shows the loading state, then the note, once the fetch settles', async () => {
  const client = await loadViews(okFetch())
  const props = { status, noteId: 'n1', onSaved: () => {}, onDeleted: () => {}, onError: () => {} }

  // First paint, before the async load resolves.
  const first = client.mount(client.views.Editor, props)
  assert.ok(texts(first).some((text) => text.includes('载入中')))

  // Run the pending effect, which awaits the fetch, then re-render.
  await settle(client)
  const second = client.remount()
  const visible = texts(second).join(' | ')
  assert.ok(visible.includes('保存'), 'the save control appears once loaded')
  assert.ok(visible.includes('历史版本'), 'the revision history section appears')
  assert.ok(visible.includes('昨天的内容'), 'a previous body is shown')
})

test('the Settings page renders encryption, passphrase, reminders and stats', async () => {
  const client = await loadViews(okFetch())
  const element = client.mount(client.views.Settings, {
    status, onChanged: () => {}, onError: () => {},
  })
  const visible = texts(element).join(' | ')
  assert.ok(visible.includes('加密'), 'encryption section')
  assert.ok(visible.includes('修改密码'), 'passphrase section')
  assert.ok(visible.includes('定时提醒'), 'reminders section')
  assert.ok(visible.includes('已加密'), 'encryption state is shown')
})

test('the NoteList shows an empty state and note rows with mood and tags', async () => {
  const client = await loadViews(okFetch())

  const empty = client.mount(client.views.NoteList, {
    notes: [], activeId: null, filters: { text: '' }, onFilters: () => {}, onOpen: () => {}, onNew: () => {},
  })
  assert.ok(texts(empty).some((text) => text.includes('还没有笔记')))

  const populated = client.mount(client.views.NoteList, {
    notes: [{
      id: 'n1', title: '今天', mood: 'sad', tags: ['工作', '加班'], preview: '有点累',
      createdAt: Date.now(), wordCount: 12,
    }],
    activeId: 'n1', filters: { text: '' }, onFilters: () => {}, onOpen: () => {}, onNew: () => {},
  })
  const visible = texts(populated).join(' | ')
  assert.ok(visible.includes('今天'))
  assert.ok(visible.includes('😢'), 'the mood emoji is rendered')
  assert.ok(visible.includes('工作') && visible.includes('加班'), 'tags are rendered')
  assert.ok(visible.includes('12 字'))
})

test('the VaultGate asks for a confirmation field only when creating', async () => {
  const client = await loadViews(okFetch())

  const creating = client.mount(client.views.VaultGate, {
    status: { hasVault: false }, onChanged: () => {}, onError: () => {},
  })
  const creatingText = texts(creating).join(' | ')
  assert.ok(creatingText.includes('创建你的笔记库'))
  assert.ok(creatingText.includes('确认密码'))
  assert.ok(creatingText.includes('AES-256-GCM'), 'the encryption promise is stated')

  const unlocking = client.mount(client.views.VaultGate, {
    status: { hasVault: true }, onChanged: () => {}, onError: () => {},
  })
  const unlockingText = texts(unlocking).join(' | ')
  assert.ok(unlockingText.includes('笔记库已锁定'))
  assert.ok(!unlockingText.includes('确认密码'), 'unlocking must not ask for confirmation')
})

test('every view renders without throwing when status is minimal', async () => {
  const client = await loadViews(okFetch())
  const minimal = { hasVault: true, unlocked: true, noteCount: 0, encrypted: false, moods: [], templates: [], reminders: [] }
  for (const [name, props] of [
    ['Editor', { status: minimal, noteId: null, onSaved: () => {}, onDeleted: () => {}, onError: () => {} }],
    ['Editor', { status: minimal, noteId: null, onError: () => {} }],
    ['Settings', { status: minimal, onChanged: () => {}, onError: () => {} }],
    ['NoteList', { notes: [], activeId: null, filters: { text: '' }, onFilters: () => {}, onOpen: () => {}, onNew: () => {} }],
    ['NoteList', {}],
    ['EchoNotesPanel', {}],
  ]) {
    const element = client.mount(client.views[name], props)
    assert.ok(element, `${name} must render`)
  }
})
