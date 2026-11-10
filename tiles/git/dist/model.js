// The Git tile's page, the parts with rules in them: which sessions to ask about, how a branch and
// a count read, the line numbers beside a hunk, and when a poll's answer means an unfolded diff is
// stale. No DOM, so it is tested as shipped (test/git-page.test.ts); tile.js draws.

/** The sessions the Changes tab is about: the open ones (a parked session is in the Closed card). */
export function openIds(list) {
  return (list ?? []).filter((s) => s.open !== false && s.status !== 'dead').map((s) => s.id)
}

/** What changed in the sessions list that is worth asking git again for: a session opened or closed, or a status moved. */
export function sessionsKey(list) {
  return (list ?? [])
    .filter((s) => s.open !== false)
    .map((s) => `${s.id}:${s.status}`)
    .sort()
    .join(' ')
}

/** "main", "main ↑2 ↓1", "detached at 1a2b3c4", "no commits yet". */
export function branchLabel(branch) {
  if (!branch) return ''
  let name = branch.head ?? (branch.oid ? `detached at ${branch.oid.slice(0, 7)}` : 'no commits yet')
  if (branch.head && !branch.oid) name += ' (no commits yet)'
  const ab = [branch.ahead ? `↑${branch.ahead}` : '', branch.behind ? `↓${branch.behind}` : ''].filter(Boolean).join(' ')
  return ab ? `${name} ${ab}` : name
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "3 files": every changed path, the ones past the backend's list included (`count` has them); "+" when git's own list was cut. */
export const filesLabel = (w) => (w.more ? `${w.count ?? 0}+ files` : plural(w.count ?? 0, 'file'))

/** A count that may be unknown (a binary file, a file too large to count): null draws nothing. */
export const num = (n) => (n == null ? '' : String(n))

/** Session names on one line: "fix-auth", "fix-auth and tests", "a, b and c". */
export function names(list) {
  const n = list.map((s) => s.name)
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`
}

/** One letter per kind of change, as `git status --short` would say it. */
export const LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', conflict: 'U', untracked: '?' }

/**
 * A hunk's lines with the numbers drawn beside them: `o` in the old file, `n` in the new one
 * (null where the line is not in that side), `t` the kind (' ', '+', '-', '\\').
 */
export function numbered(hunk) {
  let o = hunk.oldStart
  let n = hunk.newStart
  return hunk.lines.map((line) => {
    const t = line[0] ?? ' '
    const s = line.slice(1)
    if (t === '+') return { t, o: null, n: n++, s }
    if (t === '-') return { t, o: o++, n: null, s }
    if (t === '\\') return { t, o: null, n: null, s: s.trim() }
    return { t: ' ', o: o++, n: n++, s }
  })
}

/**
 * A worktree's changes in one string: when a poll's answer has a different one, an unfolded diff
 * is fetched again. Counts and paths, so an edit that leaves both the same is caught by the next
 * refresh that comes from a session going quiet, not by the poll.
 */
export function signature(w) {
  if (!w || w.error) return ''
  return [w.branch?.oid, w.count, w.add, w.del, ...(w.files ?? []).map((f) => `${f.path}:${f.kind}:${f.add}:${f.del}`)].join('|')
}

/** Every worktree in a changes answer, by its top folder. */
export function worktreesOf(projects) {
  const out = new Map()
  for (const p of projects ?? []) for (const w of p.worktrees) out.set(w.top, w)
  return out
}

/** The worktree a session is in, if it has one in this answer. */
export function worktreeOfSession(projects, id) {
  for (const p of projects ?? []) for (const w of p.worktrees) if (w.sessions.some((s) => s.id === id)) return w
  return null
}

/** Totals over every worktree: what the tile's head says. */
export function totals(projects) {
  let files = 0
  let dirty = 0
  for (const w of worktreesOf(projects).values()) {
    if (w.error) continue
    files += w.count ?? 0
    if (w.count) dirty++
  }
  return { files, dirty }
}

// ---- the Worktrees tab

/** How long a destructive button stays armed (red) after its first click: CLAUDE.md §4. */
export const ARM_MS = 3000

/**
 * The two-click rule: the first click on a destructive button arms it, a second on the same button
 * within ARM_MS acts. `armed` is { key, at } or null. Returns what to do and the new state.
 */
export function press(armed, key, now = Date.now()) {
  if (armed && armed.key === key && now - armed.at <= ARM_MS) return { act: true, armed: null }
  return { act: false, armed: { key, at: now } }
}

/** Whether `key` is armed at `now`. */
export const isArmed = (armed, key, now = Date.now()) => !!armed && armed.key === key && now - armed.at <= ARM_MS

/** "↑2 ↓1 on main", "even with main", or '' when there is nothing to compare with. */
export function versusBase(w, base) {
  if (!base || w.isBase || w.ahead == null) return ''
  if (!w.ahead && !w.behind) return `even with ${base.name}`
  return [w.ahead ? `↑${w.ahead}` : '', w.behind ? `↓${w.behind}` : ''].filter(Boolean).join(' ') + ` on ${base.name}`
}

/** "clean", "3 changed", or '' (not read). */
export const dirtyLabel = (w) => (w.dirty == null ? '' : w.dirty ? `${w.dirty} changed` : 'clean')

/** Why the stale filter shows it, in words. */
export const STALE_WORDS = { gone: 'folder gone', merged: 'merged, no session', untouched: 'untouched 14+ days, no session' }

/** What a worktree row offers. The backend checks every one again; this only hides what could never work. */
export function actionsFor(w, base) {
  const ok = !w.bare && w.prunable == null && !w.error
  const branchOff = ok && !!base && !!w.branch && !w.isBase && w.branch !== base.name
  return {
    diff: ok && !!base && !w.isBase && ((w.ahead ?? 0) > 0 || (w.dirty ?? 0) > 0),
    open: ok,
    rebase: branchOff && (w.behind ?? 0) > 0,
    merge: branchOff && !base.remote && (w.ahead ?? 0) > 0,
    remove: ok && !w.main && !w.isBase && !w.sessions.length
  }
}

/** The worktrees a filter shows: all, or the stale ones. */
export const filtered = (worktrees, filter) => (filter === 'stale' ? worktrees.filter((w) => w.stale) : worktrees)

/** Every overlap in a project once (each is listed on both rows): [{ a, b, files, count }] by short name. */
export function projectOverlaps(p) {
  const seen = new Set()
  const out = []
  for (const w of p.worktrees) {
    for (const o of w.overlaps ?? []) {
      const k = [w.path, o.with].sort().join('\0')
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ a: w.short, b: o.short, files: o.files, count: o.count })
    }
  }
  return out
}
