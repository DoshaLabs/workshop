// What the Git tile asks its backend for, and when an answer means drawing again. Each refresh is
// single-flight: one asked while another runs runs once more after it, never twice at once. The
// page names sessions by id and projects by the roots core gave sessions; the backend checks both.

import { S, call, render } from './app.js'
import { openIds, signature, worktreesOf } from './model.js'
import { parseQuery } from './query.js'

/** One refresh at a time per name; a call made meanwhile runs once more afterwards. */
function single(fn) {
  let running = null
  let again = false
  const run = async () => {
    if (running) {
      again = true
      return running
    }
    running = fn()
    try {
      await running
    } finally {
      running = null
      if (again) {
        again = false
        void run()
      }
    }
  }
  return run
}

/** Project roots of the open sessions. */
export const roots = () => [...new Set(S.sessions.filter((s) => s.open !== false && s.status !== 'dead').map((s) => s.root).filter(Boolean))]

let drawn = ''
/** Every open session's changes; then the diff of each lane a view shows, when it moved. */
export const refreshChanges = single(async () => {
  try {
    const ids = openIds(S.sessions)
    const r = ids.length ? await call('changes', { sessions: ids }) : { projects: [], at: Date.now() }
    S.projects = r.projects
    S.at = r.at
    S.error = ''
    const fetched = await refreshDiffs()
    // A poll that found nothing new draws nothing: an unfolded diff can be thousands of rows.
    const now = JSON.stringify(S.projects) + JSON.stringify(S.sessions.map((s) => [s.id, s.band, s.status]))
    if (fetched || now !== drawn) render()
    drawn = now
  } catch (e) {
    S.error = e.message
    drawn = ''
    render()
  }
})

/** The tops whose diffs are wanted: the chosen lane in the pane and the whole window. */
export function wantedTops() {
  if (window.workshop.view === 'tile' || S.tab !== 'changes') return []
  const all = worktreesOf(S.projects)
  const chosen = all.get(S.lane) ?? [...all.values()].find((w) => !w.error && w.count) ?? [...all.values()][0]
  return chosen ? [chosen.top] : []
}

/** Fetches a lane's diff again when its changes moved since (or `force`); says whether any was. */
export async function refreshDiffs(force = false) {
  const now = worktreesOf(S.projects)
  let fetched = false
  await Promise.all(
    wantedTops().map(async (top) => {
      const w = now.get(top)
      if (!w || w.error || !w.count) {
        if (S.diffs.has(top) && !w?.count) S.diffs.delete(top)
        return
      }
      const sig = signature(w)
      const had = S.diffs.get(top)
      if (!force && had && had.sig === sig && !had.error) return
      fetched = true
      try {
        const d = await call('diff', { session: w.sessions[0].id })
        S.diffs.set(top, { sig, ...d })
      } catch (e) {
        S.diffs.set(top, { sig, files: [], error: e.message })
      }
    })
  )
  return fetched
}

/** After a write in a lane: its changes and diff now, not at the next poll. */
export async function afterWrite() {
  await refreshChanges()
  if (await refreshDiffs(true)) render()
  if (window.workshop.view === 'overlay') {
    void refreshOplog()
    void refreshRefs()
    void refreshCmdlog()
  }
}

// ---- worktrees

/** A worktree in the last answer, with its project's root and main. */
export function findWorktree(path) {
  for (const p of S.wt?.projects ?? []) for (const w of p.worktrees) if (w.path === path) return { ...w, root: p.root, base: p.base }
  return null
}
export const wtSig = (w) => `${w.head}|${w.base?.oid}|${w.dirty}`

export async function loadMainDiff(root, w) {
  try {
    const d = await call('diffmain', { root, path: w.path })
    S.mainDiffs.set(w.path, { sig: wtSig(w), ...d })
  } catch (e) {
    S.mainDiffs.set(w.path, { sig: wtSig(w), files: [], error: e.message })
  }
}

