import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ECHO_NOTE_OUTPUT_SCHEMA,
  ECHO_NOTE_PARAMETERS,
  validateEchoNoteArgs,
  validateEchoNoteResult,
} from '../src/agent-contract.js'

function assertPortableSchema(schema, path = '$') {
  const allowedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${path} must be an object schema`)
  if (schema.type !== undefined) assert.ok(allowedTypes.has(schema.type), `${path} has a portable type`)
  if (schema.type === 'object') {
    assert.equal(typeof schema.additionalProperties, 'boolean', `${path} defines additionalProperties`)
    for (const [key, value] of Object.entries(schema.properties ?? {})) assertPortableSchema(value, `${path}.properties.${key}`)
  }
  if (schema.type === 'array' && schema.items) assertPortableSchema(schema.items, `${path}.items`)
  if (schema.oneOf) for (const [index, branch] of schema.oneOf.entries()) assertPortableSchema(branch, `${path}.oneOf[${index}]`)
}

test('both Agent schemas use portable standard JSON Schema types', () => {
  assertPortableSchema(ECHO_NOTE_PARAMETERS)
  assertPortableSchema(ECHO_NOTE_OUTPUT_SCHEMA)
  assert.deepEqual(ECHO_NOTE_PARAMETERS.required, ['action'])
})

test('argument validation enforces action, enums, nested arrays and bounds', () => {
  assert.equal(validateEchoNoteArgs({ action: 'write', scheduleWeekdays: [1, 5] }).action, 'write')
  assert.throws(() => validateEchoNoteArgs({ action: 'unknown' }), /one of/)
  assert.throws(() => validateEchoNoteArgs({ action: 'write', extra: true }), /unsupported properties/)
  assert.throws(() => validateEchoNoteArgs({ action: 'write', scheduleWeekdays: ['1'] }), /integer/)
  assert.throws(() => validateEchoNoteArgs({ action: 'write', limit: 500 }), />=|<=/)
})

test('result validation rejects malformed nested data and unexpected fields', () => {
  assert.deepEqual(validateEchoNoteResult({ ok: true, noteCount: 1 }), { ok: true, noteCount: 1 })
  assert.throws(() => validateEchoNoteResult({ ok: 'yes' }), /boolean/)
  assert.throws(() => validateEchoNoteResult({ ok: true, surprise: 1 }), /unsupported properties/)
  assert.throws(() => validateEchoNoteResult({ ok: true, notes: 'not-array' }), /array/)
})
