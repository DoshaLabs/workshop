// The Reminders tile's data, pure: no DOM, no bridge. The page (tile.js) keeps one state in
// `workshop.storage` and changes it only through `apply`; a Claude session's door call is turned
// into the same ops by `parseCall`. test/reminders.test.ts runs this file as it ships.
//
// A PROJECT is a folder's absolute path. A reminder is something the user has to do; a note is
// something worth knowing; the log is work that got done. Completing a reminder writes its log
// line; the reminder itself leaves the list once its local day has ended (`sweep`).

export const PRIORITIES = ['high', 'normal', 'low']
export const TEXT_MAX = 2000
export const NOTE_MAX = 20000

const RANK = { high: 0, normal: 1, low: 2 }

export const empty = () => ({ reminders: [], notes: [], log: [] })

/** Local calendar day as YYYY-MM-DD. */
export function dayOf(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function isDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const t = new Date(y, m - 1, d)
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d
}

const dueKey = (r) => r.due ?? '9999-99-99'
const doneFirst = (a, b) => Number(a.doneAt !== null) - Number(b.doneAt !== null)
/** Open before completed, then most important, then soonest due, then oldest. */
export const byPriority = (a, b) => doneFirst(a, b) || RANK[a.priority] - RANK[b.priority] || dueKey(a).localeCompare(dueKey(b)) || a.createdAt - b.createdAt
/** Open before completed, then soonest due (undated last), then most important. */
export const byDue = (a, b) => doneFirst(a, b) || dueKey(a).localeCompare(dueKey(b)) || RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt
export const byNewest = (a, b) => doneFirst(a, b) || b.createdAt - a.createdAt

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Whatever storage held, as a state: anything malformed is dropped, never trusted. */
export function clean(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])
  const out = empty()
  for (const r of list(o.reminders)) {
    if (!str(r.id) || !str(r.project) || !str(r.text)) continue
    out.reminders.push({ id: r.id, project: r.project, text: r.text, detail: str(r.detail), priority: PRIORITIES.includes(r.priority) ? r.priority : 'normal', due: isDay(r.due) ? r.due : null, createdAt: num(r.createdAt) ?? 0, by: str(r.by, 'you'), doneAt: num(r.doneAt) })
  }
  for (const n of list(o.notes)) if (str(n.id) && str(n.project) && str(n.text)) out.notes.push({ id: n.id, project: n.project, text: n.text, at: num(n.at) ?? 0, by: str(n.by, 'you') })
  for (const l of list(o.log)) if (str(l.id) && str(l.project) && str(l.text)) out.log.push({ id: l.id, project: l.project, text: l.text, at: num(l.at) ?? 0, by: str(l.by, 'you'), reminderId: str(l.reminderId) || null })
  return out
}

/** Takes completed reminders from before today off the list. Returns the same object if nothing left. */
export function sweep(state, now) {
  const today = dayOf(now)
  const left = state.reminders.filter((r) => r.doneAt === null || dayOf(r.doneAt) >= today)
  return left.length === state.reminders.length ? state : { ...state, reminders: left }
}

export const baseName = (p) => p.split('/').filter(Boolean).pop() ?? '/'

/** Every project anything is filed under, plus `extra` (the sessions' folders), by folder name. */
export function projectsOf(state, extra = []) {
  const set = new Set(extra.filter(Boolean))
  for (const x of [...state.reminders, ...state.notes, ...state.log]) set.add(x.project)
  return [...set].sort((a, b) => baseName(a).localeCompare(baseName(b)) || a.localeCompare(b))
}

/**
 * What someone wrote for a project → its folder. An absolute path is taken as it is. Anything
 * else must be the folder name of exactly one project this tile already knows (a sandboxed page
 * cannot look at the disk, so it cannot expand `~` or a relative path).
 */
export function resolveProject(given, known) {
  const g = String(given ?? '').trim()
  if (!g) throw new Error('which project? pass --project with an absolute folder or a known project\'s name')
  if (g.startsWith('/')) return g.length > 1 ? g.replace(/\/+$/, '') : g
  const hits = known.filter((p) => baseName(p) === g)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new Error(`"${g}" names ${hits.length} projects: pass the whole path (${hits.join(', ')})`)
  throw new Error(`no project called "${g}". Pass an absolute folder${known.length ? `, or one of: ${known.map(baseName).join(', ')}` : ''}`)
}

