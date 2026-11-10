// The Git tile: what every open session has changed, every worktree of their projects, and their
// history, each commit tagged with the session that made it (exactly, or as a guess). Plain
// JavaScript, no build. The rules are in model.js; the git work is the backend's (../backend.mjs,
// the trusted tier), which this page reaches through `workshop.backend` naming sessions by id and
// worktrees by the paths the backend itself listed.
//
// What it uses of the contract: backend (changes, diff, worktrees, diffmain, rebase, merge,
// remove, history, commit, and its `commits` event when core records one), sessions launch (which sessions are open, when one goes quiet, and the new-session form
// filled in for "open a session here" and "new chat in a worktree"), view (poll only while the
// page can be seen; the pane gives diffs room), head (the count of changed files), door (`show`).

import { ARM_MS, LETTER, STALE_WORDS, ago, badgeOf, shown, byLabel, byTitle, groupCount, refsShown, todayBySession, actionsFor, branchLabel, dirtyLabel, filesLabel, filtered, isArmed, names, num, numbered, openIds, press, projectOverlaps, sessionsKey, signature, totals, versusBase, worktreeOfSession, worktreesOf } from './model.js'

const ws = window.workshop
const $ = (id) => document.getElementById(id)
const bar = $('bar')
const body = $('body')
const problemBox = $('problem')

/** How often the Changes tab asks again while it can be seen. A session going quiet asks at once. */
const POLL_MS = 4000
/** The Worktrees tab reads more per worktree (status, ahead / behind, the files its commits touch), so it asks a little less often. */
const WT_POLL_MS = 6000
/** The History tab: a log changes only when someone commits, and core says so when a session does; the poll catches the rest. */
const HIST_POLL_MS = 8000
/** Commits per project at first, and how many more "Show more" adds (the backend caps it at 3,000). */
const HIST_PAGE = 300
const TABS = [
  ['changes', 'Changes'],
  ['worktrees', 'Worktrees'],
  ['history', 'History'],
  ['prs', 'PRs']
]
const COMING = {
  prs: 'Your open pull requests and whether their checks pass, through the gh CLI.'
}

let tab = load('tab', 'changes')
/** Worktrees unfolded, by top folder; kept so a reload or a restart opens the same ones. */
const unfolded = new Set(load('unfolded', []))
/** Files folded away inside an unfolded diff, by `<top>\0<path>`. */
const foldedFiles = new Set()
let sessions = []
let projects = null
let at = 0
let error = ''
/** Diffs fetched for unfolded worktrees: top -> { sig, files, cut, unread, error, loading }. */
const diffs = new Map()
let backendState = 'starting'
/** The Worktrees tab: the last answer, the filter, the armed button, each row's last result, and diffs against main by path. */
let wt = null
let wtError = ''
let wtFilter = load('wtFilter', 'all')
let armed = null
let armTimer = null
const results = new Map()
const mainDiffs = new Map()
/** The write running now (its button's key), so a row says so and nothing else is pressed meanwhile. */
let acting = ''
/** The History tab: the last answer, its filter, how many commits to ask for, commits unfolded and their diffs by sha. */
let hist = null
let histError = ''
let histFilter = load('histFilter', 'all')
let histLimit = HIST_PAGE
const openCommits = new Set()
const commitDiffs = new Map()
/** The last answer drawn, to tell a poll that changed nothing. */
let drawn = ''

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null')
    return v ?? fallback
  } catch {
    return fallback
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // it still works; it just forgets
  }
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v === true ? '' : v)
  }
  // A condition leaves null or false behind; the DOM would draw them as words.
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k)
  return e
}

function problem(text) {
  problemBox.textContent = text
  problemBox.hidden = !text
}

// ---- asking the backend

let asking = null
let again = false
/** Asks for every open session's changes; a call made while one is out runs once more after it. */
async function refresh() {
  if (asking) {
    again = true
    return asking
  }
  asking = (async () => {
    try {
      const ids = openIds(sessions)
      const r = ids.length ? await ws.backend.call('changes', { sessions: ids }) : { projects: [], at: Date.now() }
      projects = r.projects
      at = r.at
      error = ''
      const fetched = await refreshDiffs()
      // A poll that found nothing new draws nothing: an unfolded diff can be thousands of rows.
      const now = JSON.stringify(projects)
      if (fetched || now !== drawn) render()
      drawn = now
    } catch (e) {
      error = e.message
      drawn = ''
      render()
    }
  })()
  try {
    await asking
  } finally {
    asking = null
    if (again) {
      again = false
      void refresh()
    }
  }
}

