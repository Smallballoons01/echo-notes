/**
 * Echo Notes 回声笔记 — Host half.
 *
 * Responsibilities, in the order they matter:
 *
 * 1. **Own the vault.** One place opens the storage domain, holds the unlocked
 *    data key, and is the only writer of note bodies. The Client never sees a
 *    key; it asks this half to do things over HTTP.
 * 2. **Expose the same operations to the agent** as tools, and to the writer as
 *    UI actions, from one implementation — so the two can never drift.
 * 3. **Run reminders** as Host timers that wake the agent with a prompt.
 *
 * The Client talks to this half over `ctx.webServer` routes rather than a
 * generated Remote namespace: this bundle is plain JavaScript with no code
 * generation step, and the typed Remote gateway only routes generated or
 * SRC-marked definitions. The HTTP surface is therefore the honest one.
 *
 * @module @dsh-plugin/echo-notes
 */

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

import schemastery from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'

import { CryptoError, createKeyring, unlockKeyring, wrapWith } from './src/crypto.js'
import { NoteStore } from './src/store.js'
import {
  BUILTIN_TEMPLATES,
  MOODS,
  listTemplates,
  renderTemplate,
  templateById,
  templateForMood,
} from './src/templates.js'
import { DEFAULT_GRACE_MS, describeSchedule, dueAction, nextFireAt, validateSchedule } from './src/reminders.js'
import { ECHO_NOTE_DESCRIPTION, ECHO_NOTE_OUTPUT_SCHEMA, ECHO_NOTE_PARAMETERS, validateEchoNoteArgs, validateEchoNoteResult } from './src/agent-contract.js'

/** Host service keys this plugin needs to do its job. */
export const inject = ['tools', 'skills', 'webServer', 'storageDomain']

/** Route prefix for the Client-facing HTTP API. */
const API_PREFIX = '/echo-notes/api'

/** How often the reminder loop checks for due reminders. */
const REMINDER_TICK_MS = 30_000

/**
 * Plugin configuration. Every value is overridable from `cordis.patch.yml`, so
 * a user's tuning survives plugin upgrades.
 *
 * Declared as a schemastery schema — the dialect the Loader validates a plugin
 * row's `config` against — rather than a raw JSON Schema object, which the
 * framework would not apply.
 */
export const Config = schemastery.object({
  /** Auto-lock the vault after N minutes of inactivity; 0 disables auto-lock. */
  autoLockMinutes: schemastery.number().min(0).max(1440).default(0),
  /** Default local time used by a reminder created without an explicit one. */
  defaultReminder: schemastery.string().default('21:30'),
  /** Whether notes are encrypted by default once a vault exists. */
  encryptByDefault: schemastery.boolean().default(true),
  /** How often the reminder/auto-lock loop runs, in seconds. */
  tickSeconds: schemastery.number().min(5).max(600).default(30),
})

/**
 * Activate the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ autoLockMinutes?: number, defaultReminder?: string, encryptByDefault?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  const settings = {
    autoLockMinutes: config.autoLockMinutes ?? 0,
    defaultReminder: config.defaultReminder ?? '21:30',
    encryptByDefault: config.encryptByDefault ?? true,
    tickSeconds: config.tickSeconds ?? REMINDER_TICK_MS / 1000,
  }

  const vault = new Vault(ctx, settings)
  // Bind once: Cordis invokes a disposer unbound, so `this` would otherwise be
  // lost and the teardown would throw instead of releasing the data key.
  ctx.effect(() => () => vault.dispose(), 'echo-notes: vault')

  registerHttpApi(ctx, vault)
  registerTools(ctx, vault)
  registerSkill(ctx, vault)

  ctx.effect(() => startReminderLoop(ctx, vault), 'echo-notes: reminder loop')
}

/* -------------------------------------------------------------------------- */
/* Vault                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The vault owns the storage domain, the data key, the note store and the
 * reminders. It is deliberately a plain class rather than a Cordis Service:
 * nothing else in the profile needs to reach it, and keeping it private keeps
 * the key out of every other plugin's reach.
 */
