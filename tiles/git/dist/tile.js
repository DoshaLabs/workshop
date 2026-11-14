// The Git tile: every open session's working tree as a lane (the column), a lane's review read like
// a pull request (the pane), the review studio (the whole window, `overlay`), the history as a graph
// coloured by session, the worktrees as a board with an operation log to undo from, and pull
// requests with their checks through gh. Plain JavaScript, no build.
//
// The git work is the backend's (../backend.mjs, the trusted tier), which this page reaches through
// `workshop.backend`, naming sessions by id and projects by the roots core gave them. The views are
// lanes.js, review.js, studio.js, history.js, worktrees.js and prs.js; their rules are model.js,
// diff.js, graph.js and query.js (tested as shipped); app.js holds the state, data.js the asking.
//
// What it uses of the contract: backend; sessions "write" (the list with each session's band, a
// review's notes typed into a session, and the new-session form); overlay (the whole window); view;
// head (the count of changed files); door (`show`).

import { S, call, currentLane, onDraw, pickLane, render, save, say, showToast, ws } from './app.js'
import { el } from './dom.js'
import { badgeOf, shown, sessionsKey, totals, worktreeOfSession } from './model.js'
import { refreshChanges, refreshCmdlog, refreshDiffs, refreshHistory, refreshOplog, refreshPrs, refreshRefs, refreshWorktrees } from './data.js'
import { drawLanes } from './lanes.js'
import { drawReview, goToFile, sendNotes, commitLane } from './review.js'
import { HIST_FILTERS, drawHistory, setHistFilter } from './history.js'
import { WT_FILTERS, drawWorktrees, setWtFilter, undoLast } from './worktrees.js'
import { PR_FILTERS, drawPrs, setPrFilter } from './prs.js'
import { drawStudio, laneActions, onPalette, stepFile } from './studio.js'
import { setViewed, startNote } from './diffview.js'
import { lines } from './diff.js'

const $ = (id) => document.getElementById(id)
const bar = $('bar')
const body = $('body')
const foot = $('foot')
const layer = $('layer')

const TABS = [
  ['changes', 'Lanes'],
  ['history', 'History'],
  ['worktrees', 'Worktrees'],
  ['prs', 'PRs']
]

// ---- drawing

function filterButtons(list, current, attr, set) {
  return el(
    'span',
    { class: 'filter' },
    list.map(([id, label]) => el('button', { class: current === id ? 'on' : undefined, [attr]: id, onclick: () => set(id) }, label))
  )
}

function drawBar() {
  const failing = [...S.prs.values()].some((d) => d.prs?.some((p) => p.state === 'fail'))
  const parts = [
    el(
      'nav',
      { class: 'seg tabs', 'aria-label': 'Views' },
      TABS.map(([id, label]) => el('button', { class: id === S.tab ? 'on' : undefined, 'data-tab': id, onclick: () => setTab(id) }, label, id === 'prs' && failing ? el('span', { class: 'flag', 'aria-label': 'a check failed' }, '●') : null))
    ),
    el('span', { class: 'spacer' }),
    S.tab === 'worktrees' ? filterButtons(WT_FILTERS, S.wtFilter, 'data-filter', setWtFilter) : null,
    S.tab === 'history' ? filterButtons(HIST_FILTERS, S.histFilter, 'data-hfilter', setHistFilter) : null,
    S.tab === 'prs' ? filterButtons(PR_FILTERS, S.prWhich, 'data-pfilter', setPrFilter) : null,
    (S.tab === 'changes' && S.at) || (S.tab === 'worktrees' && S.wt) || (S.tab === 'history' && S.hist) ? el('span', { class: 'muted live' }, 'live') : null
  ]
  bar.replaceChildren(...shown(parts))
}