/** Fetches each unfolded worktree's diff again when its changes moved since the last one (or `force`); says whether any was. */
async function refreshDiffs(force = false) {
  const now = worktreesOf(projects)
  let fetched = false
  await Promise.all(
    [...unfolded].map(async (top) => {
      const w = now.get(top)
      if (!w || w.error || !w.count) return
      const sig = signature(w)
      const had = diffs.get(top)
      if (!force && had && had.sig === sig && !had.error) return
      fetched = true
      try {
        const d = await ws.backend.call('diff', { session: w.sessions[0].id })
        diffs.set(top, { sig, ...d })
      } catch (e) {
        diffs.set(top, { sig, files: [], error: e.message })
      }
    })
  )
  return fetched
}

async function toggle(w) {
  if (unfolded.has(w.top)) unfolded.delete(w.top)
  else unfolded.add(w.top)
  save('unfolded', [...unfolded])
  render()
  if (unfolded.has(w.top)) {
    await refreshDiffs()
    render()
  }
}

// ---- when to ask

let timer = null
const canSee = () => document.visibilityState === 'visible'
/** Polls only while Changes or Worktrees is up and the page can be seen; nothing runs otherwise. */
function schedule() {
  clearInterval(timer)
  timer = null
  if (!canSee() || backendState === 'failed') return
  if (tab === 'changes') timer = setInterval(() => void refresh(), POLL_MS)
  else if (tab === 'worktrees') timer = setInterval(() => void refreshWorktrees(), WT_POLL_MS)
  else if (tab === 'history') timer = setInterval(() => void refreshHistory(), HIST_POLL_MS)
}
/** Asks again for the tab that is up. */
function refreshTab() {
  if (tab === 'changes') return refresh()
  if (tab === 'worktrees') return refreshWorktrees()
  if (tab === 'history') return refreshHistory()
}
document.addEventListener('visibilitychange', () => {
  schedule()
  if (canSee()) void refreshTab()
})

let lastKey = ''
let soon = null
function onSessions(list) {
  sessions = list
  const key = sessionsKey(list)
  if (key === lastKey) return
  lastKey = key
  render()
  // A session opened or closed, or its status moved (it went quiet after a turn): ask now, once.
  clearTimeout(soon)
  soon = setTimeout(() => {
    if (!canSee()) return
    if (tab === 'worktrees') return void refreshWorktrees()
    if (tab === 'history') return void refreshHistory()
    if (tab !== 'changes') return
    // Counts can stay the same while the lines change: a session's turn ending refetches the diffs.
    for (const d of diffs.values()) d.sig = ''
    void refresh()
  }, 300)
}

// ---- drawing

function render() {
  drawBar()
  document.body.classList.toggle('pane', ws.view !== 'tile')
  const t = totals(projects)
  void ws.head.set({ badge: badgeOf(t.files) }).catch(() => {})
  if (backendState === 'failed') problem('The git helper stopped. Turn the tile off and on again to restart it.')
  else problem(error ? `Could not read git: ${error}` : '')
  if (tab === 'worktrees') {
    drawWorktreesTab()
    return
  }
  if (tab === 'history') {
    drawHistoryTab()
    return
  }
  if (tab !== 'changes') {
    body.replaceChildren(el('div', { class: 'coming' }, el('p', { class: 'coming-title' }, 'Coming'), el('p', {}, COMING[tab])))
    return
  }
  if (!projects) {
    body.replaceChildren(el('p', { class: 'muted empty' }, 'Reading…'))
    return
  }
  if (!projects.length) {
    body.replaceChildren(el('p', { class: 'muted empty' }, 'No sessions open. Each session’s changes show here, by project.'))
    return
  }
  body.replaceChildren(...projects.map(drawProject))
}

