// What the Git tile did to a repository, and how to take each step back (jj's operation log,
// lazygit's undo): a JSON file in the repository's common git folder (`<common dir>/workshop-oplog.json`),
// shared by its worktrees, the newest LAST, kept KEEP_DAYS and KEEP entries.
//
// Nothing extra is kept alive to make an undo possible, and nothing is added to the user's refs
// (which `git log --all` would show):
//
// - a rebase's old tip stays in the branch's reflog (git keeps an unreachable one 30 days);
// - a merge's or a fast-forward pull's old tip is an ancestor of the new one;
// - a commit's parent is reachable from it; a removed worktree's branch was merged, so its tip is
//   reachable from main;
// - a discarded file's contents are written into the object database (`hash-object -w`), where an
//   unreachable object lives at least two weeks (gc.pruneExpire). Undo says so if one is gone.
//
// An undo checks the repository is still where the step left it (a branch tip, a file's contents)
// and refuses otherwise. It moves branches with `reset --keep` (which refuses to lose uncommitted
// work) or `reset --soft`, never --hard; it is refused while a session in that worktree is busy.

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { failure, git } from './git.mjs'

export const KEEP_DAYS = 14
const KEEP = 60
const DAY = 86_400_000

const text = (r) => r.out.toString('utf8').trim()

/** The repository's common git folder (shared by every worktree), absolute. */
export async function commonDir(cwd) {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cap: 4096 })
  if (r.code !== 0) throw new Error(failure(r, 'git rev-parse'))
  return text(r)
}

const fileOf = (common) => join(common, 'workshop-oplog.json')

/** Entries a page may see: kept, newest last. */
export function kept(entries, now = Date.now()) {
  return (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.id === 'string' && now - e.at <= KEEP_DAYS * DAY).slice(-KEEP)
}

async function load(common) {
  try {
    return kept(JSON.parse(await readFile(fileOf(common), 'utf8')))
  } catch {
    return []
  }
}