export const refreshWorktrees = single(async () => {
  try {
    const ids = openIds(S.sessions)
    const r = ids.length ? await call('worktrees', { sessions: ids }) : { projects: [], at: Date.now() }
    const changed = JSON.stringify(r.projects) !== JSON.stringify(S.wt?.projects)
    S.wt = r
    const hadError = !!S.wtError
    S.wtError = ''
    let fetched = false
    for (const [path, d] of S.mainDiffs) {
      const w = findWorktree(path)
      if (!w) S.mainDiffs.delete(path)
      else if (d.sig !== wtSig(w)) {
        fetched = true
        await loadMainDiff(w.root, w)
      }
    }
    if (changed || fetched || hadError) render()
  } catch (e) {
    S.wtError = e.message
    render()
  }
})

// ---- history

export const refreshHistory = single(async () => {
  try {
    const ids = openIds(S.sessions)
    const q = parseQuery(S.query)
    const r = ids.length ? await call('history', { sessions: ids, limit: S.histLimit, path: q.path ?? undefined }) : { projects: [], at: Date.now() }
    const changed = JSON.stringify(r.projects) !== JSON.stringify(S.hist?.projects)
    const hadError = !!S.histError
    S.hist = r
    S.histError = ''
    if (changed || hadError) render()
  } catch (e) {
    S.histError = e.message
    render()
  }
})

/** A commit's diff is fetched once: a commit never changes. */
export async function toggleCommit(root, c) {
  if (S.openCommits.has(c.sha)) {
    S.openCommits.delete(c.sha)
    render()
    return
  }
  S.openCommits.add(c.sha)
  if (!S.commitDiffs.has(c.sha) || S.commitDiffs.get(c.sha).error) {
    S.commitDiffs.set(c.sha, { loading: true, files: [] })
    render()
    try {
      S.commitDiffs.set(c.sha, await call('commit', { root, sha: c.sha }))
    } catch (e) {
      S.commitDiffs.set(c.sha, { files: [], error: e.message })
    }
  }
  render()
}

// ---- pull requests, the operation log, refs and the command log, by project

/** Pull requests of every open project, with main's CI; gh's refusal is kept per project, not thrown. */
export const refreshPrs = single(async () => {
  const which = S.prWhich
  let changed = false
  await Promise.all(
    roots().map(async (root) => {
      const had = S.prs.get(root)
      let next
      try {
        next = { which, ...(await call('prs', { root, which })), error: '', at: Date.now() }
      } catch (e) {
        next = { which, prs: had?.which === which ? (had?.prs ?? []) : [], base: had?.base ?? null, error: e.message, at: Date.now() }
      }
      if (JSON.stringify({ ...next, at: 0 }) !== JSON.stringify({ ...had, at: 0 })) changed = true
      S.prs.set(root, next)
    })
  )
  if (changed) render()
})

export const refreshOplog = single(async () => {
  let changed = false
  await Promise.all(
    roots().map(async (root) => {
      try {
        const { entries } = await call('oplog', { root })
        if (JSON.stringify(entries) !== JSON.stringify(S.oplog.get(root))) changed = true
        S.oplog.set(root, entries)
      } catch {
        // a project whose git folder cannot be read has no log to show
      }
    })
  )
  if (changed) render()
})

export const refreshRefs = single(async () => {
  let changed = false
  await Promise.all(
    roots().map(async (root) => {
      try {
        const r = await call('refs', { root })
        if (JSON.stringify(r) !== JSON.stringify(S.refs.get(root))) changed = true
        S.refs.set(root, r)
      } catch {
        // the sidebar shows what it has
      }
    })
  )
  if (changed) render()
})

export const refreshCmdlog = single(async () => {
  try {
    const { commands } = await call('cmdlog', {})
    const last = commands.at(-1)
    if (JSON.stringify(last) !== JSON.stringify(S.cmdlog.at(-1))) {
      S.cmdlog = commands
      render()
    }
  } catch {
    // the foot shows nothing new
  }
})
