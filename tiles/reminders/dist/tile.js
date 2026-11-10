// The Reminders tile: to-dos, notes and a running log, filed by project. Plain JavaScript, no
// build. The data and every rule about it are in model.js; this file is the page: it keeps the
// one state in `workshop.storage`, draws it, and answers a Claude session's door calls.
//
// What it uses of the contract: storage (the state), sessions (the focused session's project is
// where a new item goes; a door call's session id says which project the caller means), door
// (ten ops), notify (a session added a reminder), head (the open count), view (tile or pane).

import { OPS, apply, baseName, byDue, byNewest, byPriority, clean, dayOf, empty, parseCall, projectsOf, sessionProject, sweep } from './model.js'

const ws = window.workshop
const $ = (id) => document.getElementById(id)
const bar = $('bar')
const list = $('list')
const composer = $('composer')
const problemBox = $('problem')

/** Log and note rows drawn before "show more". */
const PAGE = 200
const ALL = ''
const OTHER = '\u0000other'
const PRIORITY_NEXT = { normal: 'high', high: 'low', low: 'normal' }
const FLAG = '<svg viewBox="0 0 12 12"><path d="M2.5 11V1.5M2.5 2h6.8L7.8 4.5 9.3 7H2.5"/></svg>'

let state = empty()
let loaded = false
let sessions = []
let view = loadView()
let today = dayOf(Date.now())
/** Reminders unfolded for editing, and the note being edited. */
const open = new Set()
let editing = null
let shown = PAGE
let picked = ''
let typing = false
let draftPriority = 'normal'

function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem('view') ?? '{}')
    return { tab: v.tab === 'notes' || v.tab === 'log' ? v.tab : 'todo', project: typeof v.project === 'string' ? v.project : ALL, sort: ['priority', 'due', 'newest'].includes(v.sort) ? v.sort : 'project' }
  } catch {
    return { tab: 'todo', project: ALL, sort: 'project' }
  }
}

function patchView(p) {
  view = { ...view, ...p }
  shown = PAGE
  try {
    localStorage.setItem('view', JSON.stringify(view))
  } catch {
    // it still works, it just forgets
  }
  render()
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue
    if (k === 'class') e.className = v
    else if (k === 'html') e.innerHTML = v // only ever a constant from this file
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (k === 'value') e.value = v
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k)
  return e
}

/** replaceChildren that skips what a condition left behind: the DOM would draw null and false as words. */
const put = (box, ...kids) => box.replaceChildren(...kids.flat().filter((k) => k != null && k !== false))

function problem(text) {
  problemBox.textContent = text
  problemBox.hidden = !text
}

// ---- state

let writing = Promise.resolve()
function commit(next) {
  if (next === state) return
  state = next
  // One write at a time, each of the latest state: a slow write never lands over a newer one.
  writing = writing.then(() => ws.storage.set('state', state)).catch((err) => problem(`Could not save: ${err.message}`))
  render()
}

const here = () => sessionProject(sessions.find((s) => s.focused))
const projects = () => projectsOf(state, [here(), picked, view.project, ...sessions.map(sessionProject)])

/** What the user does in the tile. A refusal is shown, not thrown. */
function act(op) {
  problem('')
  try {
    const r = apply(state, op, { by: 'you', now: Date.now(), here: here(), known: projects() })
    commit(r.state)
    return r.result
  } catch (err) {
    problem(err.message)
    return null
  }
}

/** What a Claude session does through the door. A refusal goes back to the session. */
function fromDoor(op, args, caller, from) {
  const now = Date.now()
  const session = sessions.find((s) => s.id === from.session)
  const r = apply(state, parseCall(op, args, now), { by: caller, now, here: sessionProject(session), known: projects() })
  commit(r.state)
  if (op === 'add') void ws.notify({ text: `${caller}: ${r.result.reminder.text}` }).catch(() => {})
  return r.result
}

// ---- words

const shortPath = (p) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function dayLabel(day) {
  if (day === today) return 'Today'
  const y = new Date()
  y.setDate(y.getDate() - 1)
  if (day === dayOf(y.getTime())) return 'Yesterday'
  const [yy, m, d] = day.split('-').map(Number)
  return new Date(yy, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(yy === new Date().getFullYear() ? {} : { year: 'numeric' }) })
}

