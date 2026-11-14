// The Worktrees tab as a board: Working, Ready to merge, Idle, Stale. Each card draws how far its
// branch is behind and ahead of main (Fork's divergence), offers what can be done there (each
// destructive action two clicks, CLAUDE.md §4), and the project's operation log undoes a step
// (jj's op log, lazygit's undo).

import { S, act, arm, armedNow, render, save, say, ws } from './app.js'
import { el } from './dom.js'
import { drawFiles } from './diffview.js'
import { BOARD, STALE_WORDS, actionsFor, bandOf, boardGroup, dirtyLabel, divergence, filtered, names, projectOverlaps, versusBase, when } from './model.js'
import { loadMainDiff, refreshOplog, refreshWorktrees, afterWrite, refreshPrs } from './data.js'
import { statusMark } from './lanes.js'

const LABEL = { rebase: 'Rebase', merge: 'Merge', remove: 'Remove', openpr: 'Open PR' }
const TITLE = {
  rebase: (b) => `Rebase this branch onto ${b}. Refused if it has uncommitted changes or its session is busy; a conflict is undone at once. Undo puts it back.`,
  merge: (b) => `Merge this branch into ${b}, in the worktree ${b} is checked out in. Refused if either has uncommitted changes or a session there is busy; a conflict is undone at once. Undo puts ${b} back.`,
  remove: (b) => `Remove this worktree and delete its branch, only if ${b} has every commit on it. Never forced. Undo restores both.`,
  openpr: (b) => `Push this branch to origin (never forced) and open a pull request into ${b}, titled from its commits.`
}

async function launch(key, opts) {
  try {
    await ws.sessions.launch(opts)
    S.results.set(key, { ok: true, said: 'The new-session form is open in the center: press Start.' })
  } catch (e) {
    S.results.set(key, { ok: false, said: e.message })
  }
  render()
}

/** A worktree write: its result shown on its card, then everything read again. */
async function wtAct(op, p, w) {
  const key = `${op} ${w.path}`
  S.results.delete(w.path)
  const body = op === 'openpr' ? { root: p.root, path: w.path } : { root: p.root, path: w.path, expect: { head: w.head, base: p.base?.oid ?? null } }
  if (S.acting) return
  S.acting = key
  render()
  try {
    const r = await ws.backend.call(op, body)
    S.results.set(w.path, { ok: op === 'openpr' ? true : !!r.done, said: r.said, files: r.files })
    if (r.url) void ws.openExternal(r.url).catch(() => {})
  } catch (e) {
    S.results.set(w.path, { ok: false, said: e.message })
  }
  S.acting = ''
  S.mainDiffs.delete(w.path)
  await refreshWorktrees()
  void refreshOplog()
  if (op === 'openpr') void refreshPrs()
  render()
}

async function toggleMainDiff(p, w) {
  if (S.mainDiffs.has(w.path)) {
    S.mainDiffs.delete(w.path)
    render()
    return
  }
  S.mainDiffs.set(w.path, { sig: '', loading: true, files: [] })
  render()
  await loadMainDiff(p.root, { ...w, base: p.base })
  render()
}

export function drawResult(r) {
  return el('div', { class: `result ${r.ok ? 'ok' : 'bad'}` }, r.said, r.files?.length ? el('ul', {}, r.files.slice(0, 20).map((f) => el('li', {}, f))) : null)
}

/** A divergence bar: main's commits this branch lacks on the left, its own on the right, the fork between. */
function divBar(w, base) {
  if (!base || w.isBase || w.ahead == null) return null
  const d = divergence(w)
  return el(
    'div',
    { class: 'div', title: `${w.behind} commit${w.behind === 1 ? '' : 's'} on ${base.name} it lacks; ${w.ahead} of its own` },
    el('div', { class: 'blocks', 'aria-hidden': 'true' }, el('div', { class: 'left' }, Array.from({ length: d.behind }, () => el('span', { class: 'b' }))), el('span', { class: 'fork' }), el('div', { class: 'right' }, Array.from({ length: d.ahead }, () => el('span', { class: 'b' })))),
    el('span', { class: 'vs' }, versusBase(w, base))
  )
}

