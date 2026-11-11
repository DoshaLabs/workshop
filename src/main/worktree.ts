// A worktree made by core for a session that cannot make its own: a Codex session, whose TUI runs
// with --remote, where codex 0.167.1 refuses `--worktree` ("only supported for local sessions";
// docs/progress/2026-11-11-codex.md). Colin, 11 Nov 2026: `.workshop/worktrees/<name>` under the
// project's root, on a new branch `worktree-<name>` (Claude Code's naming, so a task's branches read
// the same whichever CLI ran it), from what the start folder has checked out. `.workshop/` goes in
// the repo's own `info/exclude`, so it never shows as untracked and no tracked file changes.
//
// git runs by argv (no shell), without GIT_DIR and friends from core's own env, with a timeout.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { worktreeName } from '@shared/sessions'
import { projectRoot } from './project'

export const WORKTREES_DIR = join('.workshop', 'worktrees')
const EXCLUDE_LINE = '/.workshop/'

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)$/.test(k)))
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 20_000, env: gitEnv(), maxBuffer: 1 << 20 }, (e, out, err) => done({ ok: !e, out: String(out).trim(), err: String(err).trim() }))
  })
}

export interface MadeWorktree {
  path: string
  branch: string
  name: string
}

/**
 * Make `<root>/.workshop/worktrees/<name>` on a new branch `worktree-<name>`, from HEAD in `cwd`.
 * `name` is the launcher's (checked with `worktreeName`) or `fallback`. Throws, in words a person
 * can act on, when `cwd` is not in a repo, the repo has no commit yet, or the name is taken.
 */
export async function makeWorktree(cwd: string, name: string | undefined, fallback: string): Promise<MadeWorktree> {
  const wt = name === undefined || name === '' ? worktreeName(fallback) : worktreeName(name)
  if (!wt) throw new Error(`Not a worktree name: ${String(name ?? fallback).slice(0, 80)}`)
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out !== 'true') throw new Error(`Not in a git repository: ${cwd}. A worktree needs one`)
  if (!(await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).ok) throw new Error('This repository has no commit yet: a worktree needs one to branch from')
  // The main repository's root, also when the session starts inside another worktree: never nested.
  const root = await projectRoot(cwd)
  const path = join(root, WORKTREES_DIR, wt)
  const branch = `worktree-${wt}`
  if (existsSync(path)) throw new Error(`There is already a worktree folder named ${wt}: pick another name`)
  if ((await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok) throw new Error(`The branch ${branch} already exists: pick another name`)
  await excludeWorkshopDir(cwd)
  await mkdir(join(root, WORKTREES_DIR), { recursive: true })
  const made = await git(cwd, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  if (!made.ok) throw new Error(`git could not make the worktree: ${made.err.split('\n').pop() || 'unknown error'}`)
  return { path, branch, name: wt }
}

/** `/.workshop/` in the repository's own exclude file (shared by its worktrees), once. */
async function excludeWorkshopDir(cwd: string): Promise<void> {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!r.ok || !r.out) return
  const info = join(r.out, 'info')
  const file = join(info, 'exclude')
  const had = await readFile(file, 'utf8').catch(() => '')
  if (had.split('\n').some((l) => l.trim() === EXCLUDE_LINE || l.trim() === '.workshop/' || l.trim() === '.workshop')) return
  await mkdir(info, { recursive: true })
  await appendFile(file, `${had && !had.endsWith('\n') ? '\n' : ''}# workshop's worktrees (made for sessions that cannot make their own)\n${EXCLUDE_LINE}\n`)
}