function drawFoot() {
  const view = ws.view
  const hints =
    view === 'tile'
      ? [['↵', 'review'], ['h', 'history'], ['w', 'worktrees'], ['⌘K', 'actions'], ['?', 'keys']]
      : S.tab === 'changes'
        ? [['j k', 'file'], ['n p', 'hunk'], ['c', 'note'], ['s', 'stage'], ['space', 'viewed'], ['⌘K', 'actions'], ['?', 'keys']]
        : [['l', 'lanes'], ['h', 'history'], ['w', 'worktrees'], ['r', 'PRs'], ['⌘K', 'actions'], ['?', 'keys']]
  const last = view === 'overlay' ? S.cmdlog.filter((c) => c.write).at(-1) ?? S.cmdlog.at(-1) : null
  foot.hidden = false
  foot.replaceChildren(
    last ? el('span', { class: 'cmd', title: `${last.program} ${last.args.join(' ')}` }, el('b', {}, '$ '), `${last.program} ${last.args.join(' ')} · ${last.ms} ms`) : el('span', { class: 'spacer' }),
    ...hints.map(([k, w]) => el('span', {}, el('span', { class: 'k' }, k), w))
  )
}

function view() {
  if (S.tab === 'worktrees') return drawWorktrees()
  if (S.tab === 'history') return drawHistory()
  if (S.tab === 'prs') return drawPrs()
  if (ws.view === 'overlay') return drawStudio()
  if (ws.view === 'pane') return drawReview()
  return drawLanes()
}

/** Inputs keep their focus and caret, and scrolled boxes their place, across a redraw. */
function keep() {
  const a = document.activeElement
  const key = a?.dataset?.key
  const scrolls = [...document.querySelectorAll('[data-scroll]')].map((e) => [e.dataset.scroll, e.scrollTop])
  return { key, start: a?.selectionStart, end: a?.selectionEnd, scrolls, top: body.scrollTop }
}
function restore(k) {
  for (const [name, top] of k.scrolls) {
    const e = document.querySelector(`[data-scroll="${name}"]`)
    if (e) e.scrollTop = top
  }
  body.scrollTop = k.top
  if (k.key) {
    const e = document.querySelector(`[data-key="${k.key}"]`)
    if (e) {
      e.focus()
      try {
        if (k.start != null) e.setSelectionRange(k.start, k.end)
      } catch {
        // not a text field
      }
    }
  }
}

function draw() {
  const k = keep()
  document.body.classList.toggle('pane', ws.view === 'pane')
  document.body.classList.toggle('overlay', ws.view === 'overlay')
  drawBar()
  void ws.head.set({ badge: badgeOf(totals(S.projects).files) }).catch(() => {})
  const p = $('problem')
  const text = S.backendState === 'failed' ? 'The git helper stopped. Turn the tile off and on again to restart it.' : S.error ? `Could not read git: ${S.error}` : ''
  p.textContent = text
  p.hidden = !text
  body.replaceChildren(...view().flat(Infinity).filter((x) => x != null && x !== false))
  drawFoot()
  drawLayer()
  showToast()
  restore(k)
}
onDraw(draw)

// ---- the palette (⌘K) and the keys (?)

function paletteItems() {
  const cur = currentLane()
  const items = [
    ...TABS.map(([id, label]) => ({ label: `Go to ${label}`, hint: 'tab', run: () => setTab(id) })),
    ...(ws.view !== 'tile' ? laneActions(cur).map((a) => ({ label: a.label.replace(/^[^\w]+ /, ''), hint: a.hint, run: a.run })) : []),
    ...(ws.view !== 'overlay' && ws.openOverlay ? [{ label: 'Open the whole window', hint: 'f', run: () => ws.openOverlay() }] : []),
    ...(ws.view === 'tile' ? [{ label: 'Open the review', hint: '↵', run: () => ws.openPane() }] : []),
    { label: S.layout === 'split' ? 'Show diffs unified' : 'Show diffs side by side', hint: 'v', run: () => toggleLayout() },
    ...(cur && (S.notes[cur.w.top] ?? []).length ? [{ label: 'Send notes to the session', hint: '', run: () => sendNotes(cur) }] : []),
    ...[...(S.projects ?? [])].flatMap((p) => p.worktrees.map((w) => ({ label: `Lane: ${w.sessions.map((s) => s.name).join(', ') || w.name}`, hint: p.name, run: () => (pickLane(w.top), ws.view === 'tile' ? ws.openPane() : refreshDiffs(true).then(render)) }))),
    ...(cur && ws.view !== 'tile' ? (S.diffs.get(cur.w.top)?.files ?? []).map((f) => ({ label: `File: ${f.path}`, hint: f.status, run: () => goToFile(f.path) })) : [])
  ]
  const q = (S.palette?.q ?? '').toLowerCase().trim()
  return q ? items.filter((i) => q.split(/\s+/).every((w) => `${i.label} ${i.hint}`.toLowerCase().includes(w))) : items
}

