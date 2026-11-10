// The Git tile: what every open session has changed, by project. Plain JavaScript, no build. The
// rules are in model.js; the git work is the backend's (../backend.mjs, the trusted tier), which
// this page reaches through `workshop.backend` naming sessions by id, never by path. Read-only.
//
// What it uses of the contract: backend (changes, diff), sessions read (which sessions are open,
// and when one goes quiet), view (poll only while the page can be seen; the pane gives diffs room),
// head (the count of changed files), door (`show`: a session asks for its changes to be shown).

import { LETTER, branchLabel, filesLabel, names, num, numbered, openIds, sessionsKey, signature, totals, worktreeOfSession, worktreesOf } from './model.js'

const ws = window.workshop
const $ = (id) => document.getElementById(id)
const bar = $('bar')
const body = $('body')
const problemBox = $('problem')

/** How often the Changes tab asks again while it can be seen. A session going quiet asks at once. */
const POLL_MS = 4000
const TABS = [
  ['changes', 'Changes'],
  ['worktrees', 'Worktrees'],
  ['history', 'History'],
  ['prs', 'PRs']
]
const COMING = {
  worktrees: 'A row per worktree: its session, its branch, ahead and behind main, dirty or clean. Then opening a session in one, diffing against main, rebasing, merging and removing it once merged.',
  history: 'The commit log across branches, each commit tagged with the session that made it, and a “what did Claude do today” filter.',
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
/** Polls only while the Changes tab is up and the page can be seen; nothing runs otherwise. */
function schedule() {
  clearInterval(timer)
  timer = null
  if (tab === 'changes' && canSee() && backendState !== 'failed') timer = setInterval(() => void refresh(), POLL_MS)
}
document.addEventListener('visibilitychange', () => {
  schedule()
  if (canSee() && tab === 'changes') void refresh()
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
    if (!canSee() || tab !== 'changes') return
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
  void ws.head.set({ badge: t.files ? String(t.files) : '' }).catch(() => {})
  if (backendState === 'failed') problem('The git helper stopped. Turn the tile off and on again to restart it.')
  else problem(error ? `Could not read git: ${error}` : '')
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
  bar.replaceChildren(
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
              if (tab === 'changes') void refresh()
            }
          },
          label
        )
      )
    ),
    el('span', { class: 'spacer' }),
    tab === 'changes' && at ? el('span', { class: 'muted when', title: new Date(at).toLocaleTimeString() }, 'live') : null
  )
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
  if (tab === 'changes') void refresh()
})
ws.backend.onStatus((s) => {
  const was = backendState
  backendState = s?.state ?? 'starting'
  schedule()
  if (backendState === 'running' && was !== 'running') void refresh()
  else render()
})
ws.sessions.watch(onSessions)
backendState = (await ws.backend.status())?.state ?? 'starting'
sessions = await ws.sessions.list()
lastKey = sessionsKey(sessions)
render()
schedule()
await refresh()
window.gitReady = true
