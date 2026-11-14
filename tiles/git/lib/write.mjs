// The Git tile's writes on one working tree, named by a session in it (the page never names a
// folder): stage and unstage a file or one hunk, discard a file or one hunk, commit what is staged,
// push, pull, fetch, stash and pop. The rules every one keeps (worktrees.mjs has the same for
// rebase, merge and remove):
//
// - Never --force, never reset --hard, never clean, never push --force or to another branch name.
// - A file the page names must be one `git status` lists in that working tree now; a hunk is found
//   again in git's own diff of that file, and must have the header the page saw.
// - Discard, pull, stash and pop are refused while a session there is busy, needs you or is
//   starting (they change files under it). Staging and committing are not: they touch only the
//   index and history, and git's index lock keeps them from racing a session's own git.
// - A discarded file's contents are written into the object database first, so the step can be
//   undone (oplog.mjs); every step that changed something goes in the operation log.
// - Writes take git's locks as git does, never open an editor, and time out.

import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { failure, git, status } from './git.mjs'
import { NOT_QUIET, parseDiff } from './parse.mjs'
import { Refused, record } from './oplog.mjs'

const WRITE_MS = 45_000
/** Push, pull and fetch talk to a remote: a little longer. */
const NET_MS = 90_000
export const MESSAGE_CHARS = 5000

const text = (r) => r.out.toString('utf8').trim()
const headOf = async (top) => {
  const r = await git(top, ['rev-parse', '-q', '--verify', 'HEAD'], { cap: 4096 })
  return r.code === 0 ? text(r) : null
}

/** Refuses while any session in `top` is busy, needs you, or is starting. */
export function quietIn(sessions, topOf) {
  return async (top) => {
    const places = await Promise.all(sessions.map(async (s) => ({ s, top: await topOf(s.folder) })))
    for (const { s, top: t } of places) if (t === top && NOT_QUIET[s.status]) throw new Refused(`${s.name} ${NOT_QUIET[s.status]}: wait until it is quiet`)
  }
}

/** A path `git status` lists in `top` now: { path, kind, staged, unstaged, from? }. */
async function listed(top, path) {
  if (typeof path !== 'string' || !path) throw new Refused('which file')
  const st = await status(top)
  const f = st.files.find((x) => x.path === path)
  if (!f) throw new Refused(`${path} has no changes now`)
  return { f, branch: st.branch }
}

/** One file's diff against HEAD, as git sees it now, parsed. */
async function fileDiff(top, path, { cached = false } = {}) {
  const args = ['diff', ...(cached ? ['--cached'] : ['HEAD']), '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-U3', '--', path]
  const r = await git(top, args, { cap: 4 << 20 })
  if (r.code !== 0) throw new Refused(failure(r, 'git diff'))
  return parseDiff(r.out.toString('utf8'))[0] ?? null
}

