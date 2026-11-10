// The Git tile's Worktrees tab, in the backend: every worktree of a project read (branch, ahead and
// behind main, dirty or clean, when it was last touched, which files it changes), and the tab's
// three writes: rebase onto main, merge into main, remove once merged. CLAUDE.md §4.
//
// The writes keep these rules, and each is checked again right before git runs, from git itself,
// never from what the page last drew:
//
// - Never --force anything, never reset --hard, never branch -D, never push. Remove is
//   `git worktree remove` without force, then `git branch -d`, which git refuses when unmerged.
// - A worktree with uncommitted changes (untracked files included) is refused, and so is one with
//   a rebase or merge already under way.
// - A worktree a session is in is refused while that session is busy, needs you, or is starting;
//   a merge also waits for the sessions in the worktree main is checked out in. Remove refuses a
//   worktree any session is in, whatever it is doing (its folder would vanish under it).
// - A rebase or merge that stops on a conflict is aborted at once (`rebase --abort`, `merge
//   --abort`), and the files it stopped on are reported: the repository is never left mid-way.
// - Writes take git's locks as git does (no GIT_OPTIONAL_LOCKS), so one fails cleanly while a
//   session's own git holds the index.
// - The page says what it saw (`expect`: the worktree's commit and main's); if either moved since,
//   nothing is done.

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { failure, git, status } from './git.mjs'
import { NOT_QUIET, overlaps, parseDiff, parseWorktreeList, pickBase, shortPath, staleness } from './parse.mjs'

/** A write may take this long (a rebase of many commits); past it git is stopped and the repository put back. */
export const WRITE_MS = 45_000
const DIFF_BYTES = 3 << 20
/** Changed paths read per worktree for the overlap warning. */
const CHANGED_BYTES = 1 << 20

const lines = (r) => r.out.toString('utf8').split('\0').filter(Boolean)
const text = (r) => r.out.toString('utf8').trim()

/** Every worktree of the repository whose main worktree (or any worktree) is `root`, as git lists them. */
export async function listWorktrees(root) {
  const r = await git(root, ['worktree', 'list', '--porcelain', '-z'], { cap: 1 << 20 })
  if (r.code !== 0) throw new Error(failure(r, 'git worktree list'))
  return parseWorktreeList(r.out.toString('utf8'))
}

/** Main, as pickBase decides it, with the commit it is at now; null when the repository has none. */
export async function baseOf(root) {
  const o = await git(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { cap: 4096 })
  const originHead = o.code === 0 ? text(o) : null
  const want = ['main', 'master']
  const m = /^refs\/remotes\/origin\/(.+)$/.exec(originHead ?? '')
  if (m && !want.includes(m[1])) want.unshift(m[1])
  const refs = await git(root, ['for-each-ref', '--format=%(refname:short)', ...want.map((n) => `refs/heads/${n}`)], { cap: 64 << 10 })
  const locals = refs.code === 0 ? text(refs).split('\n').filter(Boolean) : []
  const b = pickBase(originHead, locals)
  if (!b) return null
  const v = await git(root, ['rev-parse', '-q', '--verify', `${b.ref}^{commit}`], { cap: 4096 })
  return v.code === 0 ? { ...b, oid: text(v) } : null
}

/** [behind, ahead] of `head` against `baseOid`. */
async function aheadBehind(root, baseOid, head) {
  const r = await git(root, ['rev-list', '--left-right', '--count', `${baseOid}...${head}`], { cap: 4096 })
  if (r.code !== 0) return [null, null]
  const [behind, ahead] = text(r).split(/\s+/).map(Number)
  return [behind, ahead]
}

/** The git paths that say an operation is under way in a worktree. */
async function underWay(path) {
  const names = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
  const r = await git(path, ['rev-parse', '--path-format=absolute', ...names.flatMap((n) => ['--git-path', n])], { cap: 64 << 10 })
  if (r.code !== 0) return null
  const found = text(r)
    .split('\n')
    .map((p, i) => (existsSync(p) ? names[i] : null))
    .filter(Boolean)
  if (found.includes('rebase-merge') || found.includes('rebase-apply')) return 'a rebase'
  if (found.includes('MERGE_HEAD')) return 'a merge'
  if (found.length) return 'a cherry-pick or revert'
  return null
}

