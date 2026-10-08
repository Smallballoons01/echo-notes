/**
 * Echo Notes 回声笔记 — Client half.
 *
 * A global panel (selected from the sidebar) with three views: the diary list,
 * the editor, and settings. It is deliberately dependency-free plain
 * JavaScript — React comes from the browser module table — and reads its data
 * from the Host half's HTTP API rather than a generated Remote namespace, so
 * this bundle needs no code-generation step.
 *
 * Styling uses only `--dsw-alias-*` theme tokens (plus `color-mix` over them),
 * so the panel follows the host's light/dark theme without its own palette.
 *
 * @module @dsh-plugin/echo-notes/client
 */

window.__ModuleLoader__.load({
  id: '@dsh-plugin/echo-notes',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The `main` slot key and the sidebar entry id must agree. */
    const PANEL_ID = 'echo-notes'

    /** Host API base, relative to the page origin. */
    const API = '/echo-notes/api'

    /* ---------------------------------------------------------------------- */
    /* Host API binding                                                        */
    /* ---------------------------------------------------------------------- */

    /**
     * Call the Host half.
     *
     * Every failure is surfaced as a thrown `EchoApiError` carrying the Host's
     * stable code, so the UI can distinguish "locked" from "wrong passphrase"
     * from a genuine fault without string matching.
     *
     * @param {string} route e.g. 'notes/list'
     * @param {object} [body]
     * @returns {Promise<any>}
     */
    async function call(route, body) {
      const response = await fetch(`${API}/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new EchoApiError('bad-response', `Echo Notes returned a non-JSON response (${response.status})`)
      }
      if (!payload.ok) {
        throw new EchoApiError(payload.error ?? 'unknown', payload.message ?? 'Echo Notes request failed')
      }
      return payload.value
    }

    /** A Host-reported failure with a stable code. */
    class EchoApiError extends Error {
      constructor(code, message) {
        super(message)
        this.name = 'EchoApiError'
        this.code = code
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Styles                                                                  */
    /* ---------------------------------------------------------------------- */

    /**
     * The panel's stylesheet, rendered as an element so unmounting removes it.
     *
     * Class names are prefixed `en-` to avoid colliding with host rules, and
     * every colour is a theme token or a `color-mix` of one.
     */
    function Styles() {
      return h('style', {
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML: { __html: CSS },
      })
    }

    const CSS = `
.en-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-text-primary);font-size:14px}
.en-toolbar{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-secondary);flex:0 0 auto}
.en-title{font-size:15px;font-weight:600;margin-right:auto}
.en-btn{appearance:none;border:1px solid var(--dsw-alias-border-secondary);background:var(--dsw-alias-bg-elevated);color:var(--dsw-alias-text-primary);border-radius:6px;padding:5px 10px;font:inherit;font-size:13px;cursor:pointer;line-height:1.4}
.en-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover)}
.en-btn:disabled{opacity:.5;cursor:not-allowed}
.en-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-text-on-brand)}
.en-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary-hover)}
.en-btn-danger{color:var(--dsw-alias-text-danger);border-color:var(--dsw-alias-border-danger)}
.en-body{flex:1 1 auto;min-height:0;display:flex;overflow:hidden}
.en-list{width:280px;flex:0 0 auto;border-right:1px solid var(--dsw-alias-border-secondary);overflow-y:auto}
.en-main{flex:1 1 auto;overflow-y:auto;padding:16px;min-width:0}
.en-item{display:block;width:100%;text-align:left;appearance:none;border:0;border-bottom:1px solid var(--dsw-alias-border-secondary);background:transparent;color:inherit;font:inherit;padding:10px 14px;cursor:pointer}
.en-item:hover{background:var(--dsw-alias-bg-hover)}
.en-item[data-active="true"]{background:var(--dsw-alias-bg-selected)}
.en-item-title{display:flex;align-items:center;gap:6px;font-weight:500;margin-bottom:2px}
.en-item-meta{font-size:12px;color:var(--dsw-alias-text-secondary);display:flex;gap:8px;flex-wrap:wrap}
.en-empty{padding:32px 16px;color:var(--dsw-alias-text-secondary);text-align:center;line-height:1.7}
.en-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.en-label{font-size:12px;color:var(--dsw-alias-text-secondary)}
.en-input,.en-textarea,.en-select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-secondary);border-radius:6px;background:var(--dsw-alias-bg-input);color:var(--dsw-alias-text-primary);padding:8px 10px;font:inherit}
.en-textarea{min-height:280px;resize:vertical;line-height:1.7;font-family:inherit}
.en-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.en-row>*{flex:0 0 auto}
.en-grow{flex:1 1 auto;min-width:120px}
.en-chips{display:flex;gap:6px;flex-wrap:wrap}
.en-chip{appearance:none;border:1px solid var(--dsw-alias-border-secondary);background:var(--dsw-alias-bg-elevated);color:inherit;border-radius:999px;padding:4px 11px;font:inherit;font-size:13px;cursor:pointer}
.en-chip[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-text-on-brand)}
.en-tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-elevated);border:1px solid var(--dsw-alias-border-secondary);color:var(--dsw-alias-text-secondary)}
.en-error{padding:8px 12px;border-radius:6px;background:var(--dsw-alias-bg-danger);color:var(--dsw-alias-text-danger);margin-bottom:12px;font-size:13px}
.en-card{border:1px solid var(--dsw-alias-border-secondary);border-radius:8px;padding:14px;margin-bottom:16px;background:var(--dsw-alias-bg-elevated)}
.en-card h3{margin:0 0 10px;font-size:14px}
.en-hint{font-size:12px;color:var(--dsw-alias-text-secondary);line-height:1.6;margin:0 0 12px}
.en-preview{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--dsw-alias-text-secondary);font-size:12px;line-height:1.5}
.en-bar{display:flex;gap:2px;align-items:flex-end;height:48px;margin:4px 0 14px}
.en-bar>div{flex:1;background:var(--dsw-alias-brand-primary);border-radius:2px 2px 0 0;min-height:2px;opacity:.75}
.en-stat{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:6px}
.en-stat b{display:block;font-size:20px;line-height:1.2}
.en-stat span{font-size:12px;color:var(--dsw-alias-text-secondary)}
.en-badge{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-elevated);border:1px solid var(--dsw-alias-border-secondary)}
`

    /* ---------------------------------------------------------------------- */
    /* Small building blocks                                                   */
    /* ---------------------------------------------------------------------- */

    /** A labelled form control. */
    function Field({ label, children }) {
      return h('div', { className: 'en-field' },
        h('label', { className: 'en-label' }, label),
        children)
    }

    /** A button. Variants: primary, danger. */
    function Button({ variant, ...rest }) {
      const variantClass = variant === 'primary' ? ' en-btn-primary' : variant === 'danger' ? ' en-btn-danger' : ''
      return h('button', { type: 'button', className: `en-btn${variantClass}`, ...rest })
    }

    /** The error banner, rendered only when there is an error. */
    function ErrorBanner({ error }) {
      if (!error) return null
      return h('div', { className: 'en-error', role: 'alert' }, error)
    }

    /** A local `YYYY-MM-DD HH:MM` stamp. */
    function stamp(timestamp) {
      const date = new Date(timestamp)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /* ---------------------------------------------------------------------- */
    /* Views                                                                   */
    /* ---------------------------------------------------------------------- */

    /**
     * The vault gate shown while no vault exists or the vault is locked.
     *
     * The passphrase is held only in this component's local state for the
     * duration of the submit, and is never written anywhere else.
     */
    function VaultGate({ status, onChanged, onError }) {
      const [passphrase, setPassphrase] = React.useState('')
      const [confirm, setConfirm] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const creating = !status.hasVault

      async function submit(event) {
        event.preventDefault()
        if (creating && passphrase !== confirm) return onError('两次输入的密码不一致')
        if (passphrase.length < 4) return onError('密码至少 4 位')
        setBusy(true)
        try {
          await call(creating ? 'vault/create' : 'vault/unlock', { passphrase })
          setPassphrase('')
          setConfirm('')
          onError(null)
          onChanged()
        } catch (error) {
          onError(error.message)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'en-main' },
        h('div', { className: 'en-card', style: { maxWidth: 460, margin: '40px auto' } },
          h('h3', null, creating ? '创建你的笔记库' : '笔记库已锁定'),
          h('p', { className: 'en-hint' },
            creating
              ? '设置一个密码。笔记内容会用 AES-256-GCM 加密后存储在本地，密码不会以明文保存——忘记了就无法恢复内容。'
              : '输入密码解锁。密码只保存在内存里，锁定后不会留在磁盘上。'),
          ErrorBanner({ error: null }),
          h('form', { onSubmit: submit },
            h(Field, { label: '密码' },
              h('input', {
                className: 'en-input', type: 'password', value: passphrase, autoFocus: true,
                autoComplete: creating ? 'new-password' : 'current-password',
                onChange: (event) => setPassphrase(event.target.value),
              })),
            creating && h(Field, { label: '确认密码' },
              h('input', {
                className: 'en-input', type: 'password', value: confirm,
                autoComplete: 'new-password',
                onChange: (event) => setConfirm(event.target.value),
              })),
            h('div', { className: 'en-row' },
              h(Button, { variant: 'primary', type: 'submit', disabled: busy },
                busy ? '处理中…' : creating ? '创建并解锁' : '解锁')),
          ),
        ))
    }

    /** The diary list with the emotion and time filters. */
    function NoteList({ notes, activeId, filters, onFilters, onOpen, onNew }) {
      // `filters` is defaulted rather than assumed: the panel always passes it,
      // but a missing value must not blank the slot.
      const query = filters?.text ?? ''
      const items = notes ?? []
      return h('div', { className: 'en-list' },
        h('div', { style: { padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-secondary)' } },
          h('input', {
            className: 'en-input', placeholder: '搜索笔记…', value: query,
            onChange: (event) => onFilters({ ...filters, text: event.target.value }),
          }),
          h('div', { className: 'en-chips', style: { marginTop: 8 } },
            h('button', { type: 'button', className: 'en-chip', onClick: onNew }, '+ 写一篇')),
        ),
        items.length === 0
          ? h('div', { className: 'en-empty' }, '还没有笔记。\n写一句也算。')
          : items.map((note) => h('button', {
              key: note.id, type: 'button', className: 'en-item',
              'data-active': String(note.id === activeId),
              onClick: () => onOpen(note.id),
            },
            h('div', { className: 'en-item-title' },
              h('span', null, note.mood ? moodEmoji(note.mood) : '📄'),
              h('span', null, note.title || '（无标题）'),
            ),
            note.preview ? h('div', { className: 'en-preview' }, note.preview) : null,
            h('div', { className: 'en-item-meta' },
              h('span', null, stamp(note.createdAt)),
              h('span', null, `${note.wordCount} 字`),
              ...note.tags.slice(0, 3).map((tag) => h('span', { className: 'en-tag', key: tag }, tag)),
            ),
          )),
      )
    }

    /** Emoji for a mood id, falling back to a neutral marker. */
    function moodEmoji(id) {
      const table = {
        joy: '😊', excited: '🤩', grateful: '🥰', calm: '😌',
        tired: '😮‍💨', anxious: '😰', sad: '😢', angry: '😤', neutral: '😐',
      }
      return table[id] ?? '📄'
    }

    /**
     * The editor: body, mood, tags, template starter and history.
     *
     * The draft lives in local state and is saved explicitly, so a half-written
     * entry is never persisted by accident.
     */
    function Editor({ status, noteId, onSaved, onDeleted, onError }) {
      const [body, setBody] = React.useState('')
      const [mood, setMood] = React.useState(null)
      const [tags, setTags] = React.useState('')
      const [history, setHistory] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)
      const [templateId, setTemplateId] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        async function load() {
          if (!noteId) {
            setBody(''); setMood(null); setTags(''); setHistory([]); setTemplateId(null); setLoaded(true)
            return
          }
          try {
            const found = await call('notes/read', { id: noteId })
            if (cancelled) return
            setBody(found.body)
            setMood(found.row.mood)
            setTags(found.row.tags.join(' '))
            setHistory(found.history)
            setTemplateId(found.row.templateId)
            setLoaded(true)
          } catch (error) {
            if (!cancelled) onError(error.message)
          }
        }
        void load()
        return () => { cancelled = true }
      }, [noteId])

      /** Start from a template, replacing an empty draft only. */
      async function useTemplate(id) {
        try {
          const rendered = await call('templates/render', { id, mood })
          if (body.trim() && !window.confirm('当前草稿会被模版内容替换，继续吗？')) return
          setBody(rendered.body)
          setTemplateId(id)
          onError(null)
        } catch (error) {
          onError(error.message)
        }
      }

      async function save() {
        if (!body.trim()) return onError('写点什么再保存吧')
        setBusy(true)
        try {
          const result = await call('notes/write', {
            id: noteId ?? undefined,
            body,
            mood,
            tags: tags.split(/[\s,，]+/).filter(Boolean),
            templateId,
          })
          onError(null)
          onSaved(result.note.id)
        } catch (error) {
          onError(error.message)
        } finally {
          setBusy(false)
        }
      }

      async function remove() {
        if (!noteId || !window.confirm('删除这篇笔记？此操作不可撤销。')) return
        try {
          await call('notes/remove', { id: noteId })
          onDeleted()
        } catch (error) {
          onError(error.message)
        }
      }

      if (!loaded) return h('div', { className: 'en-main' }, h('div', { className: 'en-empty' }, '载入中…'))

      return h('div', { className: 'en-main' },
        h('div', { className: 'en-row', style: { marginBottom: 14 } },
          h(Button, { variant: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          noteId ? h(Button, { variant: 'danger', onClick: remove }, '删除') : null,
          h('div', { className: 'en-grow' }),
          h('span', { className: 'en-label' }, noteId ? '编辑中' : '新笔记'),
        ),

        h('div', { className: 'en-chips', style: { marginBottom: 14 } },
          ...status.moods.map((item) => h('button', {
            key: item.id, type: 'button', className: 'en-chip',
            'data-on': String(mood === item.id),
            title: item.en,
            onClick: () => setMood(mood === item.id ? null : item.id),
          }, `${item.emoji} ${item.zh}`)),
        ),

        h(Field, { label: '正文' },
          h('textarea', {
            className: 'en-textarea', value: body,
            placeholder: '今天……',
            onChange: (event) => setBody(event.target.value),
          })),

        h('div', { className: 'en-row', style: { marginBottom: 14 } },
          h('div', { className: 'en-grow' },
            h(Field, { label: '标签（空格分隔）' },
              h('input', {
                className: 'en-input', value: tags, placeholder: '工作 家人',
                onChange: (event) => setTags(event.target.value),
              }))),
        ),

        h('div', { className: 'en-card' },
          h('h3', null, '用模版开始'),
          h('p', { className: 'en-hint' }, '模版会填入提问式的小标题，写完删掉不想答的即可。'),
          h('div', { className: 'en-chips' },
            ...status.templates.map((tpl) => h('button', {
              key: tpl.id, type: 'button', className: 'en-chip',
              title: tpl.description?.zh ?? '',
              onClick: () => useTemplate(tpl.id),
            }, `${tpl.persona === 'i' ? '🧘 ' : tpl.persona === 'e' ? '🎉 ' : ''}${tpl.name.zh}`)),
          ),
        ),

        history.length > 0 && h('div', { className: 'en-card' },
          h('h3', null, `历史版本（${history.length}）`),
          h('p', { className: 'en-hint' }, '每次保存都会留下上一版，避免误删。'),
          ...history.slice().reverse().map((entry) => h('div', { key: entry.seq, style: { marginBottom: 10 } },
            h('div', { className: 'en-label' }, `${stamp(entry.at)}`),
            h('div', { className: 'en-preview' }, entry.body),
          )),
        ),
      )
    }

    /** Settings: lock, passphrase, encryption state, reminders and stats. */
    function Settings({ status, onChanged, onError }) {
      const [current, setCurrent] = React.useState('')
      const [next, setNext] = React.useState('')
      const [stats, setStats] = React.useState(null)
      const [reminders, setReminders] = React.useState(status.reminders ?? [])
      const [title, setTitle] = React.useState('')
      const [at, setAt] = React.useState('21:30')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        call('notes/stats', {}).then(setStats).catch(() => {})
      }, [])

      async function run(action) {
        setBusy(true)
        try {
          await action()
          onError(null)
          onChanged()
        } catch (error) {
          onError(error.message)
        } finally {
          setBusy(false)
        }
      }

      async function addReminder(event) {
        event.preventDefault()
        if (!title.trim()) return onError('给提醒起个名字')
        await run(async () => {
          const value = await call('reminders/save', {
            reminder: {
              id: `r_${Date.now().toString(36)}`,
              title: title.trim(),
              prompt: '',
              templateId: null,
              mood: null,
              schedule: { kind: 'daily', at },
              enabled: true,
            },
          })
          setTitle('')
          setReminders((await call('reminders/list')).reminders)
          void value
        })
      }

      const streak = stats?.streakDays ?? 0
      const total = stats?.total ?? 0
      const max = Math.max(1, ...Object.values(stats?.byDay ?? {}))

      return h('div', { className: 'en-main' },
        h('div', { className: 'en-card' },
          h('h3', null, '加密'),
          h('p', { className: 'en-hint' },
            '笔记内容使用 AES-256-GCM 加密后写入本地存储，密钥由密码经 scrypt 派生。列表里显示的摘要为明文，便于不解锁时浏览。'),
          h('div', { className: 'en-row' },
            h('span', { className: 'en-badge' }, status.encrypted ? '已加密' : '未加密'),
            h(Button, { onClick: () => run(() => call('vault/lock', {})) }, '立即锁定'),
            h(Button, {
              onClick: () => {
                if (!window.confirm('关闭加密会把所有笔记改为明文保存，确定继续？')) return
                void run(() => call('vault/decryptAll', {}))
              },
            }, '关闭加密'),
          ),
        ),

        h('div', { className: 'en-card' },
          h('h3', null, '修改密码'),
          h('p', { className: 'en-hint' }, '只重新包裹密钥，不会重写任何笔记内容。'),
          h('div', { className: 'en-row' },
            h('input', {
              className: 'en-input en-grow', type: 'password', placeholder: '当前密码',
              value: current, onChange: (event) => setCurrent(event.target.value),
            }),
            h('input', {
              className: 'en-input en-grow', type: 'password', placeholder: '新密码',
              value: next, onChange: (event) => setNext(event.target.value),
            }),
            h(Button, {
              disabled: busy,
              onClick: () => run(async () => {
                await call('vault/changePassphrase', { current, next })
                setCurrent(''); setNext('')
              }),
            }, '修改'),
          ),
        ),

        h('div', { className: 'en-card' },
          h('h3', null, '定时提醒'),
          h('p', { className: 'en-hint' }, '到点后 Agent 会收到提醒，并帮你开一篇新的笔记。'),
          h('form', { className: 'en-row', onSubmit: addReminder, style: { marginBottom: 12 } },
            h('input', {
              className: 'en-input en-grow', placeholder: '例如：睡前写一句',
              value: title, onChange: (event) => setTitle(event.target.value),
            }),
            h('input', {
              className: 'en-input', type: 'time', style: { width: 120 },
              value: at, onChange: (event) => setAt(event.target.value),
            }),
            h(Button, { variant: 'primary', type: 'submit', disabled: busy }, '添加'),
          ),
          reminders.length === 0
            ? h('p', { className: 'en-hint' }, '还没有提醒。')
            : reminders.map((reminder) => h('div', {
                key: reminder.id,
                className: 'en-row',
                style: { padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-secondary)' },
              },
              h('div', { className: 'en-grow' },
                h('div', null, reminder.title),
                h('div', { className: 'en-label' }, `${reminder.human}${reminder.nextFireAt ? ` · 下次 ${stamp(Date.parse(reminder.nextFireAt))}` : ''}`)),
              h(Button, {
                onClick: () => run(async () => {
                  const value = await call('reminders/toggle', { id: reminder.id })
                  setReminders(value.reminders)
                }),
              }, reminder.enabled ? '暂停' : '启用'),
              h(Button, {
                variant: 'danger',
                onClick: () => run(async () => {
                  await call('reminders/remove', { id: reminder.id })
                  setReminders((await call('reminders/list')).reminders)
                }),
              }, '删除'),
            )),
        ),

        stats && h('div', { className: 'en-card' },
          h('h3', null, '记录情况'),
          h('div', { className: 'en-stat' },
            h('div', null, h('b', null, String(total)), h('span', null, '总篇数')),
            h('div', null, h('b', null, String(streak)), h('span', null, '连续天数')),
            h('div', null, h('b', null, String(stats.words ?? 0)), h('span', null, '总字数')),
          ),
          Object.keys(stats.byDay).length > 0 && h('div', { className: 'en-bar' },
            ...Object.entries(stats.byDay).slice(-20).map(([day, count]) =>
              h('div', { key: day, title: `${day}: ${count} 篇`, style: { height: `${Math.round((count / max) * 100)}%` } })),
          ),
          h('div', { className: 'en-chips' },
            ...Object.entries(stats.byMood).map(([id, count]) =>
              h('span', { key: id, className: 'en-chip', 'data-on': 'false' }, `${moodEmoji(id)} ${count}`)),
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------------- */
    /* Panel                                                                   */
    /* ---------------------------------------------------------------------- */

    /**
     * The panel root: loads status once, then routes between the gate, the
     * list-and-editor and settings.
     */
    function EchoNotesPanel() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [view, setView] = React.useState('notes')
      const [activeId, setActiveId] = React.useState(null)
      const [notes, setNotes] = React.useState([])
      const [filters, setFilters] = React.useState({ text: '' })

      /** Reload status and the note list together, so they never disagree. */
      const refresh = React.useCallback(async () => {
        try {
          const next = await call('status')
          setStatus(next)
          if (next.unlocked) {
            const listed = await call('notes/list', { limit: 200 })
            setNotes(listed.notes)
          } else {
            setNotes([])
          }
          setError(null)
        } catch (caught) {
          setError(caught.message)
        }
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      // Filtering is done in the browser: the whole list is already loaded, and
      // a round trip per keystroke would make search feel broken.
      const visible = React.useMemo(() => {
        const needle = (filters?.text ?? '').trim().toLowerCase()
        if (!needle) return notes
        return notes.filter((note) =>
          note.title.toLowerCase().includes(needle)
          || note.preview.toLowerCase().includes(needle)
          || note.tags.some((tag) => tag.toLowerCase().includes(needle)))
      }, [notes, filters?.text])

      if (!status) {
        return h(React.Fragment, null, h(Styles), h('div', { className: 'en-root' },
          h('div', { className: 'en-empty' }, error ?? '载入中…')))
      }

      const header = h('div', { className: 'en-toolbar' },
        h('span', { className: 'en-title' }, '回声笔记'),
        status.unlocked
          ? h(React.Fragment, null,
              h(Button, { 'data-on': String(view === 'notes'), onClick: () => setView('notes') }, '笔记'),
              h(Button, { onClick: () => setView('settings') }, '设置'),
              h(Button, { onClick: () => { setActiveId(null); setView('notes') } }, '+ 新建'),
            )
          : null,
      )

      let content
      if (!status.unlocked && !status.hasVault) {
        content = h(React.Fragment, null, header,
          h(ErrorBanner, { error }),
          h(VaultGate, { status, onChanged: refresh, onError: setError }))
      } else if (!status.unlocked) {
        content = h(React.Fragment, null, header,
          h(ErrorBanner, { error }),
          h(VaultGate, { status, onChanged: refresh, onError: setError }))
      } else if (view === 'settings') {
        content = h(React.Fragment, null, header, h(ErrorBanner, { error }),
          h(Settings, { status, onChanged: refresh, onError: setError }))
      } else {
        content = h(React.Fragment, null, header,
          h(ErrorBanner, { error }),
          h('div', { className: 'en-body' },
            h(NoteList, {
              notes: visible, activeId, filters, onFilters: setFilters,
              onOpen: (id) => setActiveId(id),
              onNew: () => setActiveId(null),
            }),
            h(Editor, {
              status, noteId: activeId, onError: setError,
              onSaved: async (id) => { setActiveId(id); await refresh() },
              onDeleted: async () => { setActiveId(null); await refresh() },
            }),
          ))
      }

      return h(React.Fragment, null, h(Styles), h('div', { className: 'en-root' }, content))
    }

    /** The sidebar entry icon. */
    function EchoNotesIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H17a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a2 2 0 0 1-2-2z' }),
        h('path', { d: 'M8 9.5h8M8 13h5' }),
      )
    }

    return {
      inject: ['slots', 'layout'],
      /**
       * The inner views, exposed for tests only.
       *
       * They are not part of the Client module contract; the browser never
       * reads this field. Keeping the references here is what lets the views be
       * rendered without a DOM in `test/client-views.test.js`.
       */
      __views: { Editor, Settings, NoteList, VaultGate, EchoNotesPanel },
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, EchoNotesPanel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => '回声笔记',
        }, EchoNotesIcon))
      },
    }
  },
})