function openPalette() {
  S.palette = { q: '', i: 0 }
  render()
  requestAnimationFrame(() => document.querySelector('[data-key="palette"]')?.focus())
}
onPalette(openPalette)

function runPalette(item) {
  S.palette = null
  render()
  if (item) void Promise.resolve(item.run()).catch((e) => say(e.message, false))
}

function drawLayer() {
  if (S.palette) {
    const items = paletteItems().slice(0, 60)
    const i = Math.min(S.palette.i, Math.max(0, items.length - 1))
    layer.replaceChildren(
      el(
        'div',
        { class: 'scrim', onclick: (e) => e.target === e.currentTarget && ((S.palette = null), render()) },
        el(
          'div',
          { class: 'palette', role: 'dialog', 'aria-label': 'Actions' },
          el('input', {
            type: 'text',
            'data-key': 'palette',
            'aria-label': 'Type an action',
            placeholder: 'Type an action: push, history, a file, a lane…',
            value: S.palette.q,
            oninput: (e) => {
              S.palette.q = e.target.value
              S.palette.i = 0
              render()
            },
            onkeydown: (e) => {
              e.stopPropagation()
              if (e.key === 'ArrowDown') S.palette.i = Math.min(items.length - 1, i + 1)
              else if (e.key === 'ArrowUp') S.palette.i = Math.max(0, i - 1)
              else if (e.key === 'Enter') return runPalette(items[i])
              else if (e.key === 'k' && e.metaKey) S.palette = null
              else return
              e.preventDefault()
              render()
            }
          }),
          el('ul', {}, items.map((it, n) => el('li', {}, el('button', { class: n === i ? 'on' : undefined, onclick: () => runPalette(it) }, it.label, el('span', { class: 'hint' }, it.hint)))))
        )
      )
    )
    return
  }
  if (S.keysHelp) {
    const rows = [
      ['l h w r', 'Lanes, History, Worktrees, PRs'],
      ['↵', 'open the review (in the column)'],
      ['f', 'the whole window'],
      ['j k', 'next and previous file'],
      ['n p', 'next and previous hunk'],
      ['space', 'mark the file viewed, go to the next'],
      ['s', 'stage or unstage the file'],
      ['c', 'a note on the hunk you are in'],
      ['v', 'unified or side by side'],
      ['⌘↵', 'commit what is staged'],
      ['⌘Z', 'undo the last step (press twice)'],
      ['/', 'search the history'],
      ['⌘K', 'every action, by name'],
      ['esc', 'close the whole window']
    ]
    layer.replaceChildren(
      el(
        'div',
        { class: 'scrim', onclick: () => ((S.keysHelp = false), render()) },
        el('div', { class: 'palette', role: 'dialog', 'aria-label': 'Keys' }, el('div', { class: 'keys' }, rows.map(([k, w]) => [el('span', {}, el('span', { class: 'k' }, k)), el('span', {}, w)])))
      )
    )
    return
  }
  layer.replaceChildren()
}

// ---- tabs, keys

function setTab(id) {
  S.tab = id
  save('tab', id)
  schedule()
  render()
  void refreshTab()
}

function toggleLayout() {
  S.layout = S.layout === 'split' ? 'unified' : 'split'
  save('layout', S.layout)
  render()
}