/** When a worktree was last touched: its last commit, or its index written (a stage, a checkout), whichever is later. */
async function touchedAt(path, head) {
  let at = 0
  if (head) {
    const r = await git(path, ['log', '-1', '--format=%ct', head], { cap: 4096 })
    if (r.code === 0) at = Number(text(r)) * 1000 || 0
  }
  const i = await git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cap: 4096 })
  if (i.code === 0) {
    try {
      at = Math.max(at, (await stat(text(i))).mtimeMs)
    } catch {
      // no index yet
    }
  }
  return at || null
}

/**
 * One worktree read for the tab. `changed` (every path it touches: uncommitted, and its commits
 * since the merge base with main) is for the overlap warning and is not sent to the page whole.
 */
async function readOne(root, w, base) {
  const out = { path: w.path, branch: w.branch, head: w.head, detached: w.detached, bare: w.bare, locked: w.locked, prunable: w.prunable, ahead: null, behind: null, dirty: null, files: [], touched: null, changed: [] }
  if (w.bare || w.prunable !== null) return out
  try {
    const st = await status(w.path)
    out.dirty = st.files.length
    out.files = st.files.slice(0, 20).map((f) => ({ path: f.path, kind: f.kind }))
    const changed = new Set(st.files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])))
    if (base && w.head) {
      ;[out.behind, out.ahead] = await aheadBehind(root, base.oid, w.head)
      if (out.ahead) {
        const d = await git(root, ['diff', '--name-only', '-z', '--no-renames', `${base.oid}...${w.head}`, '--'], { cap: CHANGED_BYTES })
        if (d.code === 0 || d.cut) for (const p of lines(d)) changed.add(p)
      }
    }
    out.changed = [...changed]
    out.touched = await touchedAt(w.path, w.head)
  } catch (e) {
    out.error = e.message
  }
  return out
}

/**
 * A project's worktrees, as the tab draws them. `sessionsAt(path)` names the open sessions in a
 * worktree. Each row: path, short (its folder made readable), main (the repository's main
 * worktree), isBase (main is checked out here), branch, head, ahead / behind main, dirty (how many
 * paths differ from HEAD, untracked included), files (the first 20), touched, stale (why, or null),
 * sessions, overlaps ([{ with, short, files, count }]).
 */
export async function readProject(root, { sessionsAt, home, now = Date.now() }) {
  const list = await listWorktrees(root)
  const base = await baseOf(root)
  const rows = await Promise.all(list.map((w) => readOne(root, w, base)))
  const main = list[0]?.path
  for (const r of rows) {
    r.main = r.path === main
    r.isBase = !!base && !base.remote && r.branch === base.name
    r.short = shortPath(r.path, root, home)
    r.sessions = sessionsAt(r.path)
    r.stale = staleness(r, now)
  }
  const pairs = overlaps(rows.filter((r) => r.changed.length))
  for (const r of rows) {
    r.overlaps = pairs
      .filter((p) => p.a === r.path || p.b === r.path)
      .map((p) => {
        const other = p.a === r.path ? p.b : p.a
        return { with: other, short: shortPath(other, root, home), files: p.files, count: p.count }
      })
    delete r.changed
  }
  return { root, base: base && { name: base.name, how: base.how, oid: base.oid, remote: !!base.remote }, worktrees: rows }
}