function drawBar() {
  // replaceChildren draws a null as the word "null": what a condition left out is dropped first (model.js shown).
  const parts = [
    el(
      'nav',
      { class: 'tabs' },
      TABS.map(([id, label]) =>
        el(
          'button',
          {
            class: id === tab ? 'on' : undefined,
            'data-tab': id,
            onclick: () => {
              tab = id
              save('tab', tab)
              schedule()
              render()
              void refreshTab()
            }
          },
          label
        )
      )
    ),
    el('span', { class: 'spacer' }),
    tab === 'worktrees'
      ? el(
          'span',
          { class: 'filter' },
          [
            ['all', 'All'],
            ['stale', 'Stale']
          ].map(([id, label]) =>
            el(
              'button',
              {
                class: wtFilter === id ? 'on' : undefined,
                'data-filter': id,
                title: id === 'stale' ? 'Worktrees with no session that are merged, untouched for 14 days, or whose folder is gone' : undefined,
                onclick: () => {
                  wtFilter = id
                  save('wtFilter', wtFilter)
                  render()
                }
              },
              label
            )
          )
        )
      : null,
    tab === 'history'
      ? el(
          'span',
          { class: 'filter' },
          [
            ['all', 'All'],
            ['today', 'Today, by session']
          ].map(([id, label]) =>
            el(
              'button',
              {
                class: histFilter === id ? 'on' : undefined,
                'data-hfilter': id,
                title: id === 'today' ? 'The last 24 hours of commits in every project, grouped by the session that made them' : undefined,
                onclick: () => {
                  histFilter = id
                  save('histFilter', histFilter)
                  render()
                }
              },
              label
            )
          )
        )
      : null,
    (tab === 'changes' && at) || (tab === 'worktrees' && wt) || (tab === 'history' && hist)
      ? el('span', { class: 'muted when', title: new Date(tab === 'changes' ? at : tab === 'worktrees' ? wt.at : hist.at).toLocaleTimeString() }, 'live')
      : null
  ]
  bar.replaceChildren(...shown(parts))
}

function drawProject(p) {
  return el(
    'section',
    { class: 'project' },
    el('div', { class: 'project-head', title: p.root }, el('span', { class: 'project-name' }, p.name), el('span', { class: 'muted path' }, `\u200e${p.root}`)),
    p.worktrees.map(drawWorktree),
    p.outside.map((s) => el('div', { class: 'line outside muted', title: s.folder }, el('span', { class: 'who' }, s.name), ' · not in a git repository'))
  )
}

function statusDot(id) {
  const s = sessions.find((x) => x.id === id)
  return el('span', { class: `dot ${s?.status ?? 'unknown'}`, title: s?.status ?? '' })
}

function drawWorktree(w) {
  const open = unfolded.has(w.top)
  const clean = !w.error && !w.count
  const head = el(
    'button',
    {
      class: `line${open ? ' open' : ''}${clean ? ' clean' : ''}`,
      'data-top': w.top,
      'aria-expanded': clean ? undefined : String(open),
      disabled: clean || !!w.error,
      onclick: () => void toggle(w)
    },
    el(
      'span',
      { class: 'row1' },
      el('span', { class: 'caret' }, clean || w.error ? '' : open ? '▾' : '▸'),
      el('span', { class: 'branch' }, branchLabel(w.branch) || w.name),
      w.main ? null : el('span', { class: 'muted tag', title: w.top }, `worktree ${w.name}`),
      el('span', { class: 'spacer' }),
      w.error ? null : clean ? el('span', { class: 'muted' }, 'clean') : [el('span', { class: 'add' }, `+${w.add}`), el('span', { class: 'del' }, `−${w.del}`)]
    ),
    el(
      'span',
      { class: 'row2' },
      w.sessions.map((s) => statusDot(s.id)),
      el('span', { class: 'who' }, names(w.sessions)),
      w.sessions.length > 1 ? el('span', { class: 'muted' }, ' · one working tree') : null,
      el('span', { class: 'spacer' }),
      w.error ? el('span', { class: 'err' }, w.error) : clean ? null : el('span', { class: 'muted count' }, filesLabel(w))
    )
  )
  return el('div', { class: 'worktree' }, head, open && !clean && !w.error ? drawChanges(w) : null)
}

