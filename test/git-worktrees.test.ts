// The Git tile's Worktrees tab, in its backend, run as shipped (tiles/git/lib): the pure rules,
// then real repositories in temp folders: the list with its sessions, ahead / behind, stale, the
// overlap warning, and the writes (rebase, merge, remove) with every refusal, a conflict undone,
// and the repository left clean. Nothing here touches a repository outside the temp folder.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript, as the tile ships it
import { overlaps, parseWorktreeList, pickBase, shortPath, staleness, STALE_DAYS } from '../tiles/git/lib/parse.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { worktreeTop } from '../tiles/git/lib/git.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { baseOf, diffAgainstBase, merge, readProject, rebase, remove } from '../tiles/git/lib/worktrees.mjs'

describe('git tile worktrees: the rules', () => {
  it('reads git worktree list --porcelain -z whole: branch, detached, bare, locked, prunable', () => {
    const z = [
      'worktree /r', 'HEAD aaaa', 'branch refs/heads/main', '',
      'worktree /r/.claude/worktrees/a b', 'HEAD bbbb', 'branch refs/heads/feature/x', 'locked', '',
      'worktree /old', 'HEAD cccc', 'detached', 'prunable gitdir file points to non-existent location', '',
      'worktree /bare', 'bare', ''
    ].join('\0')
    expect(parseWorktreeList(z)).toEqual([
      { path: '/r', head: 'aaaa', branch: 'main', detached: false, bare: false, locked: null, prunable: null },
      { path: '/r/.claude/worktrees/a b', head: 'bbbb', branch: 'feature/x', detached: false, bare: false, locked: '', prunable: null },
      { path: '/old', head: 'cccc', branch: null, detached: true, bare: false, locked: null, prunable: 'gitdir file points to non-existent location' },
      { path: '/bare', head: null, branch: null, detached: false, bare: true, locked: null, prunable: null }
    ])
  })

  it('finds main from origin/HEAD, else a local main, else master', () => {
    expect(pickBase('refs/remotes/origin/trunk', ['trunk', 'main'])).toMatchObject({ name: 'trunk', ref: 'refs/heads/trunk' })
    expect(pickBase('refs/remotes/origin/trunk', ['main'])).toMatchObject({ name: 'trunk', ref: 'refs/remotes/origin/trunk', remote: true })
    expect(pickBase(null, ['master', 'main'])).toMatchObject({ name: 'main', ref: 'refs/heads/main' })
    expect(pickBase(null, ['master'])).toMatchObject({ name: 'master' })
    expect(pickBase(null, [])).toBeNull()
  })

  it('calls a worktree stale only with no session: gone, merged and clean, or untouched for two weeks', () => {
    const now = Date.UTC(2026, 10, 10)
    const w = { main: false, isBase: false, bare: false, sessions: [], prunable: null, branch: 'x', ahead: 1, dirty: 0, touched: now - 1000 }
    expect(staleness(w, now)).toBeNull()
    expect(staleness({ ...w, ahead: 0 }, now)).toBe('merged')
    expect(staleness({ ...w, ahead: 0, dirty: 2 }, now)).toBeNull()
    expect(staleness({ ...w, touched: now - (STALE_DAYS + 1) * 86_400_000 }, now)).toBe('untouched')
    expect(staleness({ ...w, prunable: '' }, now)).toBe('gone')
    expect(staleness({ ...w, ahead: 0, sessions: [{ id: 'a' }] }, now)).toBeNull()
    expect(staleness({ ...w, ahead: 0, main: true }, now)).toBeNull()
    expect(staleness({ ...w, ahead: 0, isBase: true }, now)).toBeNull()
  })

  it('pairs worktrees that touch one file, and shortens paths to read', () => {
    const o = overlaps([
      { path: '/a', changed: ['x.ts', 'y.ts'] },
      { path: '/b', changed: ['y.ts', 'x.ts', 'z.ts'] },
      { path: '/c', changed: ['q.ts'] }
    ])
    expect(o).toEqual([{ a: '/a', b: '/b', files: ['x.ts', 'y.ts'], count: 2 }])
    expect(shortPath('/u/me/p/.claude/worktrees/side', '/u/me/p', '/u/me')).toBe('.claude/worktrees/side')
    expect(shortPath('/u/me/p', '/u/me/p', '/u/me')).toBe('p')
    expect(shortPath('/u/me/elsewhere/w', '/u/me/p', '/u/me')).toBe('~/elsewhere/w')
    expect(shortPath('/tmp/w', '/u/me/p', '/u/me')).toBe('/tmp/w')
  })
})