/** The hunk nearest the top of the review, and the next or previous one. */
function stepHunk(by) {
  const hunks = [...document.querySelectorAll('.hunk')]
  if (!hunks.length) return
  const box = ws.view === 'overlay' ? document.querySelector('[data-scroll="diff"]') : body
  const top = box.getBoundingClientRect().top
  const at = hunks.findIndex((h) => h.getBoundingClientRect().top > top + 4)
  const i = by > 0 ? (at < 0 ? hunks.length - 1 : at) : Math.max(0, (at < 0 ? hunks.length : at) - 2)
  hunks[i]?.scrollIntoView({ block: 'start' })
}

/** The file in view: the selected one, else the first whose diff starts below the top. */
function fileInView() {
  const cur = currentLane()
  const files = S.diffs.get(cur?.w.top)?.files ?? []
  if (ws.view === 'overlay') return { cur, f: files.find((f) => f.path === S.file) ?? files[0] }
  const heads = [...document.querySelectorAll('.dfile')]
  const top = body.getBoundingClientRect().top
  const el0 = heads.find((h) => h.getBoundingClientRect().bottom > top + 40)
  return { cur, f: files.find((f) => f.path === el0?.dataset.file) ?? files[0] }
}

function nextFile(by) {
  if (ws.view === 'overlay') return stepFile(by)
  const { cur, f } = fileInView()
  const files = S.diffs.get(cur?.w.top)?.files ?? []
  const i = files.indexOf(f)
  const n = files[Math.min(files.length - 1, Math.max(0, i + by))]
  if (n) goToFile(n.path)
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '')
  if (e.key === 'k' && e.metaKey) {
    e.preventDefault()
    if (S.palette) S.palette = null
    else return openPalette()
    return render()
  }
  if (typing) return
  if (S.keysHelp && e.key) {
    S.keysHelp = false
    render()
    return
  }
  if (e.key === 'z' && e.metaKey && !e.shiftKey) {
    const cur = currentLane()
    const root = cur?.p.root ?? S.wt?.projects[0]?.root
    if (root) {
      e.preventDefault()
      void refreshOplog().then(() => undoLast(root))
    }
    return
  }
  if (e.key === 'Enter' && e.metaKey && S.tab === 'changes' && ws.view !== 'tile') {
    const cur = currentLane()
    if (cur) void commitLane(cur)
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key
  const tabKey = { l: 'changes', h: 'history', w: 'worktrees', r: 'prs' }[k]
  if (tabKey) return setTab(tabKey)
  if (k === '?') {
    S.keysHelp = true
    return render()
  }
  if (k === '/' && S.tab === 'history') {
    e.preventDefault()
    return document.querySelector('[data-key="histq"]')?.focus()
  }
  if (k === 'f' && ws.view !== 'overlay' && ws.openOverlay) return void ws.openOverlay().catch((err) => say(err.message, false))
  if (k === 'Enter' && ws.view === 'tile' && S.tab === 'changes') return void ws.openPane()
  if (k === 'v') return toggleLayout()
  if (S.tab !== 'changes' || ws.view === 'tile') return
  if (k === 'j') return nextFile(1)
  if (k === 'k') return nextFile(-1)
  if (k === 'n') return stepHunk(1)
  if (k === 'p') return stepHunk(-1)
  const { cur, f } = fileInView()
  if (!cur || !f) return
  if (k === ' ') {
    e.preventDefault()
    setViewed(cur.w.top, f, true)
    render()
    return nextFile(1)
  }
  if (k === 's') {
    const lf = cur.w.files.find((x) => x.path === f.path)
    if (!lf) return
    void call(lf.unstaged ? 'stage' : 'unstage', { session: cur.w.sessions[0].id, path: f.path })
      .then((r) => say(r.said), (err) => say(err.message, false))
      .then(() => refreshChanges())
      .then(() => refreshDiffs(true))
      .then(render)
    return
  }
  if (k === 'c') {
    // A note on the first changed line of the hunk at the top of the view.
    const h = [...document.querySelectorAll(`.dfile[data-file="${CSS.escape(f.path)}"] .hunk`)][0]
    const hunk = f.hunks[Number(h?.dataset.hunk ?? 0)]
    const r = hunk && lines(hunk).find((x) => x.t === '+' || x.t === '-')
    if (r) startNote({ top: cur.w.top }, f.path, r)
  }
})

