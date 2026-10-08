/**
 * Reminder scheduling for Echo Notes.
 *
 * The Host half owns the actual timers; this module owns only the *decision* of
 * when the next nudge is due, expressed as pure functions over a reminder
 * record and a clock. Keeping it pure is what makes "does a daily 22:00
 * reminder survive a laptop sleeping for two days" testable without waiting.
 *
 * A reminder is:
 *   { id, title, prompt, templateId, mood, schedule: Schedule, enabled, lastFiredAt? }
 *
 * where Schedule is one of:
 *   { kind: 'daily',    at: 'HH:MM' }
 *   { kind: 'weekly',   at: 'HH:MM', weekdays: [1..7] }   ISO weekdays, Mon=1
 *   { kind: 'interval', everyMinutes: 30..10080 }
 *   { kind: 'once',     at: '<ISO timestamp>' }
 *
 * **Catch-up policy.** When the machine was asleep or the app was closed, a
 * due reminder is *not* replayed N times. Every schedule kind fires at most
 * once per due instant, and a stale instant older than `gracePeriodMs` is
 * skipped forward to the next future instant. Otherwise opening the app after
 * a holiday would produce a wall of missed reminders.
 *
 * @module echo-notes/reminders
 */

/** How stale a due instant may be and still fire late. Ten minutes. */
export const DEFAULT_GRACE_MS = 10 * 60 * 1000

/** Guard rails so a user cannot ask for a reminder every second. */
export const MIN_INTERVAL_MINUTES = 5
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60

/**
 * Parse `HH:MM` into minutes past local midnight.
 * @param {string} value
 * @returns {number | undefined}
 */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/**
 * Validate a schedule, returning a list of human-readable problems.
 * An empty list means the schedule is usable.
 * @param {any} schedule
 * @returns {string[]}
 */
export function validateSchedule(schedule) {
  const problems = []
  if (!schedule || typeof schedule !== 'object') return ['schedule must be an object']

  switch (schedule.kind) {
    case 'daily':
      if (parseClock(schedule.at) === undefined) problems.push("daily schedule needs at: 'HH:MM'")
      break
    case 'weekly': {
      if (parseClock(schedule.at) === undefined) problems.push("weekly schedule needs at: 'HH:MM'")
      const weekdays = schedule.weekdays
      if (!Array.isArray(weekdays) || weekdays.length === 0) {
        problems.push('weekly schedule needs at least one weekday (1=Mon … 7=Sun)')
      } else if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
        problems.push('weekdays must be integers 1..7')
      }
      break
    }
    case 'interval': {
      const every = Number(schedule.everyMinutes)
      if (!Number.isFinite(every)) problems.push('interval schedule needs everyMinutes')
      else if (every < MIN_INTERVAL_MINUTES || every > MAX_INTERVAL_MINUTES) {
        problems.push(`everyMinutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`)
      }
      break
    }
    case 'once':
      if (Number.isNaN(Date.parse(schedule.at))) problems.push("once schedule needs a parseable ISO 'at'")
      break
    default:
      problems.push(`unknown schedule kind ${JSON.stringify(schedule.kind)}`)
  }
  return problems
}

/**
 * Build a Date for a given local day at `HH:MM` without mutating the input.
 * @param {Date} day
 * @param {number} minutesPastMidnight
 * @returns {Date}
 */
function atMinutes(day, minutesPastMidnight) {
  const result = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0)
  result.setMinutes(minutesPastMidnight)
  return result
}

/**
 * ISO weekday (Mon=1 … Sun=7) for a local date.
 * @param {Date} date
 * @returns {number}
 */
function isoWeekday(date) {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

/**
 * Compute the next instant a reminder should fire, strictly after `now`.
 *
 * @param {any} reminder
 * @param {Date} now
 * @returns {Date | undefined} `undefined` when the reminder is disabled or finished.
 */
export function nextFireAt(reminder, now) {
  if (!reminder || reminder.enabled === false) return undefined
  const schedule = reminder.schedule
  if (validateSchedule(schedule).length > 0) return undefined

  switch (schedule.kind) {
    case 'once': {
      const at = new Date(schedule.at)
      return at.getTime() > now.getTime() ? at : undefined
    }

    case 'daily': {
      const minutes = /** @type {number} */ (parseClock(schedule.at))
      const today = atMinutes(now, minutes)
      if (today.getTime() > now.getTime()) return today
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      return tomorrow
    }

    case 'weekly': {
      const minutes = /** @type {number} */ (parseClock(schedule.at))
      const weekdays = [...new Set(schedule.weekdays)].sort((a, b) => a - b)
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = atMinutes(now, minutes)
        candidate.setDate(candidate.getDate() + offset)
        if (!weekdays.includes(isoWeekday(candidate))) continue
        if (candidate.getTime() > now.getTime()) return candidate
      }
      return undefined
    }

    case 'interval': {
      const every = Number(schedule.everyMinutes)
      const base = reminder.lastFiredAt ? Date.parse(reminder.lastFiredAt) : Number.NaN
      if (Number.isNaN(base)) return new Date(now.getTime() + every * 60_000)
      // A fixed-rate cadence aligned to the last fire, skipped forward past any
      // missed occurrences so a sleeping machine does not queue up a burst.
      const elapsed = now.getTime() - base
      const periods = Math.floor(elapsed / (every * 60_000)) + 1
      return new Date(base + periods * every * 60_000)
    }

    default:
      return undefined
  }
}

