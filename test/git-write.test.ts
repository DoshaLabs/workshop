// The Git tile's writes on a working tree and its operation log, run as shipped (tiles/git/lib)
// against real repositories in temp folders: staging a file or one hunk, discarding (and undoing
// it), committing (and undoing it), stashing, and undoing a rebase, a merge and a remove, with the
// refusals each keeps. Nothing here touches a repository outside the temp folder.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript, as the tile ships it
import { worktreeTop } from '../tiles/git/lib/git.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { commit, discard, quietIn, stage, stash, unstage } from '../tiles/git/lib/write.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { list, undo } from '../tiles/git/lib/oplog.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { merge, rebase, remove } from '../tiles/git/lib/worktrees.mjs'

const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: cleanEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const head = (cwd: string): string => sh(cwd, 'rev-parse', 'HEAD')
const put = (cwd: string, file: string, body: string): void => writeFileSync(join(cwd, file), body)
const save = (cwd: string, file: string, body: string, msg = file): void => {
  put(cwd, file, body)
  sh(cwd, 'add', '--', file)
  sh(cwd, 'commit', '-q', '-m', msg)
}
const numbered = (n: number, change: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

function repo(...worktrees: string[]): { root: string; wt: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-write-')))
  made.push(root)
  sh(root, 'init', '-q')
  sh(root, 'config', 'user.name', 't')
  sh(root, 'config', 'user.email', 't@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  save(root, 'long.txt', numbered(30))
  save(root, 'b.txt', 'bee\n')
  const wt: Record<string, string> = {}
  for (const n of worktrees) {
    wt[n] = join(root, '.claude', 'worktrees', n)
    sh(root, 'worktree', 'add', '-q', wt[n], '-b', n)
  }
  return { root, wt }
}
const session = (id: string, folder: string, root: string, status = 'idle') => ({ id, name: id, folder, root, status })
const quiet = (sessions: ReturnType<typeof session>[] = []) => quietIn(sessions, worktreeTop)
const ctxOf = (sessions: ReturnType<typeof session>[], root: string) => ({ sessions: [...sessions, session('here', root, root)], topOf: worktreeTop })
const H1 = '@@ -1,4 +1,4 @@'

describe('git tile writes: staging', () => {
  it('stages one hunk of a file, leaving the other unstaged; refuses a header that moved', async () => {
    const { root } = repo()
    put(root, 'long.txt', numbered(30, { 1: 'first changed', 25: 'late changed' }))
    await expect(stage(root, { path: 'long.txt', hunk: 0, header: '@@ -9,9 +9,9 @@' })).rejects.toThrow(/changed since the tile drew it/)
    const r = await stage(root, { path: 'long.txt', hunk: 0, header: H1 })
    expect(r.said).toMatch(/one part of long.txt/)
    const cached = sh(root, 'diff', '--cached')
    expect(cached).toMatch(/\+first changed/)
    expect(cached).not.toMatch(/late changed/)
    expect(sh(root, 'diff')).toMatch(/\+late changed/)
    // Part of it staged: the rest goes whole.
    await expect(stage(root, { path: 'long.txt', hunk: 0, header: '@@ -22,7 +22,7 @@' })).rejects.toThrow(/stage or unstage the whole file/)
    await stage(root, { path: 'long.txt' })
    expect(sh(root, 'diff')).toBe('')
    await unstage(root, { path: 'long.txt' })
    expect(sh(root, 'diff', '--cached')).toBe('')
    await expect(stage(root, { path: 'b.txt' })).rejects.toThrow(/has no changes now/)
    await expect(stage(root, { path: '../outside' })).rejects.toThrow(/has no changes now/)
  })
})

describe('git tile writes: discard, commit, stash and their undo', () => {
  it('discards a hunk, kept for undo; undo puts it back, and refuses once the file moved on', async () => {
    const { root } = repo()
    const before = numbered(30, { 1: 'first changed', 25: 'late changed' })
    put(root, 'long.txt', before)
    await discard(root, { path: 'long.txt', hunk: 0, header: H1 }, { quiet: quiet() })
    expect(readFileSync(join(root, 'long.txt'), 'utf8')).toBe(numbered(30, { 25: 'late changed' }))
    const [e] = (await list(root)).slice(-1)
    expect(e).toMatchObject({ kind: 'discard', undoable: true })
    expect(await undo(root, e.id, { quietAt: quiet() })).toMatch(/put long.txt back/)
    expect(readFileSync(join(root, 'long.txt'), 'utf8')).toBe(before)
    await expect(undo(root, e.id, { quietAt: quiet() })).rejects.toThrow(/already undone/)

    // An untracked file: deleted, then back; a second discard's undo is refused once the file changed.
    put(root, 'new.md', 'draft\n')
    await discard(root, { path: 'new.md' }, { quiet: quiet() })
    expect(existsSync(join(root, 'new.md'))).toBe(false)
    const gone = (await list(root)).at(-1)
    put(root, 'new.md', 'someone wrote again\n')
    await expect(undo(root, gone.id, { quietAt: quiet() })).rejects.toThrow(/has changed since/)
  })

  it('refuses to discard while a session there is busy', async () => {
    const { root } = repo()
    put(root, 'b.txt', 'changed\n')
    await expect(discard(root, { path: 'b.txt' }, { quiet: quiet([session('worker', root, root, 'busy')]) })).rejects.toThrow(/worker is busy/)
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('changed\n')
  })

  it('commits what is staged; undo takes the commit back with its changes staged', async () => {
    const { root } = repo()
    const was = head(root)
    put(root, 'b.txt', 'bee two\n')
    await expect(commit(root, { message: 'x' })).rejects.toThrow(/nothing is staged/)
    await stage(root, { path: 'b.txt' })
    await expect(commit(root, { message: '   ' })).rejects.toThrow(/needs a message/)
    const r = await commit(root, { message: 'Bee, again\n\nwith a body' })
    expect(r.said).toBe('committed "Bee, again" to main')
    expect(head(root)).not.toBe(was)
    const e = (await list(root)).at(-1)
    await undo(root, e.id, { quietAt: quiet() })
    expect(head(root)).toBe(was)
    expect(sh(root, 'diff', '--cached', '--name-only')).toBe('b.txt')
  })

  it('stashes every change, untracked too; undo pops it back', async () => {
    const { root } = repo()
    put(root, 'b.txt', 'stashed\n')
    put(root, 'loose.md', 'untracked\n')
    await stash(root, { quiet: quiet() })
    expect(sh(root, 'status', '--porcelain')).toBe('')
    const e = (await list(root)).at(-1)
    await undo(root, e.id, { quietAt: quiet() })
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('stashed\n')
    expect(existsSync(join(root, 'loose.md'))).toBe(true)
  })
})

describe('git tile writes: the operation log undoes the Worktrees tab', () => {
  it('a rebase, by putting the branch back on its old tip', async () => {
    const { root, wt } = repo('side')
    save(wt.side, 'c.txt', 'sea\n')
    save(root, 'm.txt', 'main moved\n')
    const old = head(wt.side)
    const r = await rebase({ root, path: wt.side }, ctxOf([], root))
    expect(r.done).toBe(true)
    expect(head(wt.side)).not.toBe(old)
    const e = (await list(root)).at(-1)
    expect(e).toMatchObject({ kind: 'rebase', undoable: true })
    await expect(undo(root, e.id, { quietAt: quiet([session('w', wt.side, root, 'busy')]) })).rejects.toThrow(/w is busy/)
    await undo(root, e.id, { quietAt: quiet() })
    expect(head(wt.side)).toBe(old)
  })

  it('a merge, by putting main back; refused once main moved on', async () => {
    const { root, wt } = repo('feat')
    save(wt.feat, 'f.txt', 'feature\n')
    const was = head(root)
    await merge({ root, path: wt.feat }, ctxOf([], root))
    expect(head(root)).not.toBe(was)
    const e = (await list(root)).at(-1)
    save(root, 'later.txt', 'after the merge\n')
    await expect(undo(root, e.id, { quietAt: quiet() })).rejects.toThrow(/has moved since/)
  })

  it('a remove, by restoring the branch and the worktree', async () => {
    const { root, wt } = repo('done')
    await remove({ root, path: wt.done }, ctxOf([], root))
    expect(existsSync(wt.done)).toBe(false)
    const e = (await list(root)).at(-1)
    expect(e).toMatchObject({ kind: 'remove', undoable: true })
    await undo(root, e.id, { quietAt: quiet() })
    expect(existsSync(join(wt.done, 'b.txt'))).toBe(true)
    expect(sh(root, 'branch', '--list', 'done')).toMatch(/done/)
  })
})