/** Two projects with one folder name are told apart by their paths. */
function labeller(all) {
  const seen = new Map()
  for (const p of all) seen.set(baseName(p), (seen.get(baseName(p)) ?? 0) + 1)
  return (p) => (seen.get(baseName(p)) > 1 ? shortPath(p) : baseName(p))
}

// A note is markdown, drawn with DOM nodes only: paragraphs, lists, headings, code, bold, italic, links.
function inline(text) {
  const out = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g
  let at = 0
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push(text.slice(at, m.index))
    if (m[1] !== undefined) out.push(el('code', {}, m[1]))
    else if (m[2] !== undefined) out.push(el('b', {}, m[2]))
    else if (m[3] !== undefined) out.push(el('i', {}, m[3]))
    else {
      const url = m[5] ?? m[6]
      out.push(el('a', { title: url, onclick: () => void ws.openExternal(url).catch(() => {}) }, m[4] ?? url))
    }
    at = m.index + m[0].length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

function markdown(text) {
  const out = []
  const lines = text.split('\n')
  let para = []
  let items = null
  const flush = () => {
    if (para.length) out.push(el('p', {}, inline(para.join(' '))))
    if (items) out.push(el('ul', {}, items))
    para = []
    items = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      flush()
      const code = []
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i])
      out.push(el('pre', {}, code.join('\n')))
    } else if (/^\s*[-*] /.test(line)) {
      if (para.length) flush()
      ;(items ??= []).push(el('li', {}, inline(line.replace(/^\s*[-*] /, ''))))
    } else if (/^#{1,6} /.test(line)) {
      flush()
      out.push(el('h5', {}, inline(line.replace(/^#+ /, ''))))
    } else if (!line.trim()) flush()
    else {
      if (items) flush()
      para.push(line.trim())
    }
  }
  flush()
  return out
}

// ---- pieces

/** A destructive button that asks by arming itself: the first click turns it red, a second within 3 s does it. */
function armedDelete(title, onConfirm) {
  let timer = 0
  const b = el('button', { class: 'del', title }, '✕')
  b.addEventListener('click', () => {
    if (b.classList.contains('armed')) return onConfirm()
    b.classList.add('armed')
    b.textContent = 'delete'
    clearTimeout(timer)
    timer = setTimeout(() => {
      b.classList.remove('armed')
      b.textContent = '✕'
    }, 3000)
  })
  return b
}

const byTag = (by) => (by && by !== 'you' ? el('span', { class: 'by', title: `Written by session ${by}` }, by) : null)

/** A text box that saves when it loses focus (or ⌘⏎) and goes back on Esc. */
function savedText(value, { rows = 2, placeholder, focus, onSave, onClose }) {
  const t = el('textarea', { class: 'field', rows, placeholder })
  t.value = value
  let cancelled = false
  t.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      cancelled = true
      t.value = value
      t.blur()
    }
    if (e.key === 'Enter' && e.metaKey) t.blur()
  })
  t.addEventListener('blur', () => {
    if (!cancelled && t.value !== value) onSave(t.value)
    cancelled = false
    onClose?.()
  })
  if (focus) queueMicrotask(() => t.focus())
  return t
}

function projectSelect(all, label, value, title, onChange, extra = []) {
  const s = el('select', { title, onchange: (e) => onChange(e.target.value) }, extra.filter((o) => o.first).map((o) => el('option', { value: o.value }, o.text)), all.map((p) => el('option', { value: p }, label(p))), extra.filter((o) => !o.first).map((o) => el('option', { value: o.value }, o.text)))
  s.value = value
  return s
}