function text(b, max) {
  const t = str(b.text).trim()
  if (!t) throw new Error('nothing to write: the text is empty')
  if (t.length > max) throw new Error(`too long: ${t.length} characters, ${max} at most`)
  return t
}

function fields(b) {
  const out = {}
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) throw new Error(`priority is ${PRIORITIES.join(' | ')}, not "${String(b.priority)}"`)
    out.priority = b.priority
  }
  if (b.due !== undefined) {
    if (b.due !== null && !isDay(b.due)) throw new Error(`due is a real date as YYYY-MM-DD, not "${String(b.due)}"`)
    out.due = b.due
  }
  if (b.detail !== undefined) {
    const d = str(b.detail)
    if (d.length > NOTE_MAX) throw new Error(`detail is too long: ${NOTE_MAX} characters at most`)
    out.detail = d
  }
  return out
}

function randomId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(3))
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

/**
 * One op on the state. Returns `{ state, result }`; `state` is the same object when nothing
 * changed. Throws with a sentence the caller can read. `ctx`:
 *   by       who is writing: 'you', or a session's name
 *   now      the time, in ms
 *   here     the project to use when the op names none (the calling session's folder), or ''
 *   known    projects a bare name may refer to (projectsOf)
 *   id       makes an id from a prefix (tests pass their own)
 */
export function apply(state0, b, ctx) {
  const now = ctx.now
  const id = ctx.id ?? randomId
  const s = sweep(state0, now)
  const project = () => (b.project !== undefined && b.project !== '' ? resolveProject(b.project, ctx.known ?? []) : ctx.here ? ctx.here : resolveProject('', []))
  const reminder = (rid) => {
    const r = s.reminders.find((x) => x.id === rid)
    if (!r) throw new Error(`no reminder "${String(rid)}" (a completed one leaves the list when its day ends)`)
    return r
  }
  switch (b.op) {
    case 'add': {
      const r = { id: id('r'), project: project(), text: text(b, TEXT_MAX), detail: '', priority: 'normal', due: null, createdAt: now, by: ctx.by, doneAt: null, ...fields(b) }
      return { state: { ...s, reminders: [...s.reminders, r] }, result: { reminder: r } }
    }
    case 'set': {
      const note = s.notes.find((n) => n.id === b.id)
      if (note) {
        const n = { ...note, text: text(b, NOTE_MAX) }
        return { state: { ...s, notes: s.notes.map((x) => (x.id === n.id ? n : x)) }, result: { note: n } }
      }
      const r = reminder(b.id)
      const t = b.text !== undefined ? text(b, TEXT_MAX) : r.text
      const p = b.project !== undefined ? resolveProject(b.project, ctx.known ?? []) : r.project
      const next = { ...r, ...fields(b), text: t, project: p }
      // A completed reminder's log line says what the reminder says.
      return { state: { ...s, reminders: s.reminders.map((x) => (x.id === next.id ? next : x)), log: s.log.map((l) => (l.reminderId === next.id ? { ...l, text: t, project: p } : l)) }, result: { reminder: next } }
    }
    case 'done': {
      const r = reminder(b.id)
      if (r.doneAt !== null) return { state: s, result: { reminder: r } }
      const next = { ...r, doneAt: now }
      const line = { id: id('l'), project: r.project, text: r.text, at: now, by: ctx.by, reminderId: r.id }
      return { state: { ...s, reminders: s.reminders.map((x) => (x.id === r.id ? next : x)), log: [...s.log, line] }, result: { reminder: next, logged: line } }
    }
    case 'undo': {
      const r = reminder(b.id)
      if (r.doneAt === null) return { state: s, result: { reminder: r } }
      const next = { ...r, doneAt: null }
      return { state: { ...s, reminders: s.reminders.map((x) => (x.id === r.id ? next : x)), log: s.log.filter((l) => l.reminderId !== r.id) }, result: { reminder: next } }
    }
    case 'note': {
      const n = { id: id('n'), project: project(), text: text(b, NOTE_MAX), at: now, by: ctx.by }
      return { state: { ...s, notes: [...s.notes, n] }, result: { note: n } }
    }
    case 'log': {
      const l = { id: id('l'), project: project(), text: text(b, TEXT_MAX), at: now, by: ctx.by, reminderId: null }
      return { state: { ...s, log: [...s.log, l] }, result: { logged: l } }
    }
    case 'rm': {
      // A reminder goes with its log line (if it was completed today); a note or a log line goes alone.
      const rid = str(b.id)
      if (s.reminders.some((r) => r.id === rid)) return { state: { ...s, reminders: s.reminders.filter((r) => r.id !== rid), log: s.log.filter((l) => l.reminderId !== rid) }, result: { removed: rid } }
      if (s.notes.some((n) => n.id === rid)) return { state: { ...s, notes: s.notes.filter((n) => n.id !== rid) }, result: { removed: rid } }
      if (s.log.some((l) => l.id === rid)) return { state: { ...s, log: s.log.filter((l) => l.id !== rid) }, result: { removed: rid } }
      throw new Error(`nothing has the id "${rid}"`)
    }
    case 'list':
    case 'notes':
    case 'history': {
      const p = b.all === true ? null : project()
      const mine = (xs) => (p === null ? xs : xs.filter((x) => x.project === p))
      if (b.op === 'list') return { state: s, result: { project: p, reminders: mine(s.reminders).filter((r) => b.done === true || r.doneAt === null).sort(byPriority) } }
      const newest = (xs) => [...xs].sort((x, y) => y.at - x.at)
      const limit = Math.min(Math.max(num(b.limit) ?? 50, 1), 1000)
      if (b.op === 'notes') return { state: s, result: { project: p, notes: newest(mine(s.notes)).slice(0, limit) } }
      return { state: s, result: { project: p, log: newest(mine(s.log)).slice(0, limit) } }
    }
    default:
      throw new Error(`unknown op "${String(b.op)}"`)
  }
}

