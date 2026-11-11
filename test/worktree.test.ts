// Worktrees core makes for sessions that cannot make their own (a Codex session: 0.167.1 refuses
// --worktree with --remote). Real git, in temp folders.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeWorktree } from '../src/main/worktree'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim()

function repo(commit = true): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ws-wt-')))
  git(dir, 'init', '-q', '-b', 'main')
  if (commit) {
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'one')
  }
  return dir
}

describe('makeWorktree', () => {
  it('makes .workshop/worktrees/<name> on worktree-<name> from HEAD, and the main tree stays clean', async () => {
    const dir = repo()
    const wt = await makeWorktree(dir, 'login-fix', 'codex-abc123')
    expect(wt).toEqual({ path: join(dir, '.workshop', 'worktrees', 'login-fix'), branch: 'worktree-login-fix', name: 'login-fix' })
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('worktree-login-fix')
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'HEAD'))
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect(git(dir, 'worktree', 'list')).toContain(wt.path)
  })
  it('names it after the fallback when the launcher gave none', async () => {
    const wt = await makeWorktree(repo(), undefined, 'codex-abc123')
    expect(wt.name).toBe('codex-abc123')
    expect(wt.branch).toBe('worktree-codex-abc123')
  })
  it('writes the exclude line once, in the repository’s own exclude file', async () => {
    const dir = repo()
    await makeWorktree(dir, 'one', 'x')
    await makeWorktree(dir, 'two', 'x')
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((l) => l === '/.workshop/')).toHaveLength(1)
  })
  it('from inside another worktree, under the main repository, never nested', async () => {
    const dir = repo()
    const first = await makeWorktree(dir, 'first', 'x')
    const second = await makeWorktree(first.path, 'second', 'x')
    expect(second.path).toBe(join(dir, '.workshop', 'worktrees', 'second'))
    expect(git(second.path, 'rev-parse', 'HEAD')).toBe(git(first.path, 'rev-parse', 'HEAD'))
  })
  it('refuses, saying why: not a repo, no commit yet, a name taken, a name git would not take', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'ws-wt-plain-')))
    await expect(makeWorktree(plain, 'x', 'x')).rejects.toThrow(/Not in a git repository/)
    await expect(makeWorktree(repo(false), 'x', 'x')).rejects.toThrow(/no commit yet/)
    const dir = repo()
    await makeWorktree(dir, 'taken', 'x')
    await expect(makeWorktree(dir, 'taken', 'x')).rejects.toThrow(/already a worktree folder/)
    git(dir, 'branch', 'worktree-branchy')
    await expect(makeWorktree(dir, 'branchy', 'x')).rejects.toThrow(/branch worktree-branchy already exists/)
    await expect(makeWorktree(dir, '../escape', 'x')).rejects.toThrow(/Not a worktree name/)
  })
})
