# Echo Notes 回声笔记

An emotion-first diary for DeepSeek Harness, with the agent as a writing
partner: emotion/persona templates, chronological and mood browsing, optional
passphrase encryption, and scheduled writing prompts.

The native panel and `echo_note` Agent tool run in DeepSeek Harness. The same
portable JSON Schema tool contract is documented below for adapters in other
Agent hosts; host-side capabilities such as reminders and storage require the
Harness runtime or an adapter.

---

## What it does

| | |
|---|---|
| **Emotion templates** | i 人 / e 人, plus one per mood (开心、伤心、焦虑、疲惫…) and a blank free-write. Author your own and shadow a built-in without editing code. |
| **Browsing** | By time window, by mood, by tag, by template, and full-text search. Aggregates by mood/day/tag plus a writing streak. |
| **Encryption** | AES-256-GCM, key derived from your passphrase with `scrypt`, per-note random IV, note id bound in as AAD. Off until you create a vault. |
| **Reminders** | Daily, weekly, interval, or one-shot. When one fires the agent is woken with a prompt and writes the entry. |
| **Agent access** | One `echo_note` tool (9 actions) plus an `echo-notes` skill carrying the writing guidance. |
| **Auto-lock** | Optionally drops the key from memory after an idle period. |

## Agent compatibility

| Surface | Compatibility | Requirements |
|---|---|---|
| DeepSeek Harness native Agent tool | Native `echo_note` tool with standard JSON Schema arguments/output | Plugin enabled in Harness |
| MCP-capable Agent clients | `echo_note` via included stdio MCP adapter | Harness running locally; set `ECHO_NOTES_API_URL` |
| Claude Desktop / Cursor / Continue | MCP stdio transport, subject to each client’s config support | Node.js 20+, client-specific MCP setup |
| Direct REST callers | Local JSON API under `/echo-notes/api` | Loopback Host; POSTs must be same-origin or omit Origin |
| Agents without MCP or custom tools | Not directly supported | Use an MCP bridge or the client’s tool-adapter feature |

This is interoperability through shared schemas and adapters, not a claim that
one plugin binary runs unmodified inside every Agent product. The Harness owns
the vault, encryption key, reminders, and persistence; external MCP clients
forward to that running service and cannot unlock it with a tool call.

## Installation

### DeepSeek Harness (development link)

From a local DSH session, install this directory as a bundle using the Plugin
Manager and the absolute path to this checkout. The bundle registers one Host
row and a Client panel; after activation, open **回声笔记** from the sidebar and
create a vault.

### DeepSeek Harness (published release)

After the project is pushed to GitHub and the `repository`, `homepage`, and
`bugs` fields in `package.json` are updated, publish a tagged GitHub release or
npm package according to the chosen distribution. Install the release package
through DSH Plugin Manager. Do not publish while the `REPLACE_WITH_OWNER`
placeholders remain. See [RELEASING.md](RELEASING.md) for the checklist.

### Other Agent hosts

Other MCP-capable agents can use the portable MCP adapter in `mcp/` against the
same Echo Notes data service when configured. The UI, local storage domain,
reminder scheduler, and passphrase lifecycle are Harness-owned; another host
must provide an adapter/storage service and must not share the raw data directory
while the Harness process is running. See [Agent compatibility](#agent-compatibility).

## Using it

1. **Create a vault.** Pick a passphrase. It is stretched into a key-encryption
   key; only a wrapped data key is stored, so changing the passphrase later never
   rewrites a single note.
2. **Write.** Choose a mood chip, then optionally a template. Templates drop
   prompt headings into the editor — answer the ones you feel like and delete the
   rest.
3. **Ask the agent.** "帮我写今天的日记，今天有点累" is enough. It calls `status`
   first, picks the matching template, writes in your voice, and confirms in one
   line.
4. **Review.** Filter the list by text or mood, or open **设置** for the
   mood/day chart and totals.

### Reminder schedules

```yaml
daily:    { kind: daily,    at: "21:30" }
weekly:   { kind: weekly,   at: "09:00", weekdays: [1, 5] }   # 1 = Monday
interval: { kind: interval, everyMinutes: 45 }
once:     { kind: once,     at: "2026-10-09T09:00:00+08:00" }
```

A reminder that comes due while the machine is asleep is **skipped, not
replayed** — opening the app after a holiday will not produce a wall of nudges.
The grace window is 10 minutes.

## Configuration

Edit this bundle's row in `cordis.patch.yml` (or the plugin's settings page):