/** A worktree against main: what it would bring, from the merge base to its working tree (tracked files; untracked ones are not in it). */
export async function diffAgainstBase(root, path) {
  const base = await baseOf(root)
  if (!base) throw new Error('this repository has no main or master branch to compare with')
  const mb = await git(path, ['merge-base', base.oid, 'HEAD'], { cap: 4096 })
  if (mb.code !== 0) throw new Error(failure(mb, 'git merge-base'))
  const r = await git(
    path,
    ['diff', text(mb), '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '-U3', '--'],
    { cap: DIFF_BYTES }
  )
  if (r.code !== 0 && !r.cut) throw new Error(failure(r, 'git diff'))
  return { base: base.name, files: parseDiff(r.out.toString('utf8'), { cut: r.cut }), cut: r.cut }
}

// ---- writes

/** A write's refusal: thrown, the page shows the sentence. */
class Refused extends Error {}

/**
 * Everything a write needs, read now: the worktree, main, and the checks every write shares.
 * `sessions` is every session core knows ({ id, name, folder, root, status }); `topOf(folder)` its
 * worktree.
 */
async function prepare({ root, path, expect }, { sessions, topOf }) {
  if (typeof root !== 'string' || typeof path !== 'string') throw new Refused('which worktree: { root, path }')
  // The page may only name a repository a session works in, and a worktree git lists for it.
  if (!sessions.some((s) => s.root === root)) throw new Refused('no session works in that project')
  const list = await listWorktrees(root)
  const w = list.find((x) => x.path === path)
  if (!w) throw new Refused('that worktree is gone')
  const base = await baseOf(root)
  if (!base) throw new Refused('this repository has no main or master branch')
  if (expect && (expect.head !== w.head || expect.base !== base.oid)) throw new Refused('it changed since the tab last looked: look again, then try once more')
  if (w.prunable !== null) throw new Refused('its folder is gone')
  const tops = await Promise.all(sessions.map(async (s) => ({ s, top: await topOf(s.folder) })))
  const inside = (p) => tops.filter((t) => t.top === p).map((t) => t.s)
  return { w, list, base, inside, main: list[0] }
}

/** Refuses while a session in `p` is busy, needs you, or is starting. */
function quiet(inside, p, where) {
  for (const s of inside(p)) if (NOT_QUIET[s.status]) throw new Refused(`${s.name} ${NOT_QUIET[s.status]}${where ? ` in ${where}` : ''}: wait until it is quiet`)
}

async function clean(p, what) {
  const doing = await underWay(p)
  if (doing) throw new Refused(`${what} is in the middle of ${doing}; finish or abort it there first`)
  const st = await status(p)
  if (st.files.length) {
    const names = st.files.slice(0, 3).map((f) => f.path).join(', ')
    throw new Refused(`${what} has uncommitted changes (${names}${st.files.length > 3 ? ` and ${st.files.length - 3} more` : ''}): commit or put them away first`)
  }
}

/** The files a stopped rebase or merge left in conflict. */
async function conflicts(p) {
  const r = await git(p, ['diff', '--name-only', '--diff-filter=U', '-z'], { cap: 1 << 20 })
  return r.code === 0 ? [...new Set(lines(r))] : []
}

/** Runs `abortArgs` while `what` is still under way, and says whether the worktree is back as it was. */
async function putBack(p, abortArgs) {
  if (!(await underWay(p))) return true
  await git(p, abortArgs, { write: true, timeout: WRITE_MS })
  return !(await underWay(p))
}

/** Rebase the worktree's branch onto main. */
export async function rebase(body, ctx) {
  const { w, base, inside } = await prepare(body, ctx)
  if (!w.branch) throw new Refused('it is not on a branch (detached HEAD)')
  if (w.branch === base.name) throw new Refused(`this is ${base.name} itself`)
  quiet(inside, w.path)
  await clean(w.path, 'this worktree')
  const [behind] = await aheadBehind(w.path, base.oid, w.head)
  if (behind === 0) return { done: true, nothing: true, said: `already on top of ${base.name}` }
  const r = await git(w.path, ['rebase', base.oid], { write: true, timeout: WRITE_MS })
  if (r.code === 0 && !(await underWay(w.path))) return { done: true, said: `rebased ${w.branch} onto ${base.name}` }
  const files = await conflicts(w.path)
  const back = await putBack(w.path, ['rebase', '--abort'])
  if (!back) return { done: false, stuck: true, files, said: `the rebase stopped and could not be undone: run git rebase --abort in ${w.path}` }
  if (files.length) return { done: false, conflict: true, files, said: `rebasing onto ${base.name} conflicts in ${files.length === 1 ? 'one file' : `${files.length} files`}; nothing was changed` }
  return { done: false, said: `git rebase failed: ${failure(r, 'git rebase', WRITE_MS)}; nothing was changed` }
}

/** Merge the worktree's branch into main, in the worktree main is checked out in. */
export async function merge(body, ctx) {
  const { w, list, base, inside } = await prepare(body, ctx)
  if (!w.branch) throw new Refused('it is not on a branch (detached HEAD)')
  if (base.remote) throw new Refused(`there is no local ${base.name} to merge into`)
  if (w.branch === base.name) throw new Refused(`this is ${base.name} itself`)
  const target = list.find((x) => x.branch === base.name)
  if (!target) throw new Refused(`no worktree has ${base.name} checked out, so there is nowhere to merge: check it out in one first`)
  if (target.prunable !== null) throw new Refused(`the worktree ${base.name} is checked out in is gone`)
  quiet(inside, w.path)
  quiet(inside, target.path, `the ${base.name} worktree`)
  await clean(w.path, 'this worktree')
  await clean(target.path, `the ${base.name} worktree`)
  const [, ahead] = await aheadBehind(w.path, base.oid, w.head)
  if (ahead === 0) return { done: true, nothing: true, said: `${base.name} already has everything on ${w.branch}` }
  const r = await git(target.path, ['merge', '--no-edit', w.branch], { write: true, timeout: WRITE_MS })
  if (r.code === 0 && !(await underWay(target.path))) return { done: true, said: `merged ${w.branch} into ${base.name}` }
  const files = await conflicts(target.path)
  const back = await putBack(target.path, ['merge', '--abort'])
  if (!back) return { done: false, stuck: true, files, said: `the merge stopped and could not be undone: run git merge --abort in ${target.path}` }
  if (files.length) return { done: false, conflict: true, files, said: `merging into ${base.name} conflicts in ${files.length === 1 ? 'one file' : `${files.length} files`}; nothing was changed` }
  return { done: false, said: `git merge failed: ${failure(r, 'git merge', WRITE_MS)}; nothing was changed` }
}

/** Remove a merged worktree and its branch: never forced, so git keeps anything not merged. */
export async function remove(body, ctx) {
  const { w, list, base, inside, main } = await prepare(body, ctx)
  if (w.path === main.path) throw new Refused('this is the main worktree')
  if (w.branch === base.name) throw new Refused(`${base.name} is checked out here`)
  const there = inside(w.path)
  if (there.length) throw new Refused(`${there.map((s) => s.name).join(' and ')} ${there.length === 1 ? 'is' : 'are'} still in it: close that session first`)
  if (w.locked !== null) throw new Refused(`it is locked${w.locked ? ` (${w.locked})` : ''}`)
  await clean(w.path, 'this worktree')
  const merged = await git(w.path, ['merge-base', '--is-ancestor', w.head, base.oid], { cap: 4096 })
  if (merged.code !== 0) throw new Refused(`it has commits ${base.name} does not: merge it first`)
  const r = await git(main.path, ['worktree', 'remove', w.path], { write: true, timeout: WRITE_MS })
  if (r.code !== 0) throw new Refused(`git worktree remove: ${failure(r, 'git worktree remove', WRITE_MS)}`)
  if (!w.branch) return { done: true, said: 'removed the worktree' }
  // Deleted where main is checked out, so `branch -d` judges "merged" against main.
  const at = list.find((x) => x.branch === base.name && x.prunable === null)?.path ?? main.path
  const d = await git(at, ['branch', '-d', w.branch], { write: true, timeout: WRITE_MS })
  if (d.code !== 0) return { done: true, said: `removed the worktree; kept the branch ${w.branch} (${failure(d, 'git branch -d')})` }
  return { done: true, said: `removed the worktree and the branch ${w.branch}` }
}
