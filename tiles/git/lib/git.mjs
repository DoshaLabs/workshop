// The Git tile's backend, the part that runs git. Reads are made so they can never get in a
// session's way (the writes, in worktrees.mjs, ask for `write` and take the locks as git does):
//
// - GIT_OPTIONAL_LOCKS=0 (and --no-optional-locks): `git status` would otherwise refresh the index
//   and take its lock, which a session's own `git commit` would then fail on.
// - --no-pager, no colour, no external diff or textconv program, core.quotepath=off, LC_ALL=C:
//   the output is the same plain text whatever the user's config says.
// - An argv array, never a shell; a timeout; and a cap on what is read, after which git is
//   stopped and the answer says it was cut.
//
// Folders come from the sessions core gives the backend, never from the page (backend.mjs).

import { spawn } from 'node:child_process'
import { lstat, open, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { countLines, dropWorktrees, parseDiff, parseNumstat, parseStatus, parseWorktrees, summarize, untrackedDiff } from './parse.mjs'

const BASE = ['--no-pager', '--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'color.ui=false']
/** git's variables that would point it at another repository than the folder it is run in. */
const POINTERS = /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES)$/
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !POINTERS.test(k))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C'
}
/**
 * A write (rebase, merge, worktree remove, branch -d) takes the index lock as git normally does, so
 * it fails cleanly while a session holds it rather than racing it; and it never opens an editor
 * (a merge's message is git's own), so it cannot wait on a terminal nobody sees.
 */
const WRITE_ENV = {
  ...Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== 'GIT_OPTIONAL_LOCKS')),
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no'
}
const WRITE_BASE = BASE.filter((a) => a !== '--no-optional-locks')

export const TIMEOUT_MS = 8000
/** git status past this many bytes (a huge untracked tree) is cut, and says so. */
const STATUS_BYTES = 4 << 20
/** A worktree's whole diff is read up to this many bytes. */
const DIFF_BYTES = 3 << 20
/** Untracked files read for a line count, per worktree; past it they are listed without one. */
export const COUNT_FILES = 200
/** An untracked file larger than this is listed without a line count. */
export const COUNT_BYTES = 2 << 20
/** Untracked files whose contents are shown in a diff, and how much of each is read. */
const SHOW_FILES = 40
const SHOW_BYTES = 256 << 10
/** Files listed per worktree in the summary; the rest are counted. */
export const LIST_FILES = 300

// ---- the command log: what the tile ran, newest last, for the whole-window view's foot (it shows
// the exact git each action ran, as Sublime Merge and lazygit do). Arguments, never output.

const LOG_KEEP = 60
const ran = []
/** Notes one command: `what` is its argv after the program's name. */
export function note(program, cwd, args, { ms, code, write }) {
  ran.push({ at: Date.now(), program, cwd, args: args.map(String).map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)), ms, code, write: !!write })
  if (ran.length > LOG_KEEP) ran.splice(0, ran.length - LOG_KEEP)
}
/** The commands run, newest last; `writes` keeps only the ones that changed something. */
export const recent = ({ writes = false } = {}) => ran.filter((r) => !writes || r.write)

/**
 * Runs git in `cwd`: { code, out (Buffer), cut, timedOut, err }. Never throws. `write` drops the
 * read-only guards (see WRITE_ENV); `input` is written to git's stdin (a patch for `git apply`).
 */
export function git(cwd, args, { cap = STATUS_BYTES, timeout = TIMEOUT_MS, write = false, input = null } = {}) {
  const started = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', [...(write ? WRITE_BASE : BASE), '-C', cwd, ...args], { env: write ? WRITE_ENV : ENV, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, out: Buffer.alloc(0), cut: false, timedOut: false, err: e.message })
      return
    }
    if (input != null) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
    const chunks = []
    let size = 0
    let cut = false
    let timedOut = false
    let err = ''
    child.stdout.on('data', (b) => {
      if (cut) return
      if (size + b.length > cap) {
        chunks.push(b.subarray(0, cap - size))
        size = cap
        cut = true
        child.kill('SIGTERM')
      } else {
        chunks.push(b)
        size += b.length
      }
    })
    child.stderr.on('data', (b) => {
      if (err.length < 4000) err += b.toString('utf8')
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)
    child.on('error', (e) => {
      err ||= e.message
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      note('git', cwd, args, { ms: Date.now() - started, code: code ?? -1, write })
      resolve({ code: code ?? -1, out: Buffer.concat(chunks), cut, timedOut, err: err.trim() })
    })
  })
}

