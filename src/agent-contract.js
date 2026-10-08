/**
 * Portable Agent tool contract shared by the DSH native tool and the MCP adapter.
 * Uses only standard JSON Schema keywords supported by common Agent APIs.
 */

export const ECHO_NOTE_ACTIONS = Object.freeze([
  'status', 'list', 'read', 'write', 'search', 'stats', 'templates', 'start', 'reminders',
])

export const ECHO_NOTE_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ECHO_NOTE_ACTIONS, description: 'Which diary operation to perform.' },
    id: { type: 'string', description: 'Note id for reading, updating, or removing.' },
    body: { type: 'string', description: 'Note text in Markdown or plain text.' },
    title: { type: 'string', description: 'Optional note title.' },
    mood: { type: 'string', enum: ['joy', 'excited', 'grateful', 'calm', 'tired', 'anxious', 'sad', 'angry', 'neutral'] },
    tags: { type: 'array', items: { type: 'string' } },
    templateId: { type: 'string' },
    query: { type: 'string', description: 'Search query.' },
    text: { type: 'string', description: 'Text filter.' },
    moods: { type: 'array', items: { type: 'string' } },
    from: { type: 'number', description: 'Inclusive created-at epoch milliseconds.' },
    to: { type: 'number', description: 'Inclusive created-at epoch milliseconds.' },
    limit: { type: 'integer', minimum: 0, maximum: 200 },
    order: { type: 'string', enum: ['asc', 'desc'] },
    pinned: { type: 'boolean' },
    reminderId: { type: 'string' },
    reminderTitle: { type: 'string' },
    reminderPrompt: { type: 'string' },
    everyMinutes: { type: 'integer', minimum: 5, maximum: 10080 },
    at: { type: 'string', description: 'Local HH:MM for daily/weekly, ISO timestamp for once.' },
    scheduleKind: { type: 'string', enum: ['daily', 'weekly', 'interval', 'once'] },
    scheduleWeekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 } },
    enabled: { type: 'boolean' },
  },
})

export const ECHO_NOTE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    message: { type: 'string' },
    hasVault: { type: 'boolean' },
    unlocked: { type: 'boolean' },
    noteCount: { type: 'integer' },
    hint: { type: 'string' },
    reminder: { type: 'object', additionalProperties: true },
    reminderViews: { type: 'array', items: { type: 'object', additionalProperties: true } },
    notes: { type: 'array', items: { type: 'object', additionalProperties: true } },
    note: { type: 'object', additionalProperties: true },
    body: { type: 'string' },
    row: { type: 'object', additionalProperties: true },
    history: { type: 'array', items: { type: 'object', additionalProperties: true } },
    created: { type: 'boolean' },
    removed: { oneOf: [{ type: 'string' }, { type: 'boolean' }] },
    stats: { type: 'object', additionalProperties: true },
    builtin: { type: 'array', items: { type: 'object', additionalProperties: true } },
    custom: { type: 'array', items: { type: 'object', additionalProperties: true } },
    moods: { type: 'array', items: { type: 'object', additionalProperties: true } },
    templates: { type: 'array', items: { type: 'object', additionalProperties: true } },
    templateId: { type: 'string' },
    saved: { type: 'string' },
    nextFireAt: { type: 'string' },
    human: { type: 'string' },
  },
})

export const ECHO_NOTE_DESCRIPTION = [
  'Echo Notes 回声笔记: manage the user’s private diary.',
  'Use status first. Note reads and writes require an unlocked vault.',
  'Never ask for or pass a passphrase through an Agent tool. The user unlocks the vault in the Echo Notes panel.',
  'Actions: status, list, read, write, search, stats, templates, start, reminders.',
].join('\n')

export function validateEchoNoteArgs(args) {
  validateSchema(args, ECHO_NOTE_PARAMETERS, 'arguments')
  if (!ECHO_NOTE_ACTIONS.includes(args.action)) throw new TypeError('arguments.action is required and must be a supported action')
  return args
}

export function validateEchoNoteResult(value) {
  validateSchema(value, ECHO_NOTE_OUTPUT_SCHEMA, 'result')
  JSON.stringify(value)
  return value
}

function validateSchema(value, schema, path) {
  if (schema.oneOf) {
    const valid = schema.oneOf.filter((branch) => {
      try { validateSchema(value, branch, path); return true } catch { return false }
    })
    if (valid.length !== 1) throw new TypeError(`${path} must match exactly one allowed schema`)
    return
  }
  if (schema.type === 'object') {
    assertObject(value, path)
    const properties = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter((key) => !Object.hasOwn(properties, key))
      if (extra.length) throw new TypeError(`${path} has unsupported properties: ${extra.join(', ')}`)
    }
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`)
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchema(value[key], child, `${path}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
    if (schema.items) for (const [index, item] of value.entries()) validateSchema(item, schema.items, `${path}[${index}]`)
    return
  }
  if (schema.type === 'string' && typeof value !== 'string') throw new TypeError(`${path} must be a string`)
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`)
  if (schema.type === 'integer' && !Number.isInteger(value)) throw new TypeError(`${path} must be an integer`)
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError(`${path} must be a finite number`)
  if (schema.enum && !schema.enum.includes(value)) throw new TypeError(`${path} must be one of ${JSON.stringify(schema.enum)}`)
  if (schema.minimum !== undefined && value < schema.minimum) throw new TypeError(`${path} must be >= ${schema.minimum}`)
  if (schema.maximum !== undefined && value > schema.maximum) throw new TypeError(`${path} must be <= ${schema.maximum}`)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
}
