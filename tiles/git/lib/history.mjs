// The Git tile's History tab, in the backend: the log across every branch of a project, each commit
// tagged with the session that made it (exactly, from core's records, or as a guess: log.mjs), and
// one commit's diff. Read-only, with git.mjs's read guards (no optional locks, no pager, no colour,
// an argv, a timeout and a cap).

import { failure, git } from './git.mjs'
import { LOG_FORMAT, attribute, parseLog } from './log.mjs'
import { parseDiff } from './parse.mjs'
import { baseOf, listWorktrees } from './worktrees.mjs'

/** A log of LOG_MAX commits is well under this; a cut log loses only its last commit. */
const LOG_BYTES = 4 << 20
const DIFF_BYTES = 3 << 20

/**
 * The newest `limit` commits on every branch, tag and remote of the repository at `root` (and
 * every worktree's HEAD, which --all includes), newest first by commit date; the stash is left out.
 * One more is asked for than shown, to know whether there are more. A repository with no commits
 * has an empty log.
 */
export async function readLog(root, limit) {
  const r = await git(root, ['log', '--exclude=refs/stash', '--all', '--date-order', '-z', '--decorate=full', `--format=${LOG_FORMAT}`, '-n', String(limit + 1), '--'], { cap: LOG_BYTES })
  if (r.code !== 0 && !r.cut) {
    // Before the first commit there is nothing to log; git says so on stderr, which is not an error here.
    if (/does not have any commits|bad default revision|unknown revision/.test(r.err)) return { commits: [], more: false }
    throw new Error(failure(r, 'git log'))
  }
  const all = parseLog(r.out.toString('utf8'), r.cut)
  return { commits: all.slice(0, limit), more: all.length > limit || r.cut }
}

/**
 * One project's history, tagged. `sessions` are every session core knows in that project (open or
 * parked: a parked one's commits are still its own); `topOf` finds the worktree a folder is in;
 * `records` is core's Map sha → { session, name }.
 */
export async function projectHistory(root, { limit, sessions, topOf, records, now = Date.now() }) {
  const [log, worktrees, base] = await Promise.all([readLog(root, limit), listWorktrees(root).catch(() => []), baseOf(root).catch(() => null)])
  const placed = await Promise.all(
    sessions.map(async (s) => {
      const top = await topOf(s.folder)
      const w = top ? worktrees.find((x) => x.path === top) : null
      return {
        id: s.id,
        name: s.name,
        started: s.started || 0,
        // A session that died ended when it was last heard from; one alive (or parked) has not ended.
        ended: s.status === 'dead' ? (s.active ?? s.started ?? 0) : null,
        head: w?.head ?? null,
        onBase: !!(w && base && !base.remote && w.branch === base.name)
      }
    })
  )
  return { commits: attribute(log.commits, { records, sessions: placed, now }), more: log.more }
}

/**
 * One commit's diff against its first parent (a merge shows what it brought to the branch it was
 * made on; the first commit shows everything as added), parsed by the Changes tab's parser with its
 * caps. `sha` has been checked to be one.
 */
export async function showCommit(root, sha) {
  const v = await git(root, ['cat-file', '-t', sha], { cap: 64 })
  if (v.code !== 0 || v.out.toString('utf8').trim() !== 'commit') throw new Error('no such commit in this project')
  const r = await git(
    root,
    ['show', '--format=', '--diff-merges=first-parent', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '-U3', sha, '--'],
    { cap: DIFF_BYTES }
  )
  if (r.code !== 0 && !r.cut) throw new Error(failure(r, 'git show'))
  return { files: parseDiff(r.out.toString('utf8'), { cut: r.cut }), cut: r.cut }
}