function reminderRow(r, showProject, all, label) {
  const done = r.doneAt !== null
  const isOpen = open.has(r.id)
  const line = el(
    'div',
    { class: 'line' },
    el('button', { class: 'check', role: 'checkbox', 'aria-checked': String(done), title: done ? 'Not done after all' : 'Mark complete (it leaves the list when the day ends, and goes in the log)', onclick: () => act({ op: done ? 'undo' : 'done', id: r.id }) }, done ? '✓' : ''),
    el('button', { class: `flag p-${r.priority}`, html: FLAG, disabled: done, title: `${r.priority} priority: click to change`, onclick: () => act({ op: 'set', id: r.id, priority: PRIORITY_NEXT[r.priority] }) }),
    el(
      'button',
      {
        class: 'text',
        title: isOpen ? 'Fold' : 'Open: edit, notes, due date',
        onclick: () => {
          if (isOpen) open.delete(r.id)
          else open.add(r.id)
          render()
        }
      },
      r.text,
      r.detail && !isOpen ? el('span', { class: 'has-detail', title: 'Has notes' }, ' ¶') : null
    ),
    r.due && !done ? el('span', { class: `due${r.due < today ? ' late' : r.due === today ? ' today' : ''}` }, r.due === today ? 'today' : dayLabel(r.due).replace('Yesterday', 'yesterday')) : null,
    showProject ? el('span', { class: 'chip', title: shortPath(r.project) }, baseName(r.project)) : null,
    byTag(r.by)
  )
  const row = el('div', { class: `row p-${r.priority}${done ? ' done' : ''}`, 'data-id': r.id }, line)
  if (!isOpen) return row
  const date = el('input', { type: 'date', onchange: (e) => act({ op: 'set', id: r.id, due: e.target.value || null }) })
  date.value = r.due ?? ''
  row.append(
    el(
      'div',
      { class: 'edit' },
      savedText(r.text, { onSave: (text) => text.trim() && act({ op: 'set', id: r.id, text }) }),
      savedText(r.detail, { rows: 3, placeholder: 'Notes on this reminder…', onSave: (detail) => act({ op: 'set', id: r.id, detail }) }),
      el(
        'div',
        { class: 'edit-row' },
        el('div', { class: 'seg', role: 'group', 'aria-label': 'Priority' }, ['high', 'normal', 'low'].map((p) => el('button', { class: r.priority === p ? 'on' : '', onclick: () => act({ op: 'set', id: r.id, priority: p }) }, p))),
        el('label', { class: 'date' }, 'due', date),
        projectSelect(all, label, r.project, 'Project', (project) => act({ op: 'set', id: r.id, project })),
        el('span', { class: 'spacer' }),
        armedDelete(done ? 'Delete, and take its line out of the log' : 'Delete without completing', () => act({ op: 'rm', id: r.id }))
      )
    )
  )
  return row
}

function noteRow(n) {
  const body =
    editing === n.id
      ? savedText(n.text, {
          rows: Math.min(12, Math.max(3, n.text.split('\n').length + 1)),
          focus: true,
          onSave: (text) => text.trim() && act({ op: 'set', id: n.id, text }),
          onClose: () => {
            editing = null
            render()
          }
        })
      : el(
          'div',
          {
            class: 'note-body',
            title: 'Click to edit',
            onclick: (e) => {
              if (window.getSelection()?.isCollapsed === false || e.target.closest('a, button')) return
              editing = n.id
              render()
            }
          },
          markdown(n.text)
        )
  return el(
    'div',
    { class: 'note', 'data-id': n.id },
    body,
    el('div', { class: 'meta' }, el('span', {}, `${new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(n.at)}`), byTag(n.by), el('span', { class: 'spacer' }), armedDelete('Delete this note', () => act({ op: 'rm', id: n.id })))
  )
}

const logRow = (l) => el('div', { class: 'logline', 'data-id': l.id }, el('span', { class: 'tick' }, '✓'), el('span', { class: 'logtext' }, l.text), byTag(l.by), el('span', { class: 'time' }, clock(l.at)), armedDelete('Take this line out of the log', () => act({ op: 'rm', id: l.id })))

const group = (title, path, count, kids) => el('section', { class: 'group' }, el('h4', { title: shortPath(path) }, title, count !== undefined ? el('span', { class: 'count' }, String(count)) : null), kids)

// ---- drawing