function drawChanges(w) {
  const d = diffs.get(w.top)
  const list = el(
    'ul',
    { class: 'files' },
    w.files.map((f) =>
      el(
        'li',
        { class: 'file-row', title: f.from ? `${f.from} → ${f.path}` : f.path },
        el('span', { class: `letter k-${f.kind}` }, LETTER[f.kind] ?? 'M'),
        el('span', { class: 'fpath' }, f.path),
        el('span', { class: 'spacer' }),
        f.binary ? el('span', { class: 'muted' }, 'binary') : [el('span', { class: 'add' }, num(f.add) && `+${f.add}`), el('span', { class: 'del' }, num(f.del) && `−${f.del}`)]
      )
    ),
    w.hidden ? el('li', { class: 'muted note' }, `and ${w.hidden} more not listed`) : null
  )
  const diffBox = !d
    ? el('p', { class: 'muted note' }, 'Reading the diff…')
    : d.error
      ? el('p', { class: 'err note' }, d.error)
      : el(
          'div',
          { class: 'diffs' },
          d.files.map((f) => drawFile(w.top, f)),
          d.cut ? el('p', { class: 'muted note' }, 'The diff was too long to read whole; the rest is not shown.') : null,
          d.unread ? el('p', { class: 'muted note' }, `${d.unread} more untracked files not shown.`) : null
        )
  return el('div', { class: 'changes' }, list, diffBox)
}

