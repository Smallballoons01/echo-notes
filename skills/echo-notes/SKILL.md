# Echo Notes 回声笔记

An emotion-first diary that lives inside the Harness, with the agent as a
writing partner.

## Before anything else

1. Call `echo_note` with `action: "status"`. It reports whether a vault exists,
   whether it is unlocked, and how many notes there are.
2. If the vault is locked, stop and ask the user to unlock it in the **Echo
   Notes** panel. Do not ask them to type their passphrase into the chat, and
   never look for a way to pass one to a tool — there is no such parameter, by
   design.

## Writing an entry

1. **Pick the emotion.** If the user named one ("今天有点丧"), map it to a mood
   id from `action: "templates"`. If they did not, ask one short question — do
   not interrogate.
2. **Get scaffolding** with `action: "start"`, passing `mood` or `templateId`.
   `i-daily` suits an inward, quiet entry; `e-daily` suits an outward, talkative
   one; each mood has its own template.
3. **Write in the user's own voice and language.** This is a diary, not a
   report: keep first person, keep their phrasing, and do not add a summary, a
   moral, or unsolicited advice.
4. **Save** with `action: "write"`, passing the body, the `mood`, and any
   `tags`.
5. **Reply in one short sentence.** Do not paste the note back — the user just
   wrote it.

Keep a typical entry to 2–6 sentences. An entry that is too long is one the user
will not keep writing.

## Reviewing

- `action: "list"` with `from`/`to` (epoch ms) for a window, or `moods`/`tags`
  to slice by feeling.
- `action: "search"` for a phrase. Search runs against decrypted bodies, so it
  only works while the vault is unlocked.
- `action: "stats"` for counts by mood, day and tag plus the writing streak.
  Use it when the user asks "how have I been lately".

Report patterns you actually observe. Do not diagnose, and do not treat a
cluster of low moods as a clinical signal — describe what is there and let the
user decide what it means.

## Reminders

Use `action: "reminders"` with `reminderTitle` and a schedule:

| Kind | Example |
|---|---|
| daily | `scheduleKind: "daily", at: "21:30"` |
| weekly | `scheduleKind: "weekly", at: "09:00", scheduleWeekdays: [1, 5]` (1=Mon) |
| interval | `scheduleKind: "interval", everyMinutes: 45` |
| once | `scheduleKind: "once", at: "<ISO timestamp>"` |

When a reminder fires it wakes you with a prompt. Write the entry then,
following the same rules above.

A missed reminder is skipped rather than replayed, so opening the app after a
holiday does not produce a wall of nudges.

## Privacy

Note bodies are the user's private material:

- Quote them only when the user asks about that note.
- Never copy diary text into another tool call — a file, a web request, a
  message to another agent — without being asked.
- The list summary is stored in plaintext so the panel can render without
  unlocking; the body is not. Treat the summary as visible too.