function card(p, w) {
  const can = actionsFor(w, p.base)
  const prs = S.prs.get(p.root)?.prs ?? []
  const hasPr = !!w.branch && prs.some((x) => x.head === w.branch)
  const canPr = can.diff && !!w.branch && !w.isBase && (w.ahead ?? 0) > 0 && !hasPr
  const dangerous = (op) => {
    const key = `${op} ${w.path}`
    const on = armedNow(key)
    return el(
      'button',
      { class: `act ${op === 'openpr' ? 'go' : 'danger'}${on ? ' armed' : ''}`, 'data-act': op, title: TITLE[op](p.base?.name ?? 'main'), disabled: !!S.acting, onclick: () => arm(key, () => wtAct(op, p, w)) },
      S.acting === key ? `${LABEL[op]}…` : on ? `${LABEL[op]}? Click again` : LABEL[op]
    )
  }
  const md = S.mainDiffs.get(w.path)
  const res = S.results.get(w.path)
  const sessionsHere = w.sessions.map((s) => S.sessions.find((x) => x.id === s.id) ?? s)
  return el(
    'div',
    { class: `wt${w.stale ? ' stale' : ''}`, 'data-path': w.path, 'data-band': bandOf(w, S.sessions) ?? undefined },
    el(
      'div',
      { class: 'sub' },
      el('span', { class: 'branch' }, w.branch ?? (w.head ? `detached at ${w.head.slice(0, 7)}` : w.bare ? 'bare' : 'no commits yet')),
      w.main ? el('span', { class: 'pill' }, 'main worktree') : null,
      w.locked != null ? el('span', { class: 'pill', title: w.locked || 'locked' }, 'locked') : null,
      w.stale ? el('span', { class: 'pill yellow' }, STALE_WORDS[w.stale]) : null,
      el('span', { class: 'spacer' }),
      w.error ? null : el('span', { class: `pill ${w.dirty ? 'yellow' : 'green'}` }, dirtyLabel(w))
    ),
    divBar(w, p.base),
    el(
      'div',
      { class: 'sub' },
      sessionsHere.length ? [sessionsHere.map((s) => statusMark(s.status ?? 'unknown')), el('span', { class: 'who' }, names(w.sessions))] : el('span', {}, 'no session'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'path mono', title: w.path }, w.short)
    ),
    w.error ? el('span', { class: 'err' }, w.error) : null,
    w.prunable != null ? el('span', {}, `Its folder is gone${w.prunable ? ` (${w.prunable})` : ''}; git worktree prune tidies it.`) : null,
    el(
      'div',
      { class: 'acts' },
      can.diff ? el('button', { class: `act${md ? ' on' : ''}`, 'data-act': 'diff', title: `What this worktree would bring to ${p.base.name}: its commits and uncommitted changes since they parted`, onclick: () => void toggleMainDiff(p, w) }, `Diff vs ${p.base.name}`) : null,
      can.open && ws.sessions.launch ? el('button', { class: 'act', 'data-act': 'open', title: 'Open the new-session form in this worktree. You press Start.', onclick: () => void launch(w.path, { folder: w.path }) }, 'Open a session') : null,
      can.rebase ? dangerous('rebase') : null,
      can.merge ? dangerous('merge') : null,
      canPr ? dangerous('openpr') : null,
      can.remove ? dangerous('remove') : null
    ),
    res ? drawResult(res) : null,
    md ? drawFiles({ key: `main ${w.path}`, top: null, empty: 'No changes to tracked files.' }, md) : null
  )
}

/** The project's operation log: newest first, each step that can be undone with Undo (two clicks). */
export function oplogBox(root, { limit = 6 } = {}) {
  const entries = [...(S.oplog.get(root) ?? [])].reverse().slice(0, limit)
  if (!entries.length) return null
  return el(
    'div',
    { class: 'oplog', 'data-root': root },
    el('div', { class: 'row1' }, el('b', {}, 'What the tile did'), el('span', { class: 'spacer' }), el('span', { class: 'muted' }, el('span', { class: 'k' }, '⌘Z'), 'undoes the last')),
    entries.map((e) => {
      const key = `undo ${e.id}`
      const on = armedNow(key)
      return el(
        'div',
        { class: `op${e.undone ? ' undone' : ''}`, 'data-op': e.id },
        el('span', { class: 'mono muted' }, when(e.at)),
        el('span', { class: 'spacer nowrap' }, e.said),
        e.undoable ? el('button', { class: `act small${on ? ' armed' : ''}`, 'data-act': 'undo', disabled: !!S.acting, onclick: () => arm(key, () => undo(root, e)) }, on ? 'Undo? Click again' : e.kind === 'remove' ? 'Restore' : 'Undo') : null
      )
    })
  )
}