/** How a hunk's header reads; the page sends the one it drew. */
export const headerOf = (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`

/** A patch of one hunk of `path`, as git apply takes it. */
export function hunkPatch(path, h) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `${headerOf(h)}${h.section ? ` ${h.section}` : ''}`, ...h.lines, ''].join('\n')
}

/** The hunk the page means: the file must have nothing staged (so its HEAD diff is its index diff), and the header must match. */
async function theHunk(top, f, index, header) {
  if (f.kind === 'untracked' || f.kind === 'added' || f.kind === 'deleted' || f.kind === 'renamed' || f.kind === 'conflict') throw new Refused(`a ${f.kind} file is staged or discarded whole`)
  if (f.staged) throw new Refused('part of this file is staged already: stage or unstage the whole file')
  const d = await fileDiff(top, f.path)
  const h = d?.hunks?.[index]
  if (!h || d.truncated) throw new Refused('that part of the file has changed: look again')
  if (headerOf(h) !== header) throw new Refused('that part of the file has changed since the tile drew it: look again')
  return h
}

/** Stage a file whole, or one hunk of it ({ hunk, header }). */
export async function stage(top, { path, hunk, header }) {
  const { f } = await listed(top, path)
  if (hunk == null) {
    const r = await git(top, ['add', '-A', '--', path], { write: true, timeout: WRITE_MS })
    if (r.code !== 0) throw new Refused(`git add: ${failure(r, 'git add')}`)
    return { said: `staged ${path}` }
  }
  const h = await theHunk(top, f, hunk, header)
  const r = await git(top, ['apply', '--cached', '--whitespace=nowarn', '-'], { write: true, timeout: WRITE_MS, input: hunkPatch(path, h) })
  if (r.code !== 0) throw new Refused(`git apply: ${failure(r, 'git apply')}`)
  return { said: `staged one part of ${path}` }
}

/** Unstage a file whole: its changes stay in the working tree. */
export async function unstage(top, { path }) {
  const { f } = await listed(top, path)
  if (!f.staged) return { said: `${path} has nothing staged` }
  const r = (await headOf(top)) ? await git(top, ['restore', '--staged', '--', path], { write: true, timeout: WRITE_MS }) : await git(top, ['rm', '--cached', '-q', '--', path], { write: true, timeout: WRITE_MS })
  if (r.code !== 0) throw new Refused(`git restore: ${failure(r, 'git restore')}`)
  return { said: `unstaged ${path}` }
}

/**
 * Discard a file's changes (back to HEAD, staged ones too; an untracked file is deleted) or one
 * hunk of it. Its contents are kept in the object database first and the step logged, so it can be
 * undone.
 */
export async function discard(top, { path, hunk, header }, { quiet }) {
  await quiet(top)
  const { f } = await listed(top, path)
  if (f.submodule) throw new Refused('a submodule is discarded in its own repository')
  if (f.kind === 'conflict') throw new Refused('a file in conflict is resolved, not discarded')
  const at = join(top, path)
  let blob = null
  if (existsSync(at)) {
    const w = await git(top, ['hash-object', '-w', '--no-filters', '--', path], { write: true, cap: 4096 })
    if (w.code !== 0) throw new Refused(`could not keep a copy first: ${failure(w, 'git hash-object')}`)
    blob = text(w)
  }
  if (hunk != null) {
    const h = await theHunk(top, f, hunk, header)
    const r = await git(top, ['apply', '-R', '--whitespace=nowarn', '-'], { write: true, timeout: WRITE_MS, input: hunkPatch(path, h) })
    if (r.code !== 0) throw new Refused(`git apply: ${failure(r, 'git apply')}`)
  } else if (f.kind === 'untracked') {
    await unlink(at)
  } else if (f.kind === 'added') {
    // New in the index only: out of the index, then the file goes.
    const r = await git(top, ['rm', '--cached', '-q', '--', path], { write: true, timeout: WRITE_MS })
    if (r.code !== 0) throw new Refused(`git rm: ${failure(r, 'git rm')}`)
    if (existsSync(at)) await unlink(at)
  } else {
    const paths = f.from ? [path, f.from] : [path]
    const r = await git(top, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths], { write: true, timeout: WRITE_MS })
    if (r.code !== 0) throw new Refused(`git restore: ${failure(r, 'git restore')}`)
  }
  let after = null
  if (existsSync(at)) {
    const a = await git(top, ['hash-object', '--no-filters', '--', path], { cap: 4096 })
    after = a.code === 0 ? text(a) : null
  }
  const said = hunk != null ? `discarded one part of ${path}` : `discarded the changes to ${path}`
  await record(top, { kind: 'discard', said, undo: blob ? { top, file: path, blob, after } : null })
  return { said }
}

/** Commit what is staged, with the user's own name and hooks, never an editor. */
export async function commit(top, { message }) {
  const m = typeof message === 'string' ? message.trim() : ''
  if (!m) throw new Refused('a commit needs a message')
  if (m.length > MESSAGE_CHARS) throw new Refused(`a message of at most ${MESSAGE_CHARS} characters`)
  const staged = await git(top, ['diff', '--cached', '--quiet', '--'], { cap: 64 })
  if (staged.code === 0) throw new Refused('nothing is staged')
  const st = await status(top)
  if (st.files.some((f) => f.kind === 'conflict')) throw new Refused('a file is in conflict: resolve it first')
  const before = await headOf(top)
  const r = await git(top, ['commit', '-q', '-m', m], { write: true, timeout: WRITE_MS })
  if (r.code !== 0) throw new Refused(`git commit: ${failure(r, 'git commit', WRITE_MS)}`)
  const after = await headOf(top)
  const said = `committed "${m.split('\n')[0].slice(0, 80)}"${st.branch.head ? ` to ${st.branch.head}` : ''}`
  await record(top, { kind: 'commit', said, undo: before ? { path: top, branch: st.branch.head, before, after } : null })
  return { said, sha: after }
}

/** Push the branch to its upstream, or to origin under its own name the first time. Never forced. */
export async function push(top) {
  const st = await status(top)
  const b = st.branch.head
  if (!b) throw new Refused('not on a branch (detached HEAD)')
  if (!st.branch.oid) throw new Refused('nothing to push yet: no commits')
  let args
  if (st.branch.upstream) args = ['push', '--quiet']
  else {
    const remotes = await git(top, ['remote'], { cap: 4096 })
    if (!text(remotes).split('\n').includes('origin')) throw new Refused('there is no remote named origin to push to')
    args = ['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${b}`]
  }
  const r = await git(top, args, { write: true, timeout: NET_MS })
  if (r.code !== 0) throw new Refused(`git push: ${failure(r, 'git push', NET_MS)}`)
  const said = st.branch.upstream ? `pushed ${b}` : `pushed ${b} to origin, tracking it`
  await record(top, { kind: 'push', said })
  return { said }
}