// ---- when to ask

let timers = []
const canSee = () => document.visibilityState === 'visible'
const every = (ms, fn) => timers.push(setInterval(() => void fn(), ms))
/** Polls only what the view shows, and only while the page can be seen. */
function schedule() {
  for (const t of timers) clearInterval(t)
  timers = []
  if (!canSee() || S.backendState === 'failed') return
  const overlay = ws.view === 'overlay'
  if (S.tab === 'changes') {
    every(4000, refreshChanges)
    every(120_000, refreshPrs)
  } else if (S.tab === 'worktrees') {
    every(6000, refreshWorktrees)
    every(6000, refreshOplog)
    every(120_000, refreshPrs)
  } else if (S.tab === 'history') every(8000, refreshHistory)
  else if (S.tab === 'prs') {
    every(60_000, refreshPrs)
    every(30_000, refreshWorktrees)
  }
  if (overlay) {
    every(10_000, refreshRefs)
    every(6000, refreshOplog)
    every(3000, refreshCmdlog)
    if (S.tab === 'changes') every(10_000, refreshWorktrees)
  }
}
/** Asks again for what the view shows. */
async function refreshTab() {
  const overlay = ws.view === 'overlay'
  if (S.tab === 'changes') {
    await refreshChanges()
    void refreshPrs()
    if (overlay) {
      void refreshRefs()
      void refreshOplog()
      void refreshCmdlog()
      void refreshWorktrees()
    }
  } else if (S.tab === 'worktrees') {
    await refreshWorktrees()
    void refreshOplog()
    void refreshPrs()
  } else if (S.tab === 'history') await refreshHistory()
  else if (S.tab === 'prs') {
    await refreshPrs()
    void refreshWorktrees()
    void refreshChanges()
  }
}
document.addEventListener('visibilitychange', () => {
  schedule()
  if (canSee()) void refreshTab()
})

let lastKey = ''
let soon = null
function onSessions(list) {
  S.sessions = list
  const key = sessionsKey(list) + list.map((s) => `${s.id}:${s.band}`).join(' ')
  if (key === lastKey) return
  lastKey = key
  render()
  // A session opened or closed, or its status moved (it went quiet after a turn): ask now, once.
  clearTimeout(soon)
  soon = setTimeout(() => {
    if (!canSee()) return
    if (S.tab === 'changes') for (const d of S.diffs.values()) d.sig = ''
    void refreshTab()
  }, 300)
}

// ---- the door: a session asks for its changes to be shown

ws.door?.handle('show', async (_args, caller, { session }) => {
  S.tab = 'changes'
  save('tab', S.tab)
  await refreshChanges()
  const w = session ? worktreeOfSession(S.projects, session) : null
  if (w) pickLane(w.top)
  await ws.openPane().catch(() => {})
  await refreshDiffs(true)
  render()
  if (!w) return { shown: false, why: session ? `${caller} is not working in a git repository` : 'call this from a session' }
  return { shown: true, branch: w.branch?.head ?? null, files: w.count, add: w.add, del: w.del }
})

// ---- start

ws.onViewChange(() => {
  schedule()
  render()
  void refreshTab()
})
// Core recorded a commit a session made: the History tab looks again at once.
ws.backend.onEvent?.((e) => {
  if (e?.name === 'commits' && S.tab === 'history' && canSee()) void refreshHistory()
})
ws.backend.onStatus((s) => {
  const was = S.backendState
  S.backendState = s?.state ?? 'starting'
  schedule()
  if (S.backendState === 'running' && was !== 'running') void refreshTab()
  else render()
})
ws.sessions.watch(onSessions)
S.backendState = (await ws.backend.status())?.state ?? 'starting'
S.sessions = await ws.sessions.list()
lastKey = sessionsKey(S.sessions)
render()
schedule()
await refreshChanges()
if (S.tab !== 'changes') await refreshTab()
else void refreshPrs()
window.gitReady = true