export function failure(r, what, timeout = TIMEOUT_MS) {
  if (r.timedOut) return `${what} took longer than ${timeout / 1000} s`
  return r.err.split('\n')[0] || `${what} failed`
}

/** The top of the working tree `folder` is in, or null when it is not in one (or is gone). */
export async function worktreeTop(folder) {
  const r = await git(folder, ['rev-parse', '--show-toplevel'], { cap: 64 << 10 })
  const top = r.code === 0 ? r.out.toString('utf8').trim() : ''
  return top || null
}

/** What a diff is taken against: HEAD, or the empty tree before the first commit. */
async function baseOf(top, branch) {
  if (branch.oid) return 'HEAD'
  const r = await git(top, ['hash-object', '-t', 'tree', '/dev/null'], { cap: 1024 })
  return r.out.toString('utf8').trim() || 'HEAD'
}

/** Reads at most `max` bytes of a file inside `top`; a symlink is its target's name, as git diffs it. */
async function head(top, path, max) {
  const abs = join(top, path)
  const st = await lstat(abs)
  if (st.isSymbolicLink()) return { buf: Buffer.from(await readlink(abs), 'utf8'), size: 0, cut: false }
  if (!st.isFile()) return null
  const fh = await open(abs, 'r')
  try {
    const len = Math.min(st.size, max)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, 0)
    return { buf: buf.subarray(0, bytesRead), size: st.size, cut: st.size > max }
  } finally {
    await fh.close()
  }
}

/** A worktree's `git status`, parsed, with nested worktrees of the same repository left out. */
export async function status(top) {
  const r = await git(top, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'])
  if (r.code !== 0 && !r.cut) throw new Error(failure(r, 'git status'))
  const st = parseStatus(r.out.toString('utf8'), r.cut)
  // Only asked when there is a nested folder that could be one of this repository's worktrees.
  if (st.files.some((f) => f.kind === 'untracked' && f.path.endsWith('/'))) {
    const w = await git(top, ['worktree', 'list', '--porcelain', '-z'], { cap: 1 << 20 })
    if (w.code === 0) st.files = dropWorktrees(st.files, top, parseWorktrees(w.out.toString('utf8')))
  }
  return st
}

/**
 * One worktree's changes against HEAD, in the index and the working tree alike: its branch, each
 * changed path with its kind and line counts, and the totals. How the counts are made:
 * tracked files by `git diff HEAD --numstat -M` (staged and unstaged together; a rename is one
 * file); an untracked file counts all its lines as added (the first COUNT_FILES of them, each up
 * to COUNT_BYTES; past either it is listed with no count); a binary file is listed with no count.
 */
export async function changes(top) {
  const st = await status(top)
  const base = await baseOf(top, st.branch)
  const r = await git(top, ['diff', base, '--numstat', '-z', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--'])
  const numstat = r.code === 0 ? parseNumstat(r.out.toString('utf8')) : new Map()
  const untracked = new Map()
  let read = 0
  for (const f of st.files) {
    if (f.kind !== 'untracked' || read >= COUNT_FILES) continue
    read++
    try {
      const h = await head(top, f.path, COUNT_BYTES)
      if (h && !h.cut) untracked.set(f.path, countLines(h.buf))
      else if (h?.buf.subarray(0, 8000).includes(0)) untracked.set(f.path, { add: null, del: null, binary: true })
    } catch {
      // gone between status and now: listed without a count
    }
  }
  const sum = summarize(st, numstat, untracked)
  if (sum.files.length > LIST_FILES) {
    sum.hidden = sum.files.length - LIST_FILES
    sum.files = sum.files.slice(0, LIST_FILES)
  }
  return sum
}

/**
 * One worktree's whole diff against HEAD, parsed into files and hunks (parse.mjs has the caps),
 * then each untracked file as all-added lines. Binary files are named, never shown.
 */
export async function diff(top) {
  const st = await status(top)
  const base = await baseOf(top, st.branch)
  const r = await git(
    top,
    ['diff', base, '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '-U3', '--'],
    { cap: DIFF_BYTES }
  )
  if (r.code !== 0 && !r.cut) throw new Error(failure(r, 'git diff'))
  const files = parseDiff(r.out.toString('utf8'), { cut: r.cut })
  let shown = 0
  let unread = 0
  for (const f of st.files) {
    if (f.kind !== 'untracked') continue
    if (shown >= SHOW_FILES) {
      unread++
      continue
    }
    shown++
    try {
      const h = await head(top, f.path, SHOW_BYTES)
      if (h) files.push(untrackedDiff(f.path, h.buf, { cut: h.cut }))
    } catch {
      // gone since status
    }
  }
  return { files, cut: r.cut, unread }
}
