/**
 * Emotion-driven note templates ("情绪化模版").
 *
 * A template supplies the scaffolding a person needs when they cannot face a
 * blank page: opening prompts, a tone, and a set of default tags. The `persona`
 * field models the i人 / e人 axis (introvert / extrovert) as *writing energy*
 * rather than a personality verdict: an i-template asks inward questions and
 * expects short answers, an e-template asks outward questions and expects the
 * writer to relive a moment out loud.
 *
 * Everything here is plain data + pure functions so it can run in the Host, in
 * a test, or be shipped to the Client as JSON without a build step.
 *
 * @module echo-notes/templates
 */

/** @typedef {'i' | 'e' | 'neutral'} Persona */
/** @typedef {'joy' | 'calm' | 'sad' | 'angry' | 'anxious' | 'tired' | 'grateful' | 'excited' | 'neutral'} Mood */

/**
 * The recognised moods, in a deliberate order (warm → heavy → flat) so the
 * picker reads as a gradient rather than an alphabetical dump.
 * `intensity` is shown to the writer as a hint, never used for scoring.
 */
export const MOODS = /** @type {const} */ ([
  { id: 'joy', emoji: '😊', zh: '开心', en: 'Happy', hue: 45 },
  { id: 'excited', emoji: '🤩', zh: '兴奋', en: 'Excited', hue: 20 },
  { id: 'grateful', emoji: '🥰', zh: '感恩', en: 'Grateful', hue: 330 },
  { id: 'calm', emoji: '😌', zh: '平静', en: 'Calm', hue: 165 },
  { id: 'tired', emoji: '😮‍💨', zh: '疲惫', en: 'Tired', hue: 220 },
  { id: 'anxious', emoji: '😰', zh: '焦虑', en: 'Anxious', hue: 265 },
  { id: 'sad', emoji: '😢', zh: '伤心', en: 'Sad', hue: 210 },
  { id: 'angry', emoji: '😤', zh: '生气', en: 'Angry', hue: 5 },
  { id: 'neutral', emoji: '😐', zh: '无感', en: 'Neutral', hue: 0 },
])

/** Fast lookup by mood id. */
const MOOD_BY_ID = new Map(MOODS.map((mood) => [mood.id, mood]))

/**
 * Resolve a mood id to its descriptor.
 * @param {string} id
 * @returns {(typeof MOODS)[number] | undefined}
 */
export function moodById(id) {
  return MOOD_BY_ID.get(id)
}

/**
 * Built-in templates. `prompts` are rendered as headings with empty space
 * beneath; `scaffold` is the literal starting body.
 */