// ---- real repositories

const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})
// The test's own git calls carry no GIT_* from whoever runs the tests, so they act on the temp folder only.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: cleanEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const head = (cwd: string): string => sh(cwd, 'rev-parse', 'HEAD')
const commit = (cwd: string, file: string, body: string, msg = file): void => {
  writeFileSync(join(cwd, file), body)
  sh(cwd, 'add', '--', file)
  sh(cwd, 'commit', '-q', '-m', msg)
}

/** A repository on main with two files, and a worktree per name on its own branch. Git user config comes from the repo, so writes made by the tile can commit. */
function repo(...worktrees: string[]): { root: string; wt: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-wt-')))
  made.push(root)
  sh(root, 'init', '-q')
  sh(root, 'config', 'user.name', 't')
  sh(root, 'config', 'user.email', 't@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  commit(root, 'a.txt', 'one\ntwo\nthree\n')
  commit(root, 'b.txt', 'bee\n')
  const wt: Record<string, string> = {}
  for (const n of worktrees) {
    wt[n] = join(root, '.claude', 'worktrees', n)
    sh(root, 'worktree', 'add', '-q', wt[n], '-b', n)
  }
  return { root, wt }
}
const session = (id: string, folder: string, root: string, status = 'idle') => ({ id, name: id, folder, root, status })
// A project is one a session works in: each test's has one more, parked in a folder that is gone, so it is in no worktree.
const ctxOf = (sessions: ReturnType<typeof session>[]) => ({ sessions: [...sessions, ...[...new Set(made)].map((r) => session('elsewhere', join(r, 'gone'), r))], topOf: worktreeTop })
// Nested worktrees show as untracked folders of the main tree; they are not changes.
const isClean = (cwd: string): boolean => sh(cwd, 'status', '--porcelain').split('\n').filter((l) => l && l !== '?? .claude/').length === 0
const midway = (cwd: string): boolean => ['rebase-merge', 'rebase-apply', 'MERGE_HEAD'].some((p) => existsSync(sh(cwd, 'rev-parse', '--path-format=absolute', '--git-path', p)))

describe('git tile worktrees: reading a real repository', () => {
  it('lists every worktree with its sessions, branch, ahead / behind main, dirty or clean, and stale', async () => {
    const { root, wt } = repo('side', 'old')
    commit(wt.side, 'c.txt', 'sea\n')
    commit(wt.side, 'd.txt', 'dee\n')
    commit(root, 'e.txt', 'main moved\n')
    writeFileSync(join(wt.side, 'scratch.md'), 'untracked\n')
    const p = await readProject(root, { sessionsAt: (path: string) => (path === wt.side ? [{ id: 's1', name: 'one' }] : []), home: '/nowhere' })
    expect(p.base).toMatchObject({ name: 'main', how: 'no origin/HEAD; the local main', remote: false })
    const by = Object.fromEntries(p.worktrees.map((w: { short: string }) => [w.short, w]))
    expect(Object.keys(by).sort()).toEqual(['.claude/worktrees/old', '.claude/worktrees/side', root.split('/').pop()].sort())
    const main = by[root.split('/').pop()!]
    expect(main).toMatchObject({ main: true, isBase: true, branch: 'main', stale: null })
    // The main tree's .claude/worktrees folders are its own worktrees, not untracked changes.
    expect(main.files).toEqual([])
    expect(main.dirty).toBe(0)
    expect(by['.claude/worktrees/side']).toMatchObject({ branch: 'side', ahead: 2, behind: 1, dirty: 1, sessions: [{ id: 's1', name: 'one' }], stale: null, main: false })
    // `old` has no session and nothing main lacks: merged, so stale.
    expect(by['.claude/worktrees/old']).toMatchObject({ branch: 'old', ahead: 0, behind: 1, dirty: 0, stale: 'merged', sessions: [] })
  })

  it('takes main from origin/HEAD when there is one', async () => {
    const { root } = repo()
    sh(root, 'branch', 'trunk')
    sh(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    sh(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    expect(await baseOf(root)).toMatchObject({ name: 'trunk', how: 'origin/HEAD names trunk', oid: head(root) })
  })

  it('warns when two worktrees touch one file, uncommitted or committed', async () => {
    const { root, wt } = repo('x', 'y', 'z')
    commit(wt.x, 'a.txt', 'one\nTWO\nthree\n')
    writeFileSync(join(wt.y, 'a.txt'), 'ONE\ntwo\nthree\n')
    writeFileSync(join(wt.z, 'b.txt'), 'only z\n')
    const p = await readProject(root, { sessionsAt: () => [], home: '/nowhere' })
    const x = p.worktrees.find((w: { branch: string }) => w.branch === 'x')
    const z = p.worktrees.find((w: { branch: string }) => w.branch === 'z')
    expect(x.overlaps).toEqual([{ with: wt.y, short: '.claude/worktrees/y', files: ['a.txt'], count: 1 }])
    expect(z.overlaps).toEqual([])
  })

  it('diffs a worktree against main from where they parted (main’s own later commits are not in it)', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'c.txt', 'sea\n')
    writeFileSync(join(wt.side, 'a.txt'), 'one\n2\nthree\n')
    commit(root, 'b.txt', 'bee moved on main\n')
    const d = await diffAgainstBase(root, wt.side)
    expect(d.base).toBe('main')
    expect(d.files.map((f: { path: string }) => f.path).sort()).toEqual(['a.txt', 'c.txt'])
  })
})

describe('git tile worktrees: rebase', () => {
  it('rebases a clean worktree onto main', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'c.txt', 'sea\n')
    commit(root, 'e.txt', 'main moved\n')
    const r = await rebase({ root, path: wt.side }, ctxOf([session('s1', wt.side, root)]))
    expect(r).toMatchObject({ done: true })
    expect(sh(wt.side, 'merge-base', 'HEAD', 'main')).toBe(head(root))
    expect(isClean(wt.side)).toBe(true)
  })

  it('a conflict is aborted at once: the files are named, and the worktree is as it was', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'a.txt', 'one\nSIDE\nthree\n')
    commit(root, 'a.txt', 'one\nMAIN\nthree\n')
    const before = head(wt.side)
    const r = await rebase({ root, path: wt.side }, ctxOf([]))
    expect(r).toMatchObject({ done: false, conflict: true, files: ['a.txt'] })
    expect(head(wt.side)).toBe(before)
    expect(midway(wt.side)).toBe(false)
    expect(isClean(wt.side)).toBe(true)
  })

  it('refuses a dirty worktree, a busy session in it, and a page that saw something else', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'c.txt', 'sea\n')
    commit(root, 'e.txt', 'main moved\n')
    const before = head(wt.side)
    writeFileSync(join(wt.side, 'note.md'), 'new\n')
    await expect(rebase({ root, path: wt.side }, ctxOf([]))).rejects.toThrow(/uncommitted changes \(note.md\)/)
    rmSync(join(wt.side, 'note.md'))
    await expect(rebase({ root, path: wt.side }, ctxOf([session('worker', wt.side, root, 'busy')]))).rejects.toThrow(/worker is busy/)
    await expect(rebase({ root, path: wt.side }, ctxOf([session('worker', wt.side, root, 'blocked')]))).rejects.toThrow(/worker needs you/)
    await expect(rebase({ root, path: wt.side, expect: { head: 'deadbeef', base: head(root) } }, ctxOf([]))).rejects.toThrow(/changed since the tab last looked/)
    // A path that is not one of the repository's worktrees, or a project no session is in.
    await expect(rebase({ root, path: '/etc' }, ctxOf([]))).rejects.toThrow(/that worktree is gone/)
    await expect(rebase({ root: '/etc', path: '/etc' }, ctxOf([session('s', root, root)]))).rejects.toThrow(/no session works in that project/)
    expect(head(wt.side)).toBe(before)
  })
})