function drawFile(top, f) {
  const key = `${top}\0${f.path}`
  const folded = foldedFiles.has(key)
  return el(
    'div',
    { class: 'dfile' },
    el(
      'button',
      {
        class: 'dfile-head',
        onclick: () => {
          if (folded) foldedFiles.delete(key)
          else foldedFiles.add(key)
          render()
        }
      },
      el('span', { class: 'caret' }, folded ? '▸' : '▾'),
      el('span', { class: 'fpath' }, f.from ? `${f.from} → ${f.path}` : f.path),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted' }, f.status)
    ),
    folded
      ? null
      : f.binary
        ? el('p', { class: 'muted note' }, 'Binary file, not shown.')
        : !f.hunks.length
          ? el('p', { class: 'muted note' }, f.truncated ? 'Not shown: the diff was long enough already.' : f.status === 'renamed' ? 'Renamed, contents unchanged.' : 'No changes to its lines (its mode, or an empty file).')
          : el(
              'div',
              { class: 'code' },
              el('div', { class: 'code-in' }, f.hunks.map((h) => [
                el('div', { class: 'hunk' }, `@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, h.section ? el('span', { class: 'section' }, ` ${h.section}`) : null),
                numbered(h).map((l) =>
                  el(
                    'div',
                    { class: `l ${l.t === '+' ? 'a' : l.t === '-' ? 'd' : l.t === '\\' ? 'nn' : 'c'}` },
                    el('span', { class: 'no' }, l.o ?? ''),
                    el('span', { class: 'no' }, l.n ?? ''),
                    el('span', { class: 'mk' }, l.t === '\\' ? '' : l.t),
                    el('span', { class: 's' }, l.s)
                  )
                )
              ])),
              f.truncated ? el('div', { class: 'muted note' }, f.cutLines ? `${f.cutLines} more lines not shown.` : 'The rest is not shown.') : null
            )
  )
}

// ---- the Worktrees tab

let wtAsking = null
let wtAgain = false
/** Asks for every worktree of the open sessions' projects; a call made while one is out runs once more after it. */
async function refreshWorktrees() {
  if (wtAsking) {
    wtAgain = true
    return wtAsking
  }
  wtAsking = (async () => {
    try {
      const ids = openIds(sessions)
      const r = ids.length ? await ws.backend.call('worktrees', { sessions: ids }) : { projects: [], at: Date.now() }
      const changed = JSON.stringify(r.projects) !== JSON.stringify(wt?.projects)
      wt = r
      const hadError = !!wtError
      wtError = ''
      // A diff against main that is open is read again when its worktree moved.
      let fetched = false
      for (const [path, d] of mainDiffs) {
        const w = findWorktree(path)
        if (!w) mainDiffs.delete(path)
        else if (d.sig !== wtSig(w)) {
          fetched = true
          await loadMainDiff(w.root, w)
        }
      }
      if (tab === 'worktrees' && (changed || fetched || hadError)) render()
    } catch (e) {
      wtError = e.message
      if (tab === 'worktrees') render()
    }
  })()
  try {
    await wtAsking
  } finally {
    wtAsking = null
    if (wtAgain) {
      wtAgain = false
      void refreshWorktrees()
    }
  }
}

/** A worktree in the last answer, with its project's root and main. */
function findWorktree(path) {
  for (const p of wt?.projects ?? []) for (const w of p.worktrees) if (w.path === path) return { ...w, root: p.root, base: p.base }
  return null
}
const wtSig = (w) => `${w.head}|${w.base?.oid}|${w.dirty}`

async function loadMainDiff(root, w) {
  try {
    const d = await ws.backend.call('diffmain', { root, path: w.path })
    mainDiffs.set(w.path, { sig: wtSig(w), ...d })
  } catch (e) {
    mainDiffs.set(w.path, { sig: wtSig(w), files: [], error: e.message })
  }
}

async function toggleMainDiff(p, w) {
  if (mainDiffs.has(w.path)) {
    mainDiffs.delete(w.path)
    render()
    return
  }
  mainDiffs.set(w.path, { sig: '', loading: true, files: [] })
  render()
  await loadMainDiff(p.root, { ...w, base: p.base })
  render()
}

/** The new-session form, filled in; the user presses Start. Only a real click reaches here, which core requires. */
async function launch(key, opts) {
  try {
    await ws.sessions.launch(opts)
    results.set(key, { ok: true, said: 'The new-session form is open in the center: press Start.' })
  } catch (e) {
    results.set(key, { ok: false, said: e.message })
  }
  render()
}

/**
 * A destructive button: the first click arms it red for ARM_MS, the second within that time acts
 * (CLAUDE.md §4). `key` is `<op> <path>`.
 */
function arming(op, p, w) {
  const key = `${op} ${w.path}`
  const r = press(armed, key)
  armed = r.armed
  clearTimeout(armTimer)
  if (!r.act) {
    armTimer = setTimeout(() => {
      armed = null
      render()
    }, ARM_MS + 50)
    render()
    return
  }
  void act(op, p, w)
}

async function act(op, p, w) {
  if (acting) return
  acting = `${op} ${w.path}`
  results.delete(w.path)
  render()
  try {
    const r = await ws.backend.call(op, { root: p.root, path: w.path, expect: { head: w.head, base: p.base?.oid ?? null } })
    results.set(w.path, { ok: !!r.done, said: r.said, files: r.files })
  } catch (e) {
    results.set(w.path, { ok: false, said: e.message })
  }
  acting = ''
  mainDiffs.delete(w.path)
  await refreshWorktrees()
  render()
}

const LABEL = { rebase: 'Rebase', merge: 'Merge', remove: 'Remove' }
const ARMED_LABEL = { rebase: 'Rebase? Click again', merge: 'Merge? Click again', remove: 'Remove? Click again' }
const TITLE = {
  rebase: (b) => `Rebase this branch onto ${b}. Refused if it has uncommitted changes or its session is busy; a conflict is undone at once.`,
  merge: (b) => `Merge this branch into ${b}, in the worktree ${b} is checked out in. Refused if either has uncommitted changes or a session there is busy; a conflict is undone at once.`,
  remove: (b) => `Remove this worktree and delete its branch, only if ${b} has every commit on it. Never forced.`
}

function drawWorktreesTab() {
  if (wtError && !wt) {
    body.replaceChildren(el('p', { class: 'err empty' }, `Could not read the worktrees: ${wtError}`))
    return
  }
  if (!wt) {
    body.replaceChildren(el('p', { class: 'muted empty' }, 'Reading…'))
    return
  }
  if (!wt.projects.length) {
    body.replaceChildren(el('p', { class: 'muted empty' }, 'No sessions open. The worktrees of each session’s project show here.'))
    return
  }
  const drawn = wt.projects.map(drawWtProject).filter(Boolean)
  body.replaceChildren(...(drawn.length ? drawn : [el('p', { class: 'muted empty' }, 'No stale worktrees: every one has a session, or unmerged work touched in the last 14 days.')]))
}

function drawWtProject(p) {
  const rows = filtered(p.worktrees, wtFilter)
  if (wtFilter === 'stale' && !rows.length) return null
  const over = projectOverlaps(p)
  return el(
    'section',
    { class: 'project wt-project', 'data-root': p.root },
    el(
      'div',
      { class: 'project-head', title: p.root },
      el('span', { class: 'project-name' }, p.name),
      el('span', { class: 'muted path' }, `‎${p.root}`),
      el('span', { class: 'spacer' }),
      ws.sessions.launch && !p.error
        ? el(
            'button',
            { class: 'act', 'data-act': 'newchat', title: 'Open the new-session form for this project, with a new worktree ticked. You press Start.', onclick: () => void launch(`newchat ${p.root}`, { folder: p.root, worktree: {} }) },
            'New chat in a worktree'
          )
        : null
    ),
    p.error ? el('p', { class: 'err note' }, p.error) : null,
    !p.error && !p.base ? el('p', { class: 'muted note' }, 'No main or master branch here, so nothing to compare with.') : null,
    p.base ? el('p', { class: 'muted note base', title: p.base.how }, `Compared with ${p.base.remote ? 'origin/' : ''}${p.base.name} (${p.base.how}).`) : null,
    results.get(`newchat ${p.root}`) ? drawResult(results.get(`newchat ${p.root}`)) : null,
    over.map((o) =>
      el(
        'p',
        { class: 'overlap', title: o.files.join('\n') },
        el('span', { class: 'warn' }, '⚠ '),
        `${o.a} and ${o.b} both touch ${o.count === 1 ? o.files[0] : `${o.count} files: ${o.files.slice(0, 3).join(', ')}${o.count > 3 ? '…' : ''}`}`
      )
    ),
    rows.map((w) => drawWtRow(p, w))
  )
}

function drawResult(r) {
  return el(
    'div',
    { class: `result ${r.ok ? 'ok' : 'bad'}` },
    r.said,
    r.files?.length ? el('ul', { class: 'conflicts' }, r.files.slice(0, 20).map((f) => el('li', { class: 'fpath' }, f))) : null
  )
}

function drawWtRow(p, w) {
  const can = actionsFor(w, p.base)
  const dangerous = (op) => {
    const key = `${op} ${w.path}`
    const on = isArmed(armed, key)
    return el(
      'button',
      {
        class: `act danger${on ? ' armed' : ''}`,
        'data-act': op,
        title: TITLE[op](p.base?.name ?? 'main'),
        disabled: !!acting,
        onclick: () => arming(op, p, w)
      },
      acting === key ? `${LABEL[op]}…` : on ? ARMED_LABEL[op] : LABEL[op]
    )
  }
  const md = mainDiffs.get(w.path)
  const res = results.get(w.path)
  return el(
    'div',
    { class: 'wt', 'data-path': w.path },
    el(
      'div',
      { class: 'wt-head' },
      el(
        'span',
        { class: 'row1' },
        el('span', { class: 'branch' }, w.branch ?? (w.head ? `detached at ${w.head.slice(0, 7)}` : w.bare ? 'bare' : 'no commits yet')),
        w.main ? el('span', { class: 'muted tag' }, 'main worktree') : null,
        w.locked != null ? el('span', { class: 'muted tag', title: w.locked || 'locked' }, 'locked') : null,
        w.stale ? el('span', { class: 'tag stale' }, STALE_WORDS[w.stale]) : null,
        el('span', { class: 'spacer' }),
        el('span', { class: 'muted vs' }, versusBase(w, p.base)),
        el('span', { class: `state ${w.dirty ? 'dirty' : 'clean'}` }, w.error ? '' : dirtyLabel(w))
      ),
      el(
        'span',
        { class: 'row2' },
        w.sessions.length ? [w.sessions.map((s) => statusDot(s.id)), el('span', { class: 'who' }, names(w.sessions))] : el('span', { class: 'muted who' }, 'no session'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'muted path', title: w.path }, `‎${w.short}`)
      ),
      w.error ? el('span', { class: 'err' }, w.error) : null,
      w.prunable != null ? el('span', { class: 'muted' }, `Its folder is gone${w.prunable ? ` (${w.prunable})` : ''}; git worktree prune tidies it.`) : null
    ),
    el(
      'div',
      { class: 'acts' },
      can.diff ? el('button', { class: `act${md ? ' on' : ''}`, 'data-act': 'diff', title: `What this worktree would bring to ${p.base.name}: its commits and uncommitted changes since they parted`, onclick: () => void toggleMainDiff(p, w) }, `Diff vs ${p.base.name}`) : null,
      can.open && ws.sessions.launch ? el('button', { class: 'act', 'data-act': 'open', title: 'Open the new-session form in this worktree. You press Start.', onclick: () => void launch(w.path, { folder: w.path }) }, 'Open a session') : null,
      can.rebase ? dangerous('rebase') : null,
      can.merge ? dangerous('merge') : null,
      can.remove ? dangerous('remove') : null
    ),
    res ? drawResult(res) : null,
    md ? drawMainDiff(w, md) : null
  )
}

function drawMainDiff(w, d) {
  if (d.loading) return el('p', { class: 'muted note' }, 'Reading the diff…')
  if (d.error) return el('p', { class: 'err note' }, d.error)
  if (!d.files.length) return el('p', { class: 'muted note' }, 'No changes to tracked files.')
  return el('div', { class: 'diffs' }, d.files.map((f) => drawFile(`main ${w.path}`, f)), d.cut ? el('p', { class: 'muted note' }, 'The diff was too long to read whole; the rest is not shown.') : null)
}


// ---- the History tab

let histAsking = null
let histAgain = false
/** Asks for the log of every open session's project; a call made while one is out runs once more after it. */
async function refreshHistory() {
  if (histAsking) {
    histAgain = true
    return histAsking
  }
  histAsking = (async () => {
    try {
      const ids = openIds(sessions)
      const r = ids.length ? await ws.backend.call('history', { sessions: ids, limit: histLimit }) : { projects: [], at: Date.now() }
      const changed = JSON.stringify(r.projects) !== JSON.stringify(hist?.projects)
      const hadError = !!histError
      hist = r
      histError = ''
      if (tab === 'history' && (changed || hadError)) render()
    } catch (e) {
      histError = e.message
      if (tab === 'history') render()
    }
  })()
  try {
    await histAsking
  } finally {
    histAsking = null
    if (histAgain) {
      histAgain = false
      void refreshHistory()
    }
  }
}

/** A commit's diff is fetched once: a commit never changes. */
async function toggleCommit(root, c) {
  if (openCommits.has(c.sha)) {
    openCommits.delete(c.sha)
    render()
    return
  }
  openCommits.add(c.sha)
  if (!commitDiffs.has(c.sha) || commitDiffs.get(c.sha).error) {
    commitDiffs.set(c.sha, { loading: true, files: [] })
    render()
    try {
      commitDiffs.set(c.sha, await ws.backend.call('commit', { root, sha: c.sha }))
    } catch (e) {
      commitDiffs.set(c.sha, { files: [], error: e.message })
    }
  }
  render()
}

function drawHistoryTab() {
  if (histError && !hist) {
    body.replaceChildren(el('p', { class: 'err empty' }, `Could not read the history: ${histError}`))
    return
  }
  if (!hist) {
    body.replaceChildren(el('p', { class: 'muted empty' }, 'Reading…'))
    return
  }
  if (!hist.projects.length) {
    body.replaceChildren(el('p', { class: 'muted empty' }, 'No sessions open. The history of each session’s project shows here.'))
    return
  }
  if (histFilter === 'today') {
    const groups = todayBySession(hist.projects)
    const many = hist.projects.length > 1
    body.replaceChildren(
      ...(groups.length
        ? groups.map((g) =>
            el(
              'section',
              { class: `project hgroup ${g.kind}`, 'data-group': g.key },
              el(
                'div',
                { class: 'project-head' },
                g.kind === 'session' ? statusDot(g.key.slice(2)) : null,
                el('span', { class: g.kind === 'session' ? 'project-name' : 'project-name muted' }, g.label),
                many || g.kind !== 'session' ? el('span', { class: 'muted' }, g.project) : null,
                el('span', { class: 'spacer' }),
                el('span', { class: 'muted count' }, groupCount(g))
              ),
              g.commits.map((c) => drawCommit(g.root, c, { inGroup: g.kind === 'session' }))
            )
          )
        : [el('p', { class: 'muted empty' }, 'No commits in the last 24 hours.')])
    )
    return
  }
  body.replaceChildren(
    ...hist.projects.map((p) =>
      el(
        'section',
        { class: 'project hproject', 'data-root': p.root },
        el('div', { class: 'project-head', title: p.root }, el('span', { class: 'project-name' }, p.name), el('span', { class: 'muted path' }, `\u200e${p.root}`)),
        p.error ? el('p', { class: 'err note' }, p.error) : null,
        !p.error && !p.commits.length ? el('p', { class: 'muted note' }, 'No commits yet.') : null,
        p.commits.map((c) => drawCommit(p.root, c)),
        p.more
          ? el(
              'button',
              {
                class: 'act more',
                'data-act': 'more',
                disabled: histLimit >= 3000,
                onclick: () => {
                  histLimit += HIST_PAGE
                  void refreshHistory()
                }
              },
              histLimit >= 3000 ? 'Showing the newest 3,000' : `Show ${HIST_PAGE} more`
            )
          : null
      )
    )
  )
}

/** One commit: its subject, short sha and when; its refs; and who made it. A click unfolds its diff. */
function drawCommit(root, c, { inGroup = false } = {}) {
  const open = openCommits.has(c.sha)
  // Inside its own session's group an exact tag would only repeat the group's name; a guess still says so.
  const tag = c.by && !(inGroup && c.by.kind === 'exact') ? el('span', { class: `by ${c.by.kind}`, title: byTitle(c.by) }, byLabel(c.by)) : null
  const when = new Date(c.ct)
  return el(
    'div',
    { class: 'commit', 'data-sha': c.sha },
    el(
      'button',
      { class: `line${open ? ' open' : ''}`, 'aria-expanded': String(open), onclick: () => void toggleCommit(root, c) },
      el(
        'span',
        { class: 'row1' },
        el('span', { class: 'caret' }, open ? '▾' : '▸'),
        el('span', { class: 'subject' }, c.subject || '(no message)'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'muted sha' }, c.sha.slice(0, 7))
      ),
      el(
        'span',
        { class: 'row2' },
        tag,
        c.parents.length > 1 ? el('span', { class: 'muted tag' }, 'merge') : null,
        refsShown(c.refs).map((r) => el('span', { class: `ref ${r.kind}` }, r.kind === 'tag' ? `tag ${r.name}` : r.name)),
        el('span', { class: 'spacer' }),
        el('span', { class: 'muted ago', title: `${when.toLocaleString()} · ${c.author}` }, ago(c.ct))
      )
    ),
    open ? drawCommitDiff(c) : null
  )
}

function drawCommitDiff(c) {
  const d = commitDiffs.get(c.sha)
  if (!d || d.loading) return el('p', { class: 'muted note' }, 'Reading the diff…')
  if (d.error) return el('p', { class: 'err note' }, d.error)
  if (!d.files.length) return el('p', { class: 'muted note' }, c.parents.length > 1 ? 'This merge brought no changes of its own.' : 'No changes to files.')
  return el('div', { class: 'diffs' }, d.files.map((f) => drawFile(`commit ${c.sha}`, f)), d.cut ? el('p', { class: 'muted note' }, 'The diff was too long to read whole; the rest is not shown.') : null)
}

// ---- the door: a session asks for its changes to be shown

ws.door?.handle('show', async (_args, caller, { session }) => {
  tab = 'changes'
  save('tab', tab)
  await refresh()
  const w = session ? worktreeOfSession(projects, session) : null
  if (w && w.count) {
    unfolded.add(w.top)
    save('unfolded', [...unfolded])
    await refreshDiffs()
    render()
  }
  await ws.openPane().catch(() => {})
  if (!w) return { shown: false, why: session ? `${caller} is not working in a git repository` : 'call this from a session' }
  return { shown: true, branch: w.branch?.head ?? null, files: w.count, add: w.add, del: w.del }
})

// ---- start

ws.onViewChange(() => {
  render()
  void refreshTab()
})
// Core recorded a commit a session made: the History tab looks again at once.
ws.backend.onEvent?.((e) => {
  if (e?.name === 'commits' && tab === 'history' && canSee()) void refreshHistory()
})
ws.backend.onStatus((s) => {
  const was = backendState
  backendState = s?.state ?? 'starting'
  schedule()
  if (backendState === 'running' && was !== 'running') void refreshTab()
  else render()
})
ws.sessions.watch(onSessions)
backendState = (await ws.backend.status())?.state ?? 'starting'
sessions = await ws.sessions.list()
lastKey = sessionsKey(sessions)
render()
schedule()
await refresh()
if (tab === 'worktrees') await refreshWorktrees()
if (tab === 'history') await refreshHistory()
window.gitReady = true