export async function undo(root, e) {
  await act(`undo ${e.id}`, 'undo', { root, id: e.id }, async () => {
    await refreshOplog()
    await afterWrite()
    void refreshWorktrees()
  })
}

/** ⌘Z: the newest step that can be undone in the shown project, armed first, then undone. */
export function undoLast(root) {
  const e = [...(S.oplog.get(root) ?? [])].reverse().find((x) => x.undoable)
  if (!e) return say('nothing to undo', false)
  const key = `undo ${e.id}`
  if (!armedNow(key)) say(`press ⌘Z again to undo: ${e.said}`)
  arm(key, () => undo(root, e))
}

export function drawWorktrees() {
  if (S.wtError && !S.wt) return [el('p', { class: 'err empty' }, `Could not read the worktrees: ${S.wtError}`)]
  if (!S.wt) return [el('p', { class: 'muted empty' }, 'Reading…')]
  if (!S.wt.projects.length) return [el('p', { class: 'muted empty' }, 'No sessions open. The worktrees of each session’s project show here.')]
  const out = S.wt.projects
    .map((p) => {
      const rows = filtered(p.worktrees, S.wtFilter)
      if (S.wtFilter === 'stale' && !rows.length) return null
      const over = projectOverlaps(p)
      return el(
        'section',
        { class: 'project wt-project', 'data-root': p.root },
        el(
          'div',
          { class: 'project-head', title: p.root },
          el('span', { class: 'project-name' }, p.name),
          el('span', { class: 'path' }, `‎${p.root}`),
          el('span', { class: 'spacer' }),
          ws.sessions.launch && !p.error ? el('button', { class: 'act primary', 'data-act': 'newchat', title: 'Open the new-session form for this project, with a new worktree ticked. You press Start.', onclick: () => void launch(`newchat ${p.root}`, { folder: p.root, worktree: {} }) }, '＋ New chat in a worktree') : null
        ),
        p.error ? el('p', { class: 'err note' }, p.error) : null,
        !p.error && !p.base ? el('p', { class: 'muted note' }, 'No main or master branch here, so nothing to compare with.') : null,
        p.base ? el('p', { class: 'muted base', title: p.base.how }, `Compared with ${p.base.remote ? 'origin/' : ''}${p.base.name} (${p.base.how}).`) : null,
        S.results.get(`newchat ${p.root}`) ? el('div', { style: { padding: '0 12px' } }, drawResult(S.results.get(`newchat ${p.root}`))) : null,
        over.map((o) => el('div', { class: 'overlap', title: o.files.join('\n') }, el('span', { 'aria-hidden': 'true' }, '⚠'), el('span', {}, `${o.a} and ${o.b} both touch ${o.count === 1 ? o.files[0] : `${o.count} files: ${o.files.slice(0, 3).join(', ')}${o.count > 3 ? '…' : ''}`}. Merge one first, then rebase the other.`))),
        BOARD.map(([g, label]) => {
          const list = rows.filter((w) => boardGroup(w) === g)
          if (!list.length) return null
          return [el('div', { class: 'colhead' }, label, el('span', { class: 'pill' }, String(list.length))), list.map((w) => card(p, w))]
        }),
        S.wtFilter === 'all' ? oplogBox(p.root) : null
      )
    })
    .filter(Boolean)
  return out.length ? out : [el('p', { class: 'muted empty' }, 'No stale worktrees: every one has a session, or unmerged work touched in the last 14 days.')]
}

export const WT_FILTERS = [
  ['all', 'All'],
  ['stale', 'Stale']
]
export function setWtFilter(id) {
  S.wtFilter = id
  save('wtFilter', id)
  render()
}