export const BUILTIN_TEMPLATES = /** @type {const} */ ([
  {
    id: 'i-daily',
    persona: 'i',
    mood: null,
    name: { zh: 'i 人日记', en: 'Introvert Daily' },
    description: {
      zh: '安静地和自己待一会儿。问题向内，答案可以很短。',
      en: 'Sit quietly with yourself. Inward questions, short answers welcome.',
    },
    prompts: [
      { zh: '今天哪一刻我最想一个人待着？', en: 'When today did I most want to be alone?' },
      { zh: '有一件我没说出口的事是……', en: 'One thing I did not say out loud was…' },
      { zh: '今天我为自己做的最小的一件事', en: 'The smallest thing I did for myself today' },
    ],
    tags: ['i人', '独处'],
  },
  {
    id: 'e-daily',
    persona: 'e',
    mood: null,
    name: { zh: 'e 人日记', en: 'Extrovert Daily' },
    description: {
      zh: '把今天的热闹倒出来。问题向外，细节越多越好。',
      en: 'Pour out the noise of today. Outward questions, detail encouraged.',
    },
    prompts: [
      { zh: '今天谁让我笑出声了？', en: 'Who made me laugh out loud today?' },
      { zh: '如果给今天配一句台词，是——', en: 'If today had one line of dialogue, it would be—' },
      { zh: '我想立刻分享给别人的那件事', en: 'The thing I wanted to tell someone immediately' },
    ],
    tags: ['e人', '连接'],
  },
  {
    id: 'free',
    persona: 'neutral',
    mood: null,
    name: { zh: '自由书写', en: 'Free Write' },
    description: { zh: '不设问题，想到什么写什么。', en: 'No prompts. Whatever comes.' },
    prompts: [],
    tags: [],
  },
  { id: 'joy', persona: 'neutral', mood: 'joy', name: { zh: '开心的时候', en: 'When Happy' }, description: { zh: '把好心情存下来，以后可以取。', en: 'Bank the good mood for later.' }, prompts: [{ zh: '让我开心的是……', en: 'What made me happy is…' }, { zh: '我想把这个瞬间留给未来的自己吗？', en: 'Do I want to save this moment for future me?' }], tags: ['开心'] },
  { id: 'excited', persona: 'neutral', mood: 'excited', name: { zh: '兴奋的时候', en: 'When Excited' }, description: { zh: '趁热写下，别让火花凉掉。', en: 'Write it hot, before the spark cools.' }, prompts: [{ zh: '我现在最想立刻去做的事', en: 'What I want to do right now' }, { zh: '第一步可以是什么？', en: 'What could the first step be?' }], tags: ['兴奋'] },
  { id: 'grateful', persona: 'neutral', mood: 'grateful', name: { zh: '感恩的时候', en: 'When Grateful' }, description: { zh: '记下具体的一个人、一句话。', en: 'Name one specific person, one specific sentence.' }, prompts: [{ zh: '我想谢谢的这个人/这件事', en: 'The person or thing I want to thank' }, { zh: '对方可能并不知道我记住了这件事', en: 'They may not know I remembered this' }], tags: ['感恩'] },
  { id: 'calm', persona: 'neutral', mood: 'calm', name: { zh: '平静的时候', en: 'When Calm' }, description: { zh: '平静是稀缺资源，值得记录。', en: 'Calm is scarce. Worth recording.' }, prompts: [{ zh: '此刻身边的三个声音', en: 'Three sounds around me right now' }, { zh: '这种平静是怎么来的？', en: 'How did this calm arrive?' }], tags: ['平静'] },
  { id: 'tired', persona: 'neutral', mood: 'tired', name: { zh: '疲惫的时候', en: 'When Tired' }, description: { zh: '不解决问题，只是放下。', en: 'Not solving anything. Just setting it down.' }, prompts: [{ zh: '今天消耗我最多的是……', en: 'What drained me most today…' }, { zh: '我现在需要的其实只是……', en: 'What I actually need right now is only…' }], tags: ['疲惫'] },
  { id: 'anxious', persona: 'neutral', mood: 'anxious', name: { zh: '焦虑的时候', en: 'When Anxious' }, description: { zh: '把模糊的担心写成具体的句子。', en: 'Turn vague dread into a concrete sentence.' }, prompts: [{ zh: '我具体在担心的那件事', en: 'The specific thing I am worried about' }, { zh: '它有多少是我能控制的？', en: 'How much of it can I control?' }, { zh: '最小的下一步', en: 'The smallest next step' }], tags: ['焦虑'] },
  { id: 'sad', persona: 'neutral', mood: 'sad', name: { zh: '伤心的时候', en: 'When Sad' }, description: { zh: '不用振作，写下来就好。', en: 'No need to cheer up. Just write it down.' }, prompts: [{ zh: '让我难过的是……', en: 'What hurt is…' }, { zh: '如果对朋友说，我会怎么说？', en: 'If I told a friend, what would I say?' }], tags: ['伤心'] },
  { id: 'angry', persona: 'neutral', mood: 'angry', name: { zh: '生气的时候', en: 'When Angry' }, description: { zh: '这里是安全的，随便骂。', en: 'This is a safe place. Say it all.' }, prompts: [{ zh: '我真正被冒犯的是……', en: 'What actually crossed my line is…' }, { zh: '我希望对方知道的一件事', en: 'One thing I wish they knew' }], tags: ['生气'] },
  { id: 'weekly-review', persona: 'neutral', mood: null, name: { zh: '每周回顾', en: 'Weekly Review' }, description: { zh: '一周一次，把碎片连成线。', en: 'Once a week, connect the fragments.' }, prompts: [{ zh: '这一周反复出现的一个念头', en: 'A thought that kept returning this week' }, { zh: '做成了的一件事', en: 'One thing I finished' }, { zh: '下周想少做的一件事', en: 'One thing to do less next week' }], tags: ['回顾'] },
  { id: 'one-line', persona: 'neutral', mood: null, name: { zh: '一句话日记', en: 'One Line' }, description: { zh: '只写一句也可以，坚持比完整重要。', en: 'One line counts. Consistency beats completeness.' }, prompts: [{ zh: '今天一句话', en: 'Today in one line' }], tags: ['一句话'] },
])

/** @type {Map<string, any>} */
const TEMPLATE_BY_ID = new Map(BUILTIN_TEMPLATES.map((tpl) => [tpl.id, tpl]))

/**
 * Look up a built-in template or a user-authored one.
 * @param {string} id
 * @param {readonly any[]} [custom] user templates that may shadow built-ins.
 * @returns {any | undefined}
 */
export function templateById(id, custom = []) {
  return custom.find((tpl) => tpl.id === id) ?? TEMPLATE_BY_ID.get(id)
}

/**
 * Every template the writer can choose, user templates first so a custom
 * "i 人模版" can replace the shipped one without editing the plugin.
 * @param {readonly any[]} [custom]
 * @returns {any[]}
 */
export function listTemplates(custom = []) {
  const shadowed = new Set(custom.map((tpl) => tpl.id))
  return [...custom, ...BUILTIN_TEMPLATES.filter((tpl) => !shadowed.has(tpl.id))]
}

/**
 * Pick the template that best matches a mood, used by "write a note for me"
 * automations and by the UI when the writer taps a mood directly.
 * @param {string | null | undefined} mood
 * @param {readonly any[]} [custom]
 * @returns {any}
 */
export function templateForMood(mood, custom = []) {
  if (mood) {
    const exact = listTemplates(custom).find((tpl) => tpl.mood === mood)
    if (exact) return exact
  }
  return templateById('free', custom)
}

/**
 * Render a template into the body a writer starts from.
 *
 * Prompt headings are emitted as `## ` sections with a blank line beneath, so
 * the cursor lands somewhere useful and the structure survives round-tripping
 * through the editor.
 *
 * @param {any} template
 * @param {{ mood?: string | null, date?: Date }} [options]
 * @returns {string}
 */
export function renderTemplate(template, options = {}) {
  const mood = options.mood ?? template?.mood ?? null
  const moodInfo = mood ? moodById(mood) : undefined
  const lines = []
  const title = moodInfo ? `${moodInfo.emoji} ${moodInfo.zh} · ${template?.name?.zh ?? ''}`.trim() : template?.name?.zh ?? ''
  if (title) lines.push(`# ${title}`, '')
  if (moodInfo) lines.push(`情绪：${moodInfo.zh}`, '')
  const prompts = Array.isArray(template?.prompts) ? template.prompts : []
  if (prompts.length === 0) {
    lines.push('')
  } else {
    for (const prompt of prompts) {
      lines.push(`## ${prompt.zh}`, '', '')
    }
  }
  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`
}