| Key | Default | Meaning |
|---|---|---|
| `autoLockMinutes` | `0` | Drop the key after this much idle time. `0` disables auto-lock. |
| `defaultReminder` | `"21:30"` | Time used by a reminder created without one. |
| `encryptByDefault` | `true` | Encrypt bodies as soon as a vault exists. |
| `tickSeconds` | `30` | How often the reminder/auto-lock loop runs. |

## How it is built

```
index.js          Host half: vault, tools, skill, reminder loop, HTTP API
client.js         Client half: the panel (plain JS, React from the module table)
src/crypto.js     scrypt + AES-256-GCM, no dependencies
src/store.js      note index, filtering, revisions, encryption migration
src/templates.js  the emotion templates and their rendering
src/reminders.js  pure schedule maths (next fire, catch-up policy)
skills/echo-notes/SKILL.md   agent-facing workflow
test/             unit, integration, MCP protocol and render tests
```

Three decisions worth knowing about:

**One action dispatcher, multiple adapters.** The Harness tool and HTTP routes
call the same `runToolAction`/`operations` logic. The MCP adapter forwards the
same `echo_note` JSON Schema/action request to `/tool`; it does not implement a
second data store or business-logic copy. Integration tests exercise each
adapter surface.

**The Client calls the Host over HTTP, not a Remote namespace.** This bundle is
plain JavaScript with no code-generation step. `ctx.webServer.register` gives
the panel a same-origin transport; loopback Host and Origin checks limit browser
requests. MCP stdio is intended for local clients connecting to a running Harness.
Do not expose the HTTP endpoint publicly or proxy it without adding real
authentication and TLS.

**Metadata is plaintext; note bodies and revisions are encrypted.** The stored
index still includes title, mood, tags, timestamps, word count and pin state so
filtering works without decrypting every note. The 40-character preview is
cleared after encryption is enabled. These metadata fields can still reveal
private information; treat the storage directory accordingly.

## Development and tests

```sh
pnpm install
pnpm check
pnpm test
```

The Node built-in test suite covers encryption and tamper detection, storage and
migration, reminders, HTTP and native-tool operations, standard JSON Schema
portability, MCP stdio JSON-RPC, and Client view rendering. The profile install
uses DSH-owned package peers; local development uses the exact peer versions
listed in the lockfile. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidance.

## Limitations

- **Metadata remains plaintext.** Titles, mood, tags, timestamps, word counts
  and pin state are stored unencrypted for indexing and filtering. The plaintext
  body preview is removed when encryption is enabled. Anyone who can read the
  storage backend can still infer patterns from metadata.
- **Authenticated encryption does not prevent rollback or deletion.** AES-GCM
  detects ciphertext tampering and moving ciphertext between note/revision ids.
  Anyone with write access to the storage backend can still delete notes or
  restore an older valid database snapshot. Back up the storage backend safely.
- **A forgotten passphrase is unrecoverable.** That is what the encryption is for.
  There is no recovery key and no escrow.
- **Auto-lock is coarse.** It is checked on the tick loop, so the lock lands
  within one `tickSeconds` of the deadline, not exactly on it.
- **Reminders need a live Harness.** They are Host timers, not OS-level
  notifications; a closed app fires nothing, and the missed occurrence is
  skipped.
- **Search requires an unlocked vault.** Matching happens against decrypted
  bodies in memory, so a locked vault can list metadata but cannot search text.
- **Verified without a browser.** The panel's slots, registration and rendering
  are covered by tests that execute the real component bodies, and the theme
  tokens are checked mechanically. Visual appearance in the running Web UI has
  not been confirmed by eye in this environment.

## Storage schema

The `echo_notes` domain stores three tables (`notes`, `revisions`, `settings`)
with deliberately permissive schemas. The record shape grows while the diary is
in use — a strict schema would turn every added field into a migration — so the
invariants that matter are enforced by `NoteStore` and covered by tests instead.
