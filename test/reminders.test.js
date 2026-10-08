/**
 * Tests for reminder scheduling: the catch-up policy is the whole point, so
 * most cases simulate a machine that was asleep.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GRACE_MS,
  describeSchedule,
  dueAction,
  nextFireAt,
  parseClock,
  validateSchedule,
} from '../src/reminders.js'

/** Local date helper: `d(2026, 3, 10, 21, 55)` → 2026-03-10T21:55 local. */
function d(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

test('parseClock accepts 24-hour times and rejects nonsense', () => {
  assert.equal(parseClock('00:00'), 0)
  assert.equal(parseClock('9:05'), 9 * 60 + 5)
  assert.equal(parseClock('23:59'), 23 * 60 + 59)
  for (const bad of ['24:00', '12:60', '1200', '', 'noon', null]) {
    assert.equal(parseClock(bad), undefined)
  }
})

test('validateSchedule rejects out-of-range and malformed schedules', () => {
  assert.deepEqual(validateSchedule({ kind: 'daily', at: '22:00' }), [])
  assert.deepEqual(validateSchedule({ kind: 'weekly', at: '09:00', weekdays: [1, 3] }), [])
  assert.deepEqual(validateSchedule({ kind: 'interval', everyMinutes: 45 }), [])
  assert.deepEqual(validateSchedule({ kind: 'once', at: '2026-03-10T21:00:00+08:00' }), [])

  assert.ok(validateSchedule({ kind: 'daily', at: '25:00' }).length > 0)
  assert.ok(validateSchedule({ kind: 'weekly', at: '09:00', weekdays: [] }).length > 0)
  assert.ok(validateSchedule({ kind: 'weekly', at: '09:00', weekdays: [0] }).length > 0)
  assert.ok(validateSchedule({ kind: 'interval', everyMinutes: 1 }).length > 0)
  assert.ok(validateSchedule({ kind: 'every-second' }).length > 0)
  assert.ok(validateSchedule(null).length > 0)
})

test('daily reminder fires later today when the time has not passed', () => {
  const reminder = { enabled: true, schedule: { kind: 'daily', at: '22:00' } }
  const next = nextFireAt(reminder, d(2026, 3, 10, 21, 0))
  assert.equal(next.getDate(), 10)
  assert.equal(next.getHours(), 22)
})

test('daily reminder rolls to tomorrow once the time has passed', () => {
  const reminder = { enabled: true, schedule: { kind: 'daily', at: '22:00' } }
  const next = nextFireAt(reminder, d(2026, 3, 10, 23, 0))
  assert.equal(next.getDate(), 11)
  assert.equal(next.getHours(), 22)
})

test('daily reminder fires when due within the grace window', () => {
  const reminder = { enabled: true, schedule: { kind: 'daily', at: '22:00' } }
  const decision = dueAction(reminder, d(2026, 3, 10, 22, 5))
  assert.equal(decision.action, 'fire')
})

test('a daily reminder missed by a sleeping machine is skipped, not replayed', () => {
  // The machine slept through 22:00 and woke at 06:30 two days later.
  const reminder = { enabled: true, schedule: { kind: 'daily', at: '22:00' } }
  const decision = dueAction(reminder, d(2026, 3, 12, 6, 30))
  assert.equal(decision.action, 'wait', 'a long-missed daily reminder must not fire late')
  assert.equal(decision.dueAt.getDate(), 12)
  assert.equal(decision.dueAt.getHours(), 22)
})

test('weekly reminder lands on the next requested weekday', () => {
  // 2026-03-10 is a Tuesday (ISO 2). Ask for Monday(1) and Friday(5).
  const reminder = { enabled: true, schedule: { kind: 'weekly', at: '09:00', weekdays: [1, 5] } }
  const next = nextFireAt(reminder, d(2026, 3, 10, 10, 0))
  assert.equal(next.getDay(), 5, 'after Tuesday 09:00 the next slot is Friday')
  assert.equal(next.getHours(), 9)
})

test('weekly reminder can fire later the same day', () => {
  const reminder = { enabled: true, schedule: { kind: 'weekly', at: '18:00', weekdays: [2] } }
  const next = nextFireAt(reminder, d(2026, 3, 10, 9, 0)) // Tuesday morning
  assert.equal(next.getDate(), 10)
  assert.equal(next.getHours(), 18)
})

test('interval reminder waits one period before its first fire', () => {
  const reminder = { enabled: true, schedule: { kind: 'interval', everyMinutes: 30 } }
  const next = nextFireAt(reminder, d(2026, 3, 10, 9, 0))
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 30)
})

test('interval reminder skips missed periods instead of firing a burst', () => {
  const reminder = {
    enabled: true,
    lastFiredAt: d(2026, 3, 10, 9, 0).toISOString(),
    schedule: { kind: 'interval', everyMinutes: 30 },
  }
  // Six hours later: twelve periods were missed, the next fire is the next slot.
  const next = nextFireAt(reminder, d(2026, 3, 10, 15, 0))
  assert.equal(next.getHours(), 15)
  assert.equal(next.getMinutes(), 30)
})

test('a disabled reminder never fires and has no next instant', () => {
  const reminder = { enabled: false, schedule: { kind: 'daily', at: '09:00' } }
  assert.deepEqual(dueAction(reminder, d(2026, 3, 10, 9, 0)), { action: 'none' })
  assert.equal(nextFireAt(reminder, d(2026, 3, 10, 9, 0)), undefined)
})

test('a one-shot reminder fires once and then reports none', () => {
  const reminder = { enabled: true, schedule: { kind: 'once', at: d(2026, 3, 10, 12, 0).toISOString() } }
  assert.equal(dueAction(reminder, d(2026, 3, 10, 11, 59)).action, 'wait')
  assert.equal(dueAction(reminder, d(2026, 3, 10, 12, 2)).action, 'fire')
  assert.equal(dueAction(reminder, d(2026, 3, 10, 18, 0)).action, 'none', 'a stale one-shot is not replayed')
})

test('an invalid schedule is inert rather than throwing', () => {
  assert.deepEqual(dueAction({ enabled: true, schedule: { kind: 'daily', at: '99:99' } }, new Date()), { action: 'none' })
  assert.equal(nextFireAt({ enabled: true, schedule: { kind: 'daily', at: '99:99' } }, new Date()), undefined)
})

test('grace window boundary is inclusive', () => {
  const reminder = { enabled: true, schedule: { kind: 'daily', at: '22:00' } }
  const exactly = new Date(d(2026, 3, 10, 22, 0).getTime() + DEFAULT_GRACE_MS)
  assert.equal(dueAction(reminder, exactly).action, 'fire')
  const beyond = new Date(exactly.getTime() + 60_000)
  assert.equal(dueAction(reminder, beyond).action, 'wait')
})

test('describeSchedule renders a readable line per kind', () => {
  assert.equal(describeSchedule({ kind: 'daily', at: '22:00' }), '每天 22:00')
  assert.equal(describeSchedule({ kind: 'interval', everyMinutes: 45 }), '每 45 分钟')
  assert.match(describeSchedule({ kind: 'weekly', at: '09:00', weekdays: [1, 5] }), /每周一、五 09:00/)
  assert.match(describeSchedule({ kind: 'daily', at: '99:99' }), /无效/)
})