const BOOL = new Set(['all', 'done'])
const FLAGS = { add: ['priority', 'due', 'detail', 'project'], note: ['project'], log: ['project'], list: ['all', 'done', 'project'], notes: ['all', 'limit', 'project'], history: ['all', 'limit', 'project'], done: [], undo: [], rm: [], set: ['text', 'priority', 'due', 'detail', 'project'] }
export const OPS = Object.keys(FLAGS)

function dueOf(v, now) {
  if (v === 'none') return null
  if (v === 'today' || v === 'tomorrow') {
    const d = new Date(now)
    d.setDate(d.getDate() + (v === 'tomorrow' ? 1 : 0))
    return dayOf(d.getTime())
  }
  return v
}

/**
 * A door call's words → an op for `apply`. The door hands a tile strings only:
 *   add Rotate the key --priority high --due tomorrow
 *   set r_ab12cd --due none
 */
export function parseCall(op, args, now) {
  const allowed = FLAGS[op]
  if (!allowed) throw new Error(`unknown op "${op}"`)
  const flags = {}
  const words = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) {
      words.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const k = eq < 0 ? a.slice(2) : a.slice(2, eq)
    if (!allowed.includes(k)) throw new Error(`${op} has no --${k}${allowed.length ? ` (it has: ${allowed.map((f) => `--${f}`).join(' ')})` : ''}`)
    if (BOOL.has(k)) flags[k] = true
    else {
      const v = eq < 0 ? args[++i] : a.slice(eq + 1)
      if (v === undefined) throw new Error(`--${k} wants a value`)
      flags[k] = v
    }
  }
  const b = { op }
  for (const k of ['priority', 'detail', 'project', 'all', 'done']) if (flags[k] !== undefined) b[k] = flags[k]
  if (flags.due !== undefined) b.due = dueOf(flags.due, now)
  if (flags.limit !== undefined) b.limit = Number(flags.limit)
  if (op === 'add' || op === 'note' || op === 'log') b.text = words.join(' ')
  else if (op === 'done' || op === 'undo' || op === 'rm' || op === 'set') {
    if (!words[0]) throw new Error(`${op} which id? \`list\` shows them`)
    b.id = words[0]
    if (op === 'set' && flags.text !== undefined) b.text = flags.text
  }
  return b
}