// Everything is drawn whole. Two moments must not replace nodes under the user: a mouse button is
// down (the click would land on a node that is gone), and a text box in the list has the keyboard
// (a session's door call would wipe what is being typed). Both draw when they end.
let heldAt = 0
let stale = false
const release = () => {
  heldAt = 0
  if (stale) render()
}
window.addEventListener(
  'pointerdown',
  () => {
    heldAt = performance.now()
    setTimeout(() => heldAt && performance.now() - heldAt >= 900 && release(), 1000)
  },
  true
)
window.addEventListener('click', release)
window.addEventListener('pointerup', () => setTimeout(release, 50))
// A native menu (a select) may end without a click.
window.addEventListener('change', () => (heldAt = 0), true)
list.addEventListener('focusout', () => setTimeout(() => stale && render(), 0))

let lastBadge = null

function render() {
  if (!loaded) return
  if (heldAt) {
    stale = true
    return
  }
  const all = projects()
  const label = labeller(all)
  const filter = view.project
  const inProject = (xs) => (filter ? xs.filter((x) => x.project === filter) : xs)
  const reminders = inProject(state.reminders)
  const openCount = reminders.filter((r) => r.doneAt === null).length

  const badge = String(state.reminders.filter((r) => r.doneAt === null).length || '')
  if (badge !== lastBadge) void ws.head.set({ badge: (lastBadge = badge) }).catch(() => {})

  put(bar, 
    el(
      'div',
      { class: 'tabs', role: 'tablist' },
      ['todo', 'notes', 'log'].map((t) => el('button', { role: 'tab', 'aria-selected': String(view.tab === t), class: view.tab === t ? 'on' : '', onclick: () => patchView({ tab: t }) }, t === 'todo' ? `To do${openCount ? ` ${openCount}` : ''}` : t === 'notes' ? 'Notes' : 'Log'))
    ),
    el('span', { class: 'spacer' }),
    projectSelect(all, label, filter, 'Show one project', (project) => patchView({ project }), [{ first: true, value: ALL, text: 'All projects' }]),
    view.tab === 'todo'
      ? (() => {
          const s = el('select', { title: 'Sort', onchange: (e) => patchView({ sort: e.target.value }) }, [['project', 'By project'], ['priority', 'By priority'], ['due', 'By due date'], ['newest', 'Newest']].map(([v, t]) => el('option', { value: v }, t)))
          s.value = view.sort
          return s
        })()
      : null
  )
  syncComposer(all, label)

  const a = document.activeElement
  if (a && a.tagName === 'TEXTAREA' && list.contains(a)) {
    stale = true
    return
  }
  stale = false
  const top = list.scrollTop
  put(list, ...[body(all, label, reminders, inProject)].flat())
  list.scrollTop = top
}

function body(all, label, reminders, inProject) {
  const filter = view.project
  const emptyLine = (what) => el('div', { class: 'empty' }, what)
  if (view.tab === 'todo') {
    const rows = [...reminders].sort(view.sort === 'due' ? byDue : view.sort === 'newest' ? byNewest : byPriority)
    if (!rows.length) return emptyLine('Nothing to do here.')
    if (view.sort !== 'project' || filter) return rows.map((r) => reminderRow(r, !filter, all, label))
    return all
      .filter((p) => rows.some((r) => r.project === p))
      .map((p) => {
        const mine = rows.filter((r) => r.project === p)
        return group(label(p), p, mine.filter((r) => r.doneAt === null).length, mine.map((r) => reminderRow(r, false, all, label)))
      })
  }
  const rows = [...inProject(view.tab === 'notes' ? state.notes : state.log)].sort((x, y) => y.at - x.at)
  if (!rows.length) return emptyLine(view.tab === 'notes' ? 'No notes yet.' : 'Nothing logged yet. Completed reminders land here.')
  const page = rows.slice(0, shown)
  const groups = all
    .filter((p) => page.some((x) => x.project === p))
    .map((p) => {
      const mine = page.filter((x) => x.project === p)
      if (view.tab === 'notes') return group(label(p), p, undefined, mine.map(noteRow))
      const days = [...new Set(mine.map((l) => dayOf(l.at)))]
      return group(label(p), p, rows.filter((l) => l.project === p).length, days.map((d) => el('div', { class: 'day' }, el('div', { class: 'day-label' }, dayLabel(d)), mine.filter((l) => dayOf(l.at) === d).map(logRow))))
    })
  if (rows.length > shown) groups.push(el('button', { class: 'more', onclick: () => ((shown += PAGE), render()) }, 'show more'))
  return groups
}

