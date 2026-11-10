// The Git tile's backend, run as shipped (tiles/git/lib): git's output read into what the page
// draws, then the same against real repositories in a temp folder (a worktree, untracked and
// binary files, a rename, a repo with no commit yet).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript, as the tile ships it
import { countLines, group, parseDiff, parseNumstat, parseStatus, summarize, unquote, untrackedDiff } from '../tiles/git/lib/parse.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { changes, diff, git, worktreeTop } from '../tiles/git/lib/git.mjs'

describe('git tile: reading git', () => {
  it('reads porcelain v2: the branch, each kind of entry, paths with spaces, a rename’s origin', () => {
    const z = [
      '# branch.oid 1234567890abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
      '1 A. N... 000000 100644 100644 000 ccc new.ts',
      '1 D. N... 100644 000000 000000 ddd 000 gone.ts',
      '2 R. N... 100644 100644 100644 eee eee R100 b.ts',
      'old b.ts',
      'u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.ts',
      '1 .M SC.. 160000 160000 160000 g1 g1 vendor/lib',
      '? notes/todo.md',
      ''
    ].join('\0')
    const s = parseStatus(z)
    expect(s.branch).toEqual({ head: 'main', oid: '1234567890abcdef', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(s.files).toEqual([
      { path: 'src/a file.ts', kind: 'modified', staged: false, unstaged: true },
      { path: 'new.ts', kind: 'added', staged: true, unstaged: false },
      { path: 'gone.ts', kind: 'deleted', staged: true, unstaged: false },
      { path: 'b.ts', kind: 'renamed', staged: true, unstaged: false, from: 'old b.ts' },
      { path: 'conflict.ts', kind: 'conflict', staged: true, unstaged: true },
      { path: 'vendor/lib', kind: 'modified', staged: false, unstaged: true, submodule: true },
      { path: 'notes/todo.md', kind: 'untracked', staged: false, unstaged: true }
    ])
    expect(s.more).toBe(false)
  })

  it('a detached head or no commit yet reads as null; a status cut short drops its partial entry', () => {
    const s = parseStatus(['# branch.oid (initial)', '# branch.head (detached)', '? a', '? b-partial'].join('\0'), true)
    expect(s.branch.oid).toBeNull()
    expect(s.branch.head).toBeNull()
    expect(s.files.map((f: { path: string }) => f.path)).toEqual(['a'])
    expect(s.more).toBe(true)
  })

  it('reads numstat -z: counts, a binary file, a rename under its new name', () => {
    const m = parseNumstat(['3\t1\ta.ts', '-\t-\tlogo.png', '5\t0\t', 'old.ts', 'new.ts', ''].join('\0'))
    expect(m.get('a.ts')).toEqual({ add: 3, del: 1, binary: false })
    expect(m.get('logo.png')).toEqual({ add: null, del: null, binary: true })
    expect(m.get('new.ts')).toEqual({ add: 5, del: 0, binary: false })
    expect(m.has('old.ts')).toBe(false)
  })

  it('counts an untracked file’s lines, a last line without a newline included; NUL means binary', () => {
    expect(countLines(Buffer.from('a\nb\n'))).toEqual({ add: 2, del: 0, binary: false })
    expect(countLines(Buffer.from('a\nb'))).toEqual({ add: 2, del: 0, binary: false })
    expect(countLines(Buffer.from(''))).toEqual({ add: 0, del: 0, binary: false })
    expect(countLines(Buffer.from([1, 0, 2]))).toEqual({ add: null, del: null, binary: true })
  })

  it('totals a summary from status, numstat and untracked counts', () => {
    const st = parseStatus(['# branch.oid x', '# branch.head main', '1 .M N... 1 1 1 a b a.ts', '? n.ts', '? big.bin', ''].join('\0'))
    const sum = summarize(st, parseNumstat('3\t1\ta.ts\0'), new Map([['n.ts', { add: 4, del: 0, binary: false }]]))
    expect(sum).toMatchObject({ count: 3, add: 7, del: 1 })
    expect(sum.files[2]).toMatchObject({ path: 'big.bin', add: null, del: null })
  })

  it('unquotes C-quoted paths, octal UTF-8 included', () => {
    expect(unquote('"a\\tb"')).toBe('a\tb')
    expect(unquote('"caf\\303\\251 \\"x\\""')).toBe('café "x"')
    expect(unquote('plain')).toBe('plain')
  })

  it('parses a unified diff into files and hunks, a removed line that reads "--- x" included', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,4 +1,4 @@ function f() {',
      ' one',
      '--- not a header',
      '+++ not a header either',
      ' three',
      '',
      'diff --git a/new file.txt b/new file.txt',
      'new file mode 100644',
      'index 0..3',
      '--- /dev/null',
      '+++ b/new file.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      '\\ No newline at end of file',
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'index 0..4',
      'Binary files /dev/null and b/logo.png differ',
      'diff --git a/old.ts b/moved.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to moved.ts',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git "a/tab\\there" "b/tab\\there"',
      'old mode 100644',
      'new mode 100755',
      ''
    ].join('\n')
    const files = parseDiff(text)
    expect(files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['new file.txt', 'added'],
      ['logo.png', 'added'],
      ['moved.ts', 'renamed'],
      ['gone.ts', 'deleted'],
      ['tab\there', 'modified']
    ])
    expect(files[0].hunks).toEqual([{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, section: 'function f() {', lines: [' one', '--- not a header', '+++ not a header either', ' three', ' '] }])
    expect(files[1].hunks[0].lines).toEqual(['+hello', '\\ No newline at end of file'])
    expect(files[2]).toMatchObject({ binary: true, hunks: [] })
    expect(files[3].from).toBe('old.ts')
    expect(files[4].hunks[0].lines).toEqual(['-bye'])
    expect(files.every((f: { truncated: boolean }) => !f.truncated)).toBe(true)
  })

  it('cuts a long diff per file and in all, and says how many lines were left out', () => {
    const many = (path: string, n: number): string[] => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -0,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+${i}`)]
    const files = parseDiff([...many('a', 10), ...many('b', 10), ...many('c', 3)].join('\n'), { fileLines: 6, totalLines: 8 })
    expect(files[0]).toMatchObject({ truncated: true, cutLines: 4 })
    expect(files[0].hunks[0].lines).toHaveLength(6)
    expect(files[1]).toMatchObject({ truncated: true, cutLines: 8 })
    expect(files[1].hunks[0].lines).toHaveLength(2)
    expect(files[2]).toMatchObject({ truncated: true, cutLines: 3, hunks: [] })
    const long = parseDiff(['diff --git a/x b/x', '@@ -1 +1 @@', `+${'y'.repeat(5000)}`].join('\n'))
    expect(long[0].hunks[0].lines[0].length).toBeLessThan(2100)
    expect(parseDiff(many('d', 5).slice(0, 6).join('\n'), { cut: true })[0].truncated).toBe(true)
  })

  it('an untracked file as a diff is one hunk of added lines; binary is named, not shown', () => {
    expect(untrackedDiff('n.txt', Buffer.from('a\nb'))).toMatchObject({ status: 'untracked', hunks: [{ oldStart: 0, newStart: 1, newLines: 2, lines: ['+a', '+b', '\\ No newline at end of file'] }] })
    expect(untrackedDiff('x.bin', Buffer.from([0, 1]))).toMatchObject({ binary: true, hunks: [] })
    expect(untrackedDiff('e', Buffer.alloc(0)).hunks).toEqual([])
    expect(untrackedDiff('l', Buffer.from('1\n2\n3\n'), { fileLines: 2 })).toMatchObject({ truncated: true, cutLines: 1 })
  })

  it('groups sessions by project, then worktree: two sessions in one worktree share one line', () => {
    const sessions = [
      { id: 'a', name: 'fix-auth', folder: '/r', root: '/r' },
      { id: 'b', name: 'tests', folder: '/r/src', root: '/r' },
      { id: 'c', name: 'feature', folder: '/r/.claude/worktrees/f', root: '/r' },
      { id: 'd', name: 'scratch', folder: '/tmp/x', root: '/tmp/x' },
      { id: 'e', name: 'site', folder: '/a/site', root: '/a/site' }
    ]
    const places = new Map([['a', '/r'], ['b', '/r'], ['c', '/r/.claude/worktrees/f'], ['d', null], ['e', '/a/site']])
    const found = new Map([['/r', { count: 2 }], ['/r/.claude/worktrees/f', { count: 1 }], ['/a/site', { error: 'boom' }]])
    const p = group(sessions, places, found)
    expect(p.map((x: { name: string }) => x.name)).toEqual(['r', 'site', 'x'])
    expect(p[0].worktrees).toMatchObject([
      { top: '/r', main: true, count: 2, sessions: [{ id: 'a', name: 'fix-auth' }, { id: 'b', name: 'tests' }] },
      { top: '/r/.claude/worktrees/f', main: false, name: 'f', count: 1, sessions: [{ id: 'c' }] }
    ])
    expect(p[1].worktrees[0].error).toBe('boom')
    expect(p[2]).toMatchObject({ worktrees: [], outside: [{ id: 'd', name: 'scratch' }] })
  })
})

describe('git tile: against real repositories', () => {
  const made: string[] = []
  const temp = (): string => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'ws-gittile-')))
    made.push(d)
    return d
  }
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true })
  })
  const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' })
  function repo(): string {
    const r = temp()
    run(r, 'init', '-q')
    writeFileSync(join(r, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(r, 'old name.txt'), 'moved\nfile\nwith\nseveral\nlines\n')
    writeFileSync(join(r, 'gone.txt'), 'bye\n')
    run(r, 'add', '.')
    run(r, 'commit', '-q', '-m', 'one')
    return r
  }

  it('counts a working tree: a change, a staged rename, a deletion, untracked text and binary', async () => {
    const r = repo()
    writeFileSync(join(r, 'a.txt'), 'one\n2\nthree\nfour\n')
    run(r, 'mv', 'old name.txt', 'new name.txt')
    run(r, 'rm', '-q', 'gone.txt')
    mkdirSync(join(r, 'notes'))
    writeFileSync(join(r, 'notes', 'n.md'), 'x\ny\nz')
    writeFileSync(join(r, 'logo.bin'), Buffer.from([0, 1, 2, 3]))
    symlinkSync('/etc/hosts', join(r, 'link'))
    const c = await changes(r)
    expect(c.branch.head).toBe('main')
    const by = Object.fromEntries(c.files.map((f: { path: string }) => [f.path, f]))
    expect(by['a.txt']).toMatchObject({ kind: 'modified', add: 2, del: 1 })
    expect(by['new name.txt']).toMatchObject({ kind: 'renamed', from: 'old name.txt', add: 0, del: 0 })
    expect(by['gone.txt']).toMatchObject({ kind: 'deleted', add: 0, del: 1 })
    expect(by['notes/n.md']).toMatchObject({ kind: 'untracked', add: 3, del: 0 })
    expect(by['logo.bin']).toMatchObject({ kind: 'untracked', binary: true, add: null })
    // A symlink is its target's name, one line, as git would diff it; never the file it points at.
    expect(by.link).toMatchObject({ kind: 'untracked', add: 1 })
    expect(c).toMatchObject({ count: 6, add: 6, del: 2 })

    const d = await diff(r)
    const files = Object.fromEntries(d.files.map((f: { path: string }) => [f.path, f]))
    expect(files['a.txt'].hunks[0].lines).toEqual([' one', '-two', '+2', ' three', '+four'])
    expect(files['new name.txt']).toMatchObject({ status: 'renamed', from: 'old name.txt' })
    expect(files['gone.txt']).toMatchObject({ status: 'deleted' })
    expect(files['notes/n.md'].hunks[0].lines).toEqual(['+x', '+y', '+z', '\\ No newline at end of file'])
    expect(files['logo.bin']).toMatchObject({ binary: true, hunks: [] })
    expect(files.link.hunks[0].lines).toEqual(['+/etc/hosts', '\\ No newline at end of file'])
  })

  it('a worktree is its own working tree, with the main repo as its project', async () => {
    const r = repo()
    const wt = join(r, '.claude', 'worktrees', 'f')
    run(r, 'worktree', 'add', '-q', wt, '-b', 'feature')
    writeFileSync(join(wt, 'a.txt'), 'changed\n')
    expect(await worktreeTop(wt)).toBe(wt)
    expect(await worktreeTop(join(r, '.claude'))).toBe(r)
    expect(await worktreeTop(temp())).toBeNull()
    const [main, side] = await Promise.all([changes(r), changes(wt)])
    // The worktree folder is inside the main tree; git lists it there as an untracked folder, which is dropped.
    expect(main.count).toBe(0)
    expect(side).toMatchObject({ count: 1, add: 1, del: 3, branch: { head: 'feature' } })
  })

  it('a repo with no commit yet is diffed against the empty tree', async () => {
    const r = temp()
    run(r, 'init', '-q')
    writeFileSync(join(r, 'first.txt'), 'a\nb\n')
    run(r, 'add', 'first.txt')
    const c = await changes(r)
    expect(c.branch.oid).toBeNull()
    expect(c.files).toMatchObject([{ path: 'first.txt', kind: 'added', add: 2, del: 0 }])
    expect((await diff(r)).files[0]).toMatchObject({ path: 'first.txt', status: 'added', hunks: [{ lines: ['+a', '+b'] }] })
  })

  it('never takes the index lock: a held lock does not stop it, and it leaves none behind', async () => {
    const r = repo()
    writeFileSync(join(r, 'a.txt'), 'x\n')
    writeFileSync(join(r, '.git', 'index.lock'), '')
    const c = await changes(r)
    expect(c.count).toBe(1)
    rmSync(join(r, '.git', 'index.lock'))
    await changes(r)
    expect(() => execFileSync('test', ['-e', join(r, '.git', 'index.lock')])).toThrow()
  })

  it('a git call is cut at its cap and says so', async () => {
    const r = repo()
    const out = await git(r, ['log', '--format=%H%n%H%n%H'], { cap: 10 })
    expect(out.out.length).toBe(10)
    expect(out.cut).toBe(true)
  })
})