describe('git tile worktrees: merge', () => {
  it('merges a clean branch into main, in the worktree main is checked out in', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'c.txt', 'sea\n')
    const r = await merge({ root, path: wt.side, expect: { head: head(wt.side), base: head(root) } }, ctxOf([session('m', root, root), session('s', wt.side, root)]))
    expect(r).toMatchObject({ done: true, said: 'merged side into main' })
    expect(head(root)).toBe(head(wt.side))
    expect(isClean(root)).toBe(true)
  })

  it('a conflict is aborted: main is where it was, with no merge left under way', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'a.txt', 'one\nSIDE\nthree\n')
    commit(root, 'a.txt', 'one\nMAIN\nthree\n')
    const before = head(root)
    const r = await merge({ root, path: wt.side }, ctxOf([]))
    expect(r).toMatchObject({ done: false, conflict: true, files: ['a.txt'] })
    expect(head(root)).toBe(before)
    expect(midway(root)).toBe(false)
    expect(isClean(root)).toBe(true)
  })

  it('refuses when either worktree is dirty or a session in either is busy', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'c.txt', 'sea\n')
    const before = head(root)
    writeFileSync(join(root, 'a.txt'), 'edited on main\n')
    await expect(merge({ root, path: wt.side }, ctxOf([]))).rejects.toThrow(/the main worktree has uncommitted changes/)
    sh(root, 'checkout', '-q', '--', 'a.txt')
    writeFileSync(join(wt.side, 'a.txt'), 'edited on side\n')
    await expect(merge({ root, path: wt.side }, ctxOf([]))).rejects.toThrow(/this worktree has uncommitted changes/)
    sh(wt.side, 'checkout', '-q', '--', 'a.txt')
    await expect(merge({ root, path: wt.side }, ctxOf([session('main-s', root, root, 'busy')]))).rejects.toThrow(/main-s is busy in the main worktree/)
    await expect(merge({ root, path: wt.side }, ctxOf([session('side-s', wt.side, root, 'starting')]))).rejects.toThrow(/side-s is still starting/)
    expect(head(root)).toBe(before)
  })

  it('does nothing when no worktree has main checked out', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'c.txt', 'sea\n')
    sh(root, 'checkout', '-q', '-b', 'elsewhere')
    await expect(merge({ root, path: wt.side }, ctxOf([]))).rejects.toThrow(/no worktree has main checked out/)
    expect(sh(root, 'rev-parse', 'main')).not.toBe(head(wt.side))
  })
})