// ---- the composer: made once (a redraw must never take what is being typed), kept in step by syncComposer

const draft = el('textarea', { rows: 1 })
const flagButton = el('button', { html: FLAG, onclick: () => ((draftPriority = PRIORITY_NEXT[draftPriority]), render()) })
const where = el('select', { title: 'Which project this goes in' })
const folder = el('input', { type: 'text', placeholder: '/absolute/folder', spellcheck: 'false', hidden: true })
composer.append(flagButton, draft, where, folder)

/** Where a new item goes: the project shown, else the one picked, else the focused session's, else the first. */
const target = (all) => view.project || picked || here() || all[0] || ''

function syncComposer(all, label) {
  const tab = view.tab
  flagButton.hidden = tab !== 'todo'
  flagButton.className = `flag p-${draftPriority}`
  flagButton.title = `New reminder: ${draftPriority} priority. Click to change`
  draft.placeholder = tab === 'todo' ? 'Remind me to…' : tab === 'notes' ? 'A note…' : 'Something you got done…'
  where.hidden = !!view.project || typing
  folder.hidden = !typing
  const t = target(all)
  put(where, ...(t ? [] : [el('option', { value: '' }, 'project…')]), ...all.map((p) => el('option', { value: p }, label(p))), el('option', { value: OTHER }, 'Another folder…'))
  where.value = t
}

where.addEventListener('change', () => {
  if (where.value === OTHER) {
    typing = true
    render()
    folder.focus()
  } else {
    picked = where.value
    render()
  }
})

folder.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter') {
    const p = folder.value.trim().replace(/(?<=.)\/+$/, '')
    if (!p.startsWith('/')) return problem('A project is an absolute folder, like /Users/you/code/thing')
    picked = p
  }
  if (e.key === 'Enter' || e.key === 'Escape') {
    problem('')
    typing = false
    folder.value = ''
    render()
    draft.focus()
  }
})

draft.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Escape') draft.value = ''
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  const text = draft.value.trim()
  if (!text) return
  const project = target(projects())
  if (!project) return problem('Which project? Choose “Another folder…”')
  const tab = view.tab
  const ok = act(tab === 'todo' ? { op: 'add', text, project, priority: draftPriority } : { op: tab === 'notes' ? 'note' : 'log', text, project })
  if (!ok) return
  draft.value = ''
  draftPriority = 'normal'
  render()
})

// ---- start

const setView = (v) => document.body.classList.toggle('pane', v === 'pane')
setView(ws.view)
ws.onViewChange(setView)
// Esc in the pane goes back, unless a text box wants it.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ws.view === 'pane' && !e.target.closest?.('input, textarea, select')) void ws.closePane()
})

ws.sessions.watch((l) => {
  sessions = Array.isArray(l) ? l : []
  render()
})

try {
  const [raw, live] = await Promise.all([ws.storage.get('state'), ws.sessions.list()])
  sessions = Array.isArray(live) ? live : []
  loaded = true
  const kept = clean(raw)
  state = kept
  commit(sweep(kept, Date.now()))
  render()
  // Only now does the door answer: a call before the state is read would be written over it.
  for (const op of OPS) ws.door.handle(op, (args, caller, from) => fromDoor(op, args, caller, from))
  setInterval(() => {
    const now = Date.now()
    const day = dayOf(now)
    const next = sweep(state, now)
    if (day !== today || next !== state) {
      today = day
      if (next === state) render()
      else commit(next)
    }
  }, 60_000)
} catch (err) {
  // Never start over on top of a store that could not be read: it may be all the log there is.
  problemBox.textContent = `Reminders could not be read: ${err.message}`
  problemBox.hidden = false
}