class Vault {
  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx, settings) {
    this.ctx = ctx
    this.settings = settings
    /** @type {Buffer | undefined} */
    this.dataKey = undefined
    /** @type {any} */
    this.domain = undefined
    /** @type {NoteStore | undefined} */
    this.store = undefined
    this.lastActivity = Date.now()
    this.disposed = false

    this.store = new NoteStore({
      tables: () => this.domain?.table.bind(this.domain) && this.tables(),
      dataKey: () => this.dataKey,
      idFactory: () => `n_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
    })
  }

  /** The open domain's tables, or undefined before {@link open}. */
  tables() {
    if (!this.domain) return undefined
    return {
      notes: this.domain.table('notes'),
      revisions: this.domain.table('revisions'),
      settings: this.domain.table('settings'),
    }
  }

  /**
   * Open the storage domain. Safe to call repeatedly.
   * @returns {Promise<void>}
   */
  async open() {
    if (this.domain) return
    this.domain = await this.ctx.storageDomain.open(ECHO_NOTES_DOMAIN)
    await this.store.hydrate()
  }

  /** Read one persisted setting. */
  setting(name) {
    return this.tables()?.settings.get(name)
  }

  /** Persist one setting. */
  async setSetting(name, value) {
    await this.tables()?.settings.put(name, value)
  }

  /** Whether a vault (a passphrase) has been created. */
  get hasVault() {
    return this.setting('keyring') !== undefined
  }

  /** Whether the data key is currently held in memory. */
  get unlocked() {
    return this.dataKey !== undefined
  }

  /** Whether new note bodies and revisions must be encrypted at rest. */
  get encryptionEnabled() {
    return this.setting('encryptionEnabled') ?? this.settings.encryptByDefault
  }

  /**
   * Assert the vault is open, for operations that must not proceed without a key.
   *
   * Throws the same `locked` code the tool layer reports, so a locked vault
   * always reads as one actionable condition rather than five variants.
   */
  requireUnlocked() {
    if (!this.unlocked) {
      throw new VaultError('locked', 'the Echo Notes vault is locked; unlock it in the Echo Notes panel')
    }
  }

  /** Mark activity for auto-lock accounting. */
  touch() {
    this.lastActivity = Date.now()
  }

  /**
   * Create the vault and unlock it.
   * @param {string} passphrase
   * @returns {Promise<{ created: boolean }>}
   */
  async create(passphrase) {
    await this.open()
    if (this.hasVault) throw new VaultError('vault-exists', 'a vault already exists; unlock it instead')
    const keyring = await createKeyring(passphrase)
    await this.setSetting('keyring', keyring)
    this.dataKey = await unlockKeyring(passphrase, keyring)
    const shouldEncrypt = this.setting('encryptionEnabled') ?? this.settings.encryptByDefault
    await this.setSetting('encryptionEnabled', shouldEncrypt)
    if (shouldEncrypt) await this.store.enableEncryption()
    this.touch()
    return { created: true }
  }

  /**
   * Unlock an existing vault.
   * @param {string} passphrase
   * @returns {Promise<{ unlocked: true }>}
   */
  async unlock(passphrase) {
    await this.open()
    const keyring = this.setting('keyring')
    if (!keyring) throw new VaultError('no-vault', 'no vault exists yet; create one first')
    const key = await unlockKeyring(passphrase, keyring)
    this.dataKey = key
    this.touch()
    return { unlocked: true }
  }

  /** Drop the data key from memory. Ciphertext stays on disk. */
  lock() {
    this.dataKey = undefined
    return { locked: true }
  }

  /**
   * Change the passphrase by rewrapping the data key.
   *
   * Note bodies are untouched: this is the entire reason the key is wrapped
   * rather than derived per note.
   *
   * @param {string} current
   * @param {string} next
   */
  async changePassphrase(current, next) {
    await this.open()
    const keyring = this.setting('keyring')
    if (!keyring) throw new VaultError('no-vault', 'no vault exists yet')
    const dataKey = await unlockKeyring(current, keyring) // throws wrong-passphrase
    // Re-wrap the *same* data key under the new passphrase. Dedicated notes are
    // never rewritten, which is the whole point of the indirection.
    await this.setSetting('keyring', await wrapWith(dataKey, next))
    this.dataKey = dataKey
    return { changed: true }
  }

  /**
   * Everything the UI needs to render without knowing a key.
   * @returns {Promise<any>}
   */
  async status() {
    await this.open()
    const notes = this.unlocked ? this.store.list() : []
    return {
      hasVault: this.hasVault,
      unlocked: this.unlocked,
      noteCount: this.unlocked ? this.store.rows.size : this.countRows(),
      encrypted: this.encryptionEnabled,
      autoLockMinutes: this.settings.autoLockMinutes,
      moods: MOODS,
      templates: listTemplates(this.customTemplates()).map((tpl) => ({
        id: tpl.id,
        persona: tpl.persona,
        mood: tpl.mood,
        name: tpl.name,
        description: tpl.description,
        tags: tpl.tags ?? [],
        promptCount: (tpl.prompts ?? []).length,
      })),
      reminders: this.reminders().map((reminder) => ({
        ...reminder,
        nextFireAt: nextFireAt(reminder, new Date())?.toISOString() ?? null,
        human: describeSchedule(reminder.schedule),
      })),
      recent: notes.slice(0, 5),
    }
  }

  /** Count persisted rows without unlocking (metadata is not secret). */
  countRows() {
    return this.tables()?.notes.size ?? 0
  }

  /** User-authored templates stored in settings. */
  customTemplates() {
    return this.setting('customTemplates') ?? []
  }

  /** Stored reminders. */
  reminders() {
    return this.setting('reminders') ?? []
  }

  /** @param {any[]} reminders */
  async saveReminders(reminders) {
    await this.setSetting('reminders', reminders)
  }

  /** Release the domain. */
  async dispose() {
    this.disposed = true
    this.dataKey = undefined
    try {
      await this.domain?.close()
    } catch {
      // Closing an already-closed domain is harmless.
    }
  }
}

/**
 * The vault's durable layout.
 *
 * `notes` stores each row with its body alongside the index fields, so one note
 * is one persisted unit and the store writes it atomically. The schema is
 * intentionally permissive (`json`) with the invariants enforced by
 * {@link NoteStore}: the record shape evolves while the diary is in use, and a
 * strict schema would turn every future field into a migration.
 */
const ECHO_NOTES_DOMAIN = {
  // Domain names must match /^[a-z][a-z0-9_]*$/, so this is underscored while
  // the package and route keep the hyphenated "echo-notes" spelling.
  name: 'echo_notes',
  version: 1,
  tables: {
    notes: {
      valueSchema: zod.object({
        id: zod.string(), createdAt: zod.number(), updatedAt: zod.number(), mood: zod.string().nullable(),
        tags: zod.array(zod.string()), templateId: zod.string().nullable(), title: zod.string(), preview: zod.string(),
        encrypted: zod.boolean(), wordCount: zod.number(), pinned: zod.boolean(), body: zod.string().optional(),
      }).passthrough(),
    },
    revisions: {
      valueSchema: zod.object({
        noteId: zod.string(), seq: zod.number(), at: zod.number(), body: zod.string(), encrypted: zod.boolean().optional(),
      }).passthrough(),
    },
    settings: { valueSchema: zod.json() },
  },
}

/** A typed failure the HTTP layer maps to a status code. */
class VaultError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

/** Re-wrap an existing data key under a fresh passphrase. */

/* -------------------------------------------------------------------------- */
/* Reminder loop                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Poll for due reminders and wake the agent.
 *
 * A reminder's job is to *start a note*, so firing it calls `agent.followup()`
 * with a prompt: the agent then writes the entry itself.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Vault} vault
 * @returns {() => void} disposer
 */
function startReminderLoop(ctx, vault) {
  const timer = setInterval(() => {
    void tick()
  }, Math.max(1, vault.settings.tickSeconds) * 1000)
  // Do not keep the process alive purely for reminders.
  timer.unref?.()

  async function tick() {
    if (vault.disposed) return
    try {
      // Auto-lock runs before the reminder check (and even when there are no
      // reminders) so the data key does not stay resident on an idle machine.
      enforceAutoLock(vault)
      if (!vault.unlocked) return

      const reminders = vault.reminders()
      if (reminders.length === 0) return
      const now = new Date()
      let changed = false

      for (const reminder of reminders) {
        const decision = dueAction(reminder, now, DEFAULT_GRACE_MS)
        if (decision.action !== 'fire') continue
        reminder.lastFiredAt = now.toISOString()
        changed = true
        await fireReminder(ctx, vault, reminder)
      }
      if (changed) await vault.saveReminders(reminders)
    } catch (error) {
      ctx.logger?.warn?.(`echo-notes: reminder tick failed: ${error?.message ?? error}`)
    }
  }

  return () => clearInterval(timer)
}

/**
 * Lock the vault once it has been idle for the configured number of minutes.
 * A configured value of 0 disables auto-lock, which is the default.
 *
 * The check runs on the reminder tick, so the lock lands within one tick of the
 * deadline rather than exactly on it. That is deliberately coarse: the cost of
 * a late lock is a few seconds of a resident key, while a dedicated fine-grained
 * timer would wake the process far more often for no benefit.
 *
 * @param {Vault} vault
 * @param {number} [now] injectable clock for tests
 * @returns {boolean} whether the vault was locked by this call
 */
function enforceAutoLock(vault, now = Date.now()) {
  const minutes = vault.settings.autoLockMinutes
  if (!minutes || minutes <= 0) return false
  if (!vault.unlocked) return false
  if (now - vault.lastActivity < minutes * 60_000) return false
  vault.lock()
  return true
}

/**
 * Deliver one reminder by waking every live agent with a prompt.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Vault} vault
 * @param {any} reminder
 */
async function fireReminder(ctx, vault, reminder) {
  const agentService = ctx.get('agents')
  if (!agentService) return
  const template = templateById(reminder.templateId, vault.customTemplates())
  const prompt = [
    `[echo-notes reminder] ${reminder.title}`,
    reminder.prompt ?? '',
    template ? `请使用「${template.name.zh}」模版开启一篇新的笔记。` : '',
    '使用 echo_note_write 工具写入，情绪标记为 mood 参数；写完用一句话告诉用户已记录。',
  ]
    .filter(Boolean)
    .join('\n')

  for (const agent of agentService.list()) {
    try {
      await agent.followup({ text: prompt })
    } catch {
      // An agent that cannot be woken (disposed, busy) is skipped.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP API for the Client half                                                */
/* -------------------------------------------------------------------------- */

/**
 * Register the Client-facing JSON API.
 *
 * Endpoints are intentionally coarse: the UI is a thin renderer and every
 * operation the writer can perform from a button is also a tool the agent can
 * call from a prompt, implemented once in {@link operations}.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Vault} vault
 */
function registerHttpApi(ctx, vault) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const route = url.pathname.slice(API_PREFIX.length) || '/'

          // An unauthenticated local HTTP surface would let any process on the
          // machine read the diary. Every response is same-origin only and the
          // API refuses non-local Host headers.
          if (!isLocalRequest(req)) {
            return send(res, 403, { ok: false, error: 'forbidden', message: 'echo-notes API is local-only' })
          }
          if (req.method === 'POST' && !isAllowedOrigin(req)) {
            return send(res, 403, { ok: false, error: 'forbidden', message: 'cross-origin writes are not allowed' })
          }

          try {
            if (req.method === 'GET' && route === '/status') {
              return send(res, 200, { ok: true, value: await vault.status() })
            }
            if (req.method === 'POST') {
              const body = await readJson(req)
              if (route === '/tool') {
                validateEchoNoteArgs(body)
                const value = validateEchoNoteResult(await runToolAction(vault, body))
                return send(res, 200, { ok: true, value })
              }
              const result = await operations[vault_route(route)]?.(vault, body)
              if (result === undefined) {
                return send(res, 404, { ok: false, error: 'not-found', message: `no route ${route}` })
              }
              return send(res, 200, { ok: true, value: result })
            }
            return send(res, 405, { ok: false, error: 'method-not-allowed', message: `${req.method} ${route}` })
          } catch (error) {
            return sendError(res, error)
          }
        },
      }),
    'echo-notes: http api',
  )
}

/** Map a URL path to an operation name. */
function vault_route(route) {
  return route.replace(/^\//, '').replace(/\//g, '.')
}

/**
 * Reject requests that did not originate from the local page.
 *
 * The check is on the Host header rather than an Origin header because a
 * same-origin `fetch` from the app may omit Origin on GET; a loopback Host is
 * the property that actually holds.
 *
 * @param {import('node:http').IncomingMessage} req
 */
function isLocalRequest(req) {
  const host = req.headers.host ?? ''
  const name = host.replace(/:\d+$/, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1'
}

/** Reject a cross-origin browser write while permitting non-browser callers without Origin. */
function isAllowedOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    return parsed.host === req.headers.host && ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

/** Read and parse a JSON request body with a size cap. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new VaultError('too-large', 'request body exceeds 2 MiB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new VaultError('bad-json', 'request body is not valid JSON')
  }
}

/** Write a JSON response. */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Map a thrown error to a status code and a stable code. */
function sendError(res, error) {
  if (error instanceof CryptoError) {
    const status = error.code === 'wrong-passphrase' ? 401 : 400
    return send(res, status, { ok: false, error: error.code, message: error.message })
  }
  if (error instanceof VaultError) {
    const status = error.code === 'locked' ? 423 : error.code === 'vault-exists' ? 409 : 400
    return send(res, status, { ok: false, error: error.code, message: error.message })
  }
  return send(res, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) })
}

/**
 * The single implementation of every user-visible operation.
 *
 * The HTTP API, the agent tools and (through them) the UI all call these, so a
 * behaviour can never differ depending on which caller invoked it.
 */
const operations = {
  /* -- vault lifecycle ---------------------------------------------------- */

  async 'vault.create'(vault, body) {
    return vault.create(requirePassphrase(body.passphrase))
  },

  async 'vault.unlock'(vault, body) {
    return vault.unlock(requirePassphrase(body.passphrase))
  },

  async 'vault.lock'(vault) {
    return vault.lock()
  },

  async 'vault.changePassphrase'(vault, body) {
    return vault.changePassphrase(requirePassphrase(body.current), requirePassphrase(body.next))
  },

  async 'vault.encryptAll'(vault) {
    vault.requireUnlocked()
    const result = await vault.store.enableEncryption()
    await vault.setSetting('encryptionEnabled', true)
    return result
  },

  async 'vault.decryptAll'(vault) {
    vault.requireUnlocked()
    const result = await vault.store.disableEncryption()
    await vault.setSetting('encryptionEnabled', false)
    return result
  },

  /* -- notes -------------------------------------------------------------- */

  async 'notes.write'(vault, body) {
    vault.requireUnlocked()
    vault.touch()
    const text = String(body.body ?? '')
    if (body.id) {
      const row = await vault.store.update(body.id, {
        body: text,
        mood: body.mood,
        tags: body.tags,
        title: body.title,
        pinned: body.pinned,
      })
      if (!row) throw new VaultError('not-found', `no note ${body.id}`)
      return { note: row, created: false }
    }
    const row = await vault.store.create({
      body: text,
      mood: body.mood ?? null,
      tags: body.tags ?? [],
      templateId: body.templateId ?? null,
      title: body.title,
      encrypted: vault.encryptionEnabled,
    })
    return { note: row, created: true }
  },

  async 'notes.read'(vault, body) {
    vault.requireUnlocked()
    vault.touch()
    const found = await vault.store.read(String(body.id ?? ''))
    if (!found) throw new VaultError('not-found', `no note ${body.id}`)
    return { ...found, history: vault.store.history(found.row.id) }
  },

  async 'notes.list'(vault, body) {
    vault.requireUnlocked()
    vault.touch()
    return {
      notes: vault.store.list({
        from: body.from,
        to: body.to,
        moods: body.moods,
        tags: body.tags,
        templateId: body.templateId,
        text: body.text,
        limit: body.limit ?? 100,
        order: body.order ?? 'desc',
        pinnedFirst: body.pinnedFirst ?? true,
      }),
    }
  },

  async 'notes.search'(vault, body) {
    vault.requireUnlocked()
    vault.touch()
    return {
      notes: vault.store.list({ text: String(body.query ?? ''), limit: body.limit ?? 50 }),
    }
  },

  async 'notes.remove'(vault, body) {
    vault.requireUnlocked()
    const removed = await vault.store.remove(String(body.id ?? ''))
    return { removed }
  },

  async 'notes.stats'(vault, body) {
    vault.requireUnlocked()
    return { stats: vault.store.stats({ from: body.from, to: body.to }) }
  },

  /* -- templates ---------------------------------------------------------- */

  async 'templates.list'(vault) {
    return {
      builtin: BUILTIN_TEMPLATES,
      custom: vault.customTemplates(),
      moods: MOODS,
    }
  },

  async 'templates.save'(vault, body) {
    const template = body.template
    if (!template?.id) throw new VaultError('bad-template', 'a template needs an id')
    const custom = vault.customTemplates().filter((entry) => entry.id !== template.id)
    custom.push(template)
    await vault.setSetting('customTemplates', custom)
    return { saved: template.id }
  },

  async 'templates.remove'(vault, body) {
    const id = String(body.id ?? '')
    const custom = vault.customTemplates().filter((entry) => entry.id !== id)
    await vault.setSetting('customTemplates', custom)
    return { removed: id }
  },

  async 'templates.render'(vault, body) {
    const template = templateById(String(body.id ?? ''), vault.customTemplates())
    if (!template) throw new VaultError('not-found', `no template ${body.id}`)
    return { body: renderTemplate(template, { mood: body.mood }) }
  },

  /** The template that matches a mood, used by "write about how I feel". */
  async 'templates.forMood'(vault, body) {
    return { template: templateForMood(body.mood, vault.customTemplates()) }
  },

  /* -- reminders ---------------------------------------------------------- */

  async 'reminders.list'(vault) {
    const now = new Date()
    return {
      reminders: vault.reminders().map((reminder) => ({
        ...reminder,
        human: describeSchedule(reminder.schedule),
        // Reported on every read so a caller never has to compute the schedule
        // itself — the whole point of the human line and the next instant.
        nextFireAt: reminder.enabled === false ? null : nextFireAt(reminder, now)?.toISOString() ?? null,
      })),
    }
  },

  async 'reminders.save'(vault, body) {
    const reminder = body.reminder
    if (!reminder?.id) throw new VaultError('bad-reminder', 'a reminder needs an id')
    const problems = validateSchedule(reminder.schedule)
    if (problems.length > 0) throw new VaultError('bad-reminder', problems.join('; '))
    if (!reminder.title) throw new VaultError('bad-reminder', 'a reminder needs a title')
    const existing = vault.reminders().filter((entry) => entry.id !== reminder.id)
    existing.push({ enabled: true, ...reminder })
    await vault.saveReminders(existing)
    return { saved: reminder.id, nextFireAt: nextFireAt(reminder, new Date())?.toISOString() ?? null }
  },

  async 'reminders.remove'(vault, body) {
    const id = String(body.id ?? '')
    await vault.saveReminders(vault.reminders().filter((entry) => entry.id !== id))
    return { removed: id }
  },

  async 'reminders.toggle'(vault, body) {
    const id = String(body.id ?? '')
    const reminders = vault.reminders().map((entry) =>
      entry.id === id ? { ...entry, enabled: body.enabled ?? !entry.enabled } : entry,
    )
    await vault.saveReminders(reminders)
    const now = new Date()
    return {
      reminders: reminders.map((reminder) => ({
        ...reminder,
        human: describeSchedule(reminder.schedule),
        nextFireAt: reminder.enabled === false ? null : nextFireAt(reminder, now)?.toISOString() ?? null,
      })),
    }
  },
}

/** Validate a passphrase before it reaches the KDF. */
function requirePassphrase(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VaultError('bad-passphrase', 'a passphrase is required')
  }
  if (value.length < 4) {
    throw new VaultError('weak-passphrase', 'a passphrase must be at least 4 characters')
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* Agent tools                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Expose the vault to the agent.
 *
 * One `echo_note` tool with an `action` keeps the schema small while covering
 * every operation; the descriptions carry the routing information the model
 * needs to pick the right action.
 *
 * The declared `output.schema` is the shape actually returned, so the model
 * sees real fields rather than an opaque blob.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Vault} vault
 */
function registerTools(ctx, vault) {
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'echo_note',
        description: ECHO_NOTE_DESCRIPTION,
        parameters: ECHO_NOTE_PARAMETERS,
        output: {
          schema: ECHO_NOTE_OUTPUT_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          if (exec.signal?.aborted) throw new ToolFailure('cancelled', 'the call was cancelled')
          validateEchoNoteArgs(args)
          const result = await runToolAction(vault, args)
          validateEchoNoteResult(result)
          return result
        },
        presentCall: (args) => presentToolCall(args),
      }),
    'echo-notes: tool',
  )
}

/** A tool-level failure carrying a stable code rather than a thrown stack. */
class ToolFailure extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ToolFailure'
    this.code = code
  }
}

/** Render a short, non-secret line for the tool-call card. */
function presentToolCall(args) {
  const labels = {
    status: 'Check diary status',
    list: 'Read diary',
    read: 'Read one entry',
    write: args.id ? 'Update diary entry' : 'Write diary entry',
    search: `Search diary: ${args.query ?? ''}`.trim(),
    stats: 'Diary statistics',
    templates: 'List diary templates',
    start: 'Start entry from template',
    reminders: 'Diary reminders',
  }
  return { title: labels[args.action] ?? 'Echo Notes', kind: args.action === 'write' ? 'write' : 'read' }
}

/**
 * Dispatch one tool call to the shared operations.
 * @param {Vault} vault
 * @param {any} args
 */
async function runToolAction(vault, args) {
  const action = args.action

  try {
    if (action === 'status') {
      const status = await vault.status()
      return {
        ok: true,
        hasVault: status.hasVault,
        unlocked: status.unlocked,
        noteCount: status.noteCount,
        reminderViews: status.reminders,
        templates: status.templates.map((tpl) => ({ id: tpl.id, name: tpl.name, mood: tpl.mood })),
        hint: status.unlocked
          ? undefined
          : 'The vault is locked: ask the user to unlock it in the Echo Notes panel.',
      }
    }

    // Templates are static data and stay readable while locked; everything that
    // touches note text requires the key.
    if (!vault.unlocked && action !== 'templates' && action !== 'start') {
      throw new ToolFailure(
        'locked',
        'the Echo Notes vault is locked; ask the user to unlock it in the Echo Notes panel',
      )
    }

    switch (action) {
      case 'list':
        return { ok: true, ...(await operations['notes.list'](vault, {
          from: args.from, to: args.to, moods: args.moods, tags: args.tags,
          templateId: args.templateId, text: args.text, limit: args.limit ?? 50, order: args.order,
        })) }

      case 'read': {
        const found = await operations['notes.read'](vault, { id: args.id })
        return { ok: true, row: found.row, body: found.body, history: found.history }
      }

      case 'write': {
        const result = await operations['notes.write'](vault, args)
        return { ok: true, note: result.note, created: result.created }
      }

      case 'search':
        return { ok: true, ...(await operations['notes.search'](vault, { query: args.query, limit: args.limit })) }

      case 'stats':
        return { ok: true, ...(await operations['notes.stats'](vault, { from: args.from, to: args.to })) }

      case 'templates':
        return { ok: true, ...(await operations['templates.list'](vault)) }

      case 'start': {
        const id = args.templateId ?? templateForMood(args.mood, vault.customTemplates()).id
        const rendered = await operations['templates.render'](vault, { id, mood: args.mood })
        return { ok: true, templateId: id, body: rendered.body }
      }

      case 'reminders':
        return { ok: true, ...(await remindersAction(vault, args)) }

      default:
        // Unreachable through the tool (the compiled schema rejects an unknown
        // action first), but the HTTP path shares this dispatcher.
        throw new ToolFailure('bad-action', `unknown action ${JSON.stringify(action)}`)
    }
  } catch (error) {
    if (error instanceof ToolFailure) return { ok: false, error: error.code, message: error.message }
    if (error instanceof VaultError) return { ok: false, error: error.code, message: error.message }
    if (error instanceof CryptoError) return { ok: false, error: error.code, message: error.message }
    throw error
  }
}

/** The `reminders` tool action multiplexes four sub-operations. */
async function remindersAction(vault, args) {
  // A save needs a title; without one, an id selects remove/toggle, and neither
  // means "list".
  if (args.reminderTitle) {
    const reminder = {
      id: args.reminderId ?? `r_${Date.now().toString(36)}`,
      title: args.reminderTitle,
      prompt: args.reminderPrompt ?? '',
      templateId: args.templateId ?? null,
      mood: args.mood ?? null,
      schedule: scheduleFromArgs(vault, args),
      enabled: args.enabled ?? true,
    }
    const saved = await operations['reminders.save'](vault, { reminder })
    return { saved: saved.saved, reminder, nextFireAt: saved.nextFireAt, human: describeSchedule(reminder.schedule) }
  }
  if (args.reminderId) {
    if (args.enabled === undefined) return operations['reminders.remove'](vault, { id: args.reminderId })
    const toggled = await operations['reminders.toggle'](vault, { id: args.reminderId, enabled: args.enabled })
    return { reminderViews: toggled.reminders }
  }
  const listed = await operations['reminders.list'](vault)
  return { reminderViews: listed.reminders }
}

/** Build a schedule from flattened tool arguments. */
function scheduleFromArgs(vault, args) {
  const kind = args.scheduleKind ?? 'daily'
  switch (kind) {
    case 'daily':
      return { kind, at: args.at ?? vault.settings.defaultReminder }
    case 'weekly':
      return { kind, at: args.at ?? vault.settings.defaultReminder, weekdays: args.scheduleWeekdays ?? [1] }
    case 'interval':
      return { kind, everyMinutes: args.everyMinutes ?? 60 }
    case 'once':
      return { kind, at: args.at ?? new Date(Date.now() + 3600_000).toISOString() }
    default:
      return { kind: 'daily', at: vault.settings.defaultReminder }
  }
}

/* -------------------------------------------------------------------------- */
/* Skill                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Register the `echo-notes` skill so the agent has the workflow, not just the
 * tool: which template to pick for which mood, and how to write an entry that
 * sounds like the writer rather than like a chatbot.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Vault} vault
 */
function registerSkill(ctx, vault) {
  ctx.effect(
    () =>
      ctx.skills.register({
        name: 'echo-notes',
        description:
          'Write and review entries in the user\'s Echo Notes 回声笔记 diary: pick an emotion template, capture an entry in the user\'s own voice, and set up writing reminders.',
        whenToUse:
          'Use when the user asks to write a diary or journal entry, to record how they feel, to look back over past entries, or to be reminded to write.',
        content: [
          '# Echo Notes 回声笔记',
          '',
          'A private, emotion-first diary in the Harness. Notes are encrypted at rest once the',
          'user has created a vault.',
          '',
          '## Before anything else',
          '',
          '1. Call `echo_note` with `action: "status"`. This tells you whether the vault is',
          '   unlocked and how many notes exist.',
          '2. If the vault is locked, stop and ask the user to unlock it in the **Echo Notes**',
          '   panel. Do not ask them to type their passphrase into the chat, and never accept a',
          '   passphrase as a tool argument — the tool has no such parameter by design.',
          '',
          '## Writing an entry',
          '',
          '1. Pick the emotion. If the user named one ("今天有点丧"), map it to a mood id from',
          '   `action: "templates"`. If they did not, ask one short question — do not interrogate.',
          '2. Get scaffolding with `action: "start"`, passing `mood` or `templateId`. For an',
          '   introvert-flavoured entry use `i-daily`; for an extrovert-flavoured one, `e-daily`.',
          '3. Write the body in **the user\'s own voice and language**. This is a diary, not a',
          '   report: keep first person, keep their phrasing, and never add a summary, a moral,',
          '   or an offer of advice unless they asked for one.',
          '4. Call `action: "write"` with the body, the `mood`, and any `tags`.',
          '5. Reply in one short sentence confirming what was recorded. Do not paste the note',
          '   back — the user just wrote it.',
          '',
          'Keep a typical entry to 2–6 sentences. A diary entry that is too long is a diary',
          'entry the user will not keep.',
          '',
          '## Reviewing',
          '',
          '- `action: "list"` with `from`/`to` (epoch ms) for a time window, or `moods`/`tags` to',
          '  slice by feeling.',
          '- `action: "search"` for a phrase. Search runs against decrypted bodies, so it only',
          '  works while the vault is unlocked.',
          '- `action: "stats"` for counts by mood, day and tag plus the writing streak. Use this',
          '  when the user asks "how have I been lately".',
          '',
          'Report patterns you actually observe in the data. Do not diagnose, and do not treat a',
          'cluster of low moods as a clinical signal — mention what you see and let the user',
          'decide what it means.',
          '',
          '## Reminders',
          '',
          'Use `action: "reminders"` with `reminderTitle` and a `schedule` to create one.',
          'Schedules are `{kind:"daily",at:"21:30"}`, `{kind:"weekly",at:"09:00",weekdays:[1]}`',
          '(1=Mon … 7=Sun), `{kind:"interval",everyMinutes:45}`, or `{kind:"once",at:"<ISO>"}`.',
          'When a reminder fires it wakes you with a prompt; write the entry then, following the',
          'same rules above.',
          '',
          '## Privacy',
          '',
          'Note bodies are the user\'s private material. Quote them only when the user asks about',
          'that note, and never copy diary text into another tool call (a file, a web request, a',
          'message to another agent) without being asked.',
        ].join('\n'),
        invocation: { modelInvocable: true, userInvocable: true },
      }),
    'echo-notes: skill',
  )
}