describe('git tile worktrees: remove', () => {
  it('refuses a branch with commits main does not have, and keeps it', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'c.txt', 'sea\n')
    await expect(remove({ root, path: wt.side }, ctxOf([]))).rejects.toThrow(/has commits main does not/)
    expect(existsSync(wt.side)).toBe(true)
    expect(sh(root, 'branch', '--list', 'side')).toMatch(/side/)
  })

  it('refuses a worktree a session is in, whatever it is doing, and the main worktree', async () => {
    const { root, wt } = repo('side')
    await expect(remove({ root, path: wt.side }, ctxOf([session('quiet', wt.side, root, 'idle')]))).rejects.toThrow(/quiet is still in it/)
    await expect(remove({ root, path: root }, ctxOf([]))).rejects.toThrow(/main worktree/)
    expect(existsSync(wt.side)).toBe(true)
  })

  it('removes a merged worktree and its branch', async () => {
    const { root, wt } = repo('side')
    commit(wt.side, 'c.txt', 'sea\n')
    sh(root, 'merge', '-q', '--no-edit', 'side')
    const r = await remove({ root, path: wt.side }, ctxOf([]))
    expect(r).toMatchObject({ done: true, said: 'removed the worktree and the branch side' })
    expect(existsSync(wt.side)).toBe(false)
    expect(sh(root, 'branch', '--list', 'side')).toBe('')
    expect(isClean(root)).toBe(true)
  })
})