/** Written whole, then renamed over the old file: a crash leaves one or the other. */
async function save(common, entries) {
  const f = fileOf(common)
  const tmp = `${f}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(kept(entries)))
  await rename(tmp, f)
}

// One write to the file at a time, in this process.
let chain = Promise.resolve()
const serial = (fn) => {
  const p = chain.then(fn, fn)
  chain = p.catch(() => {})
  return p
}

let seq = 0
/**
 * Records one step: { kind, said, undo } where `undo` is what undoing needs (null when it cannot be
 * undone: a push, a fetch). Returns the entry.
 */
export function record(cwd, { kind, said, undo = null }) {
  return serial(async () => {
    const common = await commonDir(cwd)
    const entries = await load(common)
    const e = { id: `${Date.now().toString(36)}-${(seq++).toString(36)}`, at: Date.now(), kind, said, undo, undone: false }
    entries.push(e)
    await save(common, entries)
    return e
  })
}

/** The log of the repository `cwd` is in, newest last, each with whether it can still be undone. */
export async function list(cwd) {
  const entries = await load(await commonDir(cwd))
  return entries.map((e) => ({ id: e.id, at: e.at, kind: e.kind, said: e.said, undone: e.undone, undoable: !!e.undo && !e.undone }))
}

/** A refusal: the page shows the sentence. */
export class Refused extends Error {}

const head = async (path) => {
  const r = await git(path, ['rev-parse', '-q', '--verify', 'HEAD'], { cap: 4096 })
  return r.code === 0 ? text(r) : null
}
const branchAt = async (path) => {
  const r = await git(path, ['symbolic-ref', '-q', '--short', 'HEAD'], { cap: 4096 })
  return r.code === 0 ? text(r) : null
}
const exists = async (path, oid) => (await git(path, ['cat-file', '-e', oid], { cap: 64 })).code === 0

/** Moves the branch checked out at `path` from `now` back to `to`, keeping uncommitted work (or refusing). */
async function moveBack(u, how) {
  if (!existsSync(u.path)) throw new Refused('that worktree is gone')
  if (u.branch && (await branchAt(u.path)) !== u.branch) throw new Refused(`${u.branch} is no longer checked out there`)
  const at = await head(u.path)
  if (at !== u.after) throw new Refused(`${u.branch ?? 'HEAD'} has moved since: undoing now would drop newer commits`)
  if (!(await exists(u.path, u.before))) throw new Refused('the commit it was at is gone from the repository')
  const r = await git(u.path, ['reset', how, u.before], { write: true, timeout: 30_000 })
  if (r.code !== 0) throw new Refused(`git reset: ${failure(r, 'git reset')}`)
}

/** The blob of a file's contents as they are now, without writing anything; null when there is no file. */
async function blobOf(top, file) {
  if (!existsSync(join(top, file))) return null
  const r = await git(top, ['hash-object', '--no-filters', '--', file], { cap: 4096 })
  return r.code === 0 ? text(r) : null
}

/**
 * Undoes entry `id`. `quietAt(path)` throws while a session in that worktree is busy. Returns the
 * sentence to show. The entry is marked undone; undoing never itself goes in the log.
 */
export function undo(cwd, id, { quietAt }) {
  return serial(async () => {
    const common = await commonDir(cwd)
    const entries = await load(common)
    const e = entries.find((x) => x.id === id)
    if (!e) throw new Refused('that step is no longer in the log')
    if (e.undone) throw new Refused('that step was already undone')
    const u = e.undo
    if (!u) throw new Refused(`a ${e.kind} cannot be undone from here`)
    let said
    switch (e.kind) {
      case 'rebase':
      case 'merge':
      case 'pull':
        await quietAt(u.path)
        await moveBack(u, '--keep')
        said = `put ${u.branch ?? 'HEAD'} back where it was before the ${e.kind}`
        break
      case 'commit':
        await quietAt(u.path)
        await moveBack(u, '--soft')
        said = 'took the commit back; its changes are staged again'
        break
      case 'remove': {
        const b = await git(u.root, ['rev-parse', '-q', '--verify', `refs/heads/${u.branch}`], { cap: 4096 })
        if (b.code !== 0) {
          if (!(await exists(u.root, u.tip))) throw new Refused('its last commit is gone from the repository')
          const c = await git(u.root, ['branch', u.branch, u.tip], { write: true })
          if (c.code !== 0) throw new Refused(`git branch: ${failure(c, 'git branch')}`)
        } else if (text(b) !== u.tip) throw new Refused(`a branch named ${u.branch} exists again, at another commit`)
        if (existsSync(u.path)) throw new Refused(`something is at ${u.path} already`)
        const w = await git(u.root, ['worktree', 'add', u.path, u.branch], { write: true, timeout: 45_000 })
        if (w.code !== 0) throw new Refused(`git worktree add: ${failure(w, 'git worktree add')}`)
        said = `restored the worktree and its branch ${u.branch}`
        break
      }
      case 'discard': {
        await quietAt(u.top)
        if ((await blobOf(u.top, u.file)) !== u.after) throw new Refused(`${u.file} has changed since it was discarded`)
        if (!u.blob) throw new Refused('there was no file to put back')
        const r = await git(u.top, ['cat-file', 'blob', u.blob], { cap: 64 << 20 })
        if (r.code !== 0) throw new Refused('its contents are gone from the repository (git prunes them after two weeks)')
        const at = join(u.top, u.file)
        await mkdir(dirname(at), { recursive: true })
        await writeFile(at, r.out)
        said = `put ${u.file} back as it was`
        break
      }
      case 'stash': {
        await quietAt(u.path)
        const top = await git(u.path, ['rev-parse', '-q', '--verify', 'refs/stash'], { cap: 4096 })
        if (top.code !== 0 || text(top) !== u.sha) throw new Refused('that stash is no longer the newest one: pop it from the list')
        const r = await git(u.path, ['stash', 'pop', '--index'], { write: true, timeout: 30_000 })
        if (r.code !== 0) throw new Refused(`git stash pop: ${failure(r, 'git stash pop')}; the stash is kept`)
        said = 'put the stashed changes back'
        break
      }
      default:
        throw new Refused(`a ${e.kind} cannot be undone from here`)
    }
    e.undone = true
    await save(common, entries)
    return said
  })
}