/** Fast-forward the branch from its upstream; never a merge or a rebase of the user's own. */
export async function pull(top, { quiet }) {
  await quiet(top)
  const st = await status(top)
  if (!st.branch.head) throw new Refused('not on a branch (detached HEAD)')
  if (!st.branch.upstream) throw new Refused(`${st.branch.head} tracks no remote branch`)
  const before = await headOf(top)
  const r = await git(top, ['pull', '--ff-only', '--quiet'], { write: true, timeout: NET_MS })
  if (r.code !== 0) throw new Refused(`git pull: ${failure(r, 'git pull', NET_MS)}`)
  const after = await headOf(top)
  if (after === before) return { said: `${st.branch.head} is up to date` }
  const said = `pulled ${st.branch.head} forward`
  await record(top, { kind: 'pull', said, undo: { path: top, branch: st.branch.head, before, after } })
  return { said }
}

/** Fetch every remote: the working tree is never touched. */
export async function fetch(top) {
  const r = await git(top, ['fetch', '--all', '--quiet'], { write: true, timeout: NET_MS })
  if (r.code !== 0) throw new Refused(`git fetch: ${failure(r, 'git fetch', NET_MS)}`)
  await record(top, { kind: 'fetch', said: 'fetched from every remote' })
  return { said: 'fetched' }
}

/** Put every change away (untracked files too) in a new stash. */
export async function stash(top, { quiet }) {
  await quiet(top)
  const st = await status(top)
  if (!st.files.length) throw new Refused('nothing to stash')
  const msg = `workshop ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const r = await git(top, ['stash', 'push', '--include-untracked', '-m', msg], { write: true, timeout: WRITE_MS })
  if (r.code !== 0) throw new Refused(`git stash: ${failure(r, 'git stash')}`)
  const s = await git(top, ['rev-parse', '-q', '--verify', 'refs/stash'], { cap: 4096 })
  const said = `stashed ${st.files.length} changed ${st.files.length === 1 ? 'file' : 'files'}`
  await record(top, { kind: 'stash', said, undo: s.code === 0 ? { path: top, sha: text(s) } : null })
  return { said }
}

/** Pop one stash (named by its sha, found again in the list) into a working tree with no changes. */
export async function pop(top, { sha }, { quiet }) {
  await quiet(top)
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Refused('which stash: its sha')
  const st = await status(top)
  if (st.files.length) throw new Refused('this working tree has changes: commit or stash them first')
  const l = await git(top, ['stash', 'list', '--format=%H'], { cap: 1 << 20 })
  const at = text(l).split('\n').indexOf(sha)
  if (at < 0) throw new Refused('that stash is gone')
  const r = await git(top, ['stash', 'pop', '--index', `stash@{${at}}`], { write: true, timeout: WRITE_MS })
  if (r.code !== 0) throw new Refused(`git stash pop: ${failure(r, 'git stash pop')}; the stash is kept`)
  await record(top, { kind: 'pop', said: 'popped a stash' })
  return { said: 'popped the stash' }
}