/**
 * Decide what a reminder should do right now.
 *
 * @param {any} reminder
 * @param {Date} now
 * @param {number} [graceMs] how late a fire may be and still count as "due now".
 * @returns {{ action: 'fire', dueAt: Date } | { action: 'wait', dueAt: Date } | { action: 'none' }}
 */
export function dueAction(reminder, now, graceMs = DEFAULT_GRACE_MS) {
  if (!reminder || reminder.enabled === false) return { action: 'none' }
  const schedule = reminder.schedule
  if (validateSchedule(schedule).length > 0) return { action: 'none' }

  if (schedule.kind === 'once') {
    const at = new Date(schedule.at)
    const delta = now.getTime() - at.getTime()
    if (delta >= 0 && delta <= graceMs) return { action: 'fire', dueAt: at }
    if (delta < 0) return { action: 'wait', dueAt: at }
    return { action: 'none' } // a missed one-shot is not replayed
  }

  // For repeating schedules, find the most recent scheduled instant at or
  // before now, and fire only when it is inside the grace window.
  const previous = previousFireAt(reminder, now)
  if (previous === undefined) {
    const next = nextFireAt(reminder, now)
    return next ? { action: 'wait', dueAt: next } : { action: 'none' }
  }
  const delta = now.getTime() - previous.getTime()
  if (delta >= 0 && delta <= graceMs) return { action: 'fire', dueAt: previous }
  const next = nextFireAt(reminder, now)
  return next ? { action: 'wait', dueAt: next } : { action: 'none' }
}

/**
 * The most recent instant this repeating reminder *should* have fired at or
 * before `now`, or `undefined` when it has never come due yet.
 * @param {any} reminder
 * @param {Date} now
 * @returns {Date | undefined}
 */
export function previousFireAt(reminder, now) {
  const schedule = reminder.schedule
  switch (schedule.kind) {
    case 'daily': {
      const minutes = /** @type {number} */ (parseClock(schedule.at))
      const today = atMinutes(now, minutes)
      if (today.getTime() <= now.getTime()) return today
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)
      return yesterday
    }
    case 'weekly': {
      const minutes = /** @type {number} */ (parseClock(schedule.at))
      const weekdays = [...new Set(schedule.weekdays)].sort((a, b) => a - b)
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = atMinutes(now, minutes)
        candidate.setDate(candidate.getDate() - offset)
        if (!weekdays.includes(isoWeekday(candidate))) continue
        if (candidate.getTime() <= now.getTime()) return candidate
      }
      return undefined
    }
    case 'interval': {
      const every = Number(schedule.everyMinutes)
      const base = reminder.lastFiredAt ? Date.parse(reminder.lastFiredAt) : Number.NaN
      if (Number.isNaN(base)) return undefined
      if (base > now.getTime()) return undefined
      const periods = Math.floor((now.getTime() - base) / (every * 60_000))
      return new Date(base + periods * every * 60_000)
    }
    default:
      return undefined
  }
}

/**
 * Describe a schedule in one short human line, for the UI and tool output.
 * @param {any} schedule
 * @param {(zh: string, en: string) => string} [pick] locale picker; defaults to Chinese.
 * @returns {string}
 */
export function describeSchedule(schedule, pick = (zh) => zh) {
  if (validateSchedule(schedule).length > 0) return pick('无效的提醒设置', 'invalid schedule')
  switch (schedule.kind) {
    case 'daily':
      return pick(`每天 ${schedule.at}`, `every day at ${schedule.at}`)
    case 'weekly': {
      const names = schedule.weekdays.map((day) => ['一', '二', '三', '四', '五', '六', '日'][day - 1])
      return pick(`每周${names.join('、')} ${schedule.at}`, `weekly on ${schedule.weekdays.join(',')} at ${schedule.at}`)
    }
    case 'interval':
      return pick(`每 ${schedule.everyMinutes} 分钟`, `every ${schedule.everyMinutes} minutes`)
    case 'once':
      return pick(`${schedule.at} 提醒一次`, `once at ${schedule.at}`)
    default:
      return ''
  }
}
