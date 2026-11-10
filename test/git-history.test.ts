// The Git tile's History tab and core's commit records, run as shipped: the log read and parsed
// (merges, refs, unicode, a repository with no commits), one commit's diff, which session made a
// commit (exact from core's records, a guess from the worktree and the time, or none), the
// "Today, by session" grouping, and core's side: which commands commit, the reflog read after a
// Bash call, and the store (atomic, pruned, kept across a restart). Real repositories in temp
// folders only; nothing here touches any other repository.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript, as the tile ships it
import { LOG_FORMAT, LOG_MAX, LOG_PAGE, attribute, isSha, logLimit, parseLog, parseRef, reachable } from '../tiles/git/lib/log.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { projectHistory, readLog, showCommit } from '../tiles/git/lib/history.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { worktreeTop } from '../tiles/git/lib/git.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { DAY_MS, ago, byLabel, byTitle, groupCount, orList, refsShown, todayBySession } from '../tiles/git/dist/model.js'
import { CommitRecorder, CommitStore, STORE_MAX, commandDirs, commitsOfCall, isCommitCommand, madeCommit, parseReflog, readReflog } from '../src/main/commits'
import { SessionSettings } from '../src/main/hooks'

const temps: string[] = []
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(d)
  return d
}

// Every git call here is in a temp repository, with its own identity and no signing.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd: string, file: string, body: string, msg = file): string => {
  writeFileSync(join(cwd, file), body)
  git(cwd, 'add', '--', file)
  git(cwd, 'commit', '-q', '-m', msg)
  return git(cwd, 'rev-parse', 'HEAD')
}
const repo = (): string => {
  const d = temp('ws-hist-')
  git(d, 'init', '-q')
  return d
}

describe('history: reading the log', () => {
  it('parses refs as --decorate=full writes them', () => {
    expect(parseRef('HEAD -> refs/heads/main')).toEqual({ name: 'main', kind: 'head' })
    expect(parseRef('HEAD')).toEqual({ name: 'HEAD', kind: 'head' })
    expect(parseRef('refs/heads/feature/x')).toEqual({ name: 'feature/x', kind: 'branch' })
    expect(parseRef('refs/remotes/origin/main')).toEqual({ name: 'origin/main', kind: 'remote' })
    expect(parseRef('refs/remotes/origin/HEAD')).toBeNull()
    expect(parseRef('tag: refs/tags/v1.0')).toEqual({ name: 'v1.0', kind: 'tag' })
    expect(parseRef('refs/stash')).toBeNull()
  })

  it('parses -z records: merges, refs, a subject with the separator in it, and a cut record dropped', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const c = 'c'.repeat(40)
    const z = [`${a}\x1f${b} ${c}\x1fAnn\x1f100\x1f200\x1fHEAD -> refs/heads/main, tag: refs/tags/v1\x1fMerge it`, `${b}\x1f\x1fBo\x1f50\x1f60\x1f\x1fodd \x1f subject`, ''].join('\0')
    expect(parseLog(z)).toEqual([
      { sha: a, parents: [b, c], author: 'Ann', at: 100_000, ct: 200_000, refs: [{ name: 'main', kind: 'head' }, { name: 'v1', kind: 'tag' }], subject: 'Merge it' },
      { sha: b, parents: [], author: 'Bo', at: 50_000, ct: 60_000, refs: [], subject: 'odd \x1f subject' }
    ])
    expect(parseLog(z.slice(0, 60), true)).toEqual([])
    expect(parseLog('')).toEqual([])
    expect(LOG_FORMAT).toContain('%D')
  })

  it('reads a real repository: every branch and tag, merges, unicode subjects, no stash', async () => {
    const d = repo()
    const first = commit(d, 'a.txt', '1\n', 'first')
    git(d, 'checkout', '-q', '-b', 'side')
    const side = commit(d, 'b.txt', '1\n', 'côté ✓ 日本語')
    git(d, 'checkout', '-q', 'main')
    commit(d, 'a.txt', '2\n', 'second')
    git(d, 'merge', '-q', '--no-edit', 'side')
    git(d, 'tag', 'v1')
    writeFileSync(join(d, 'a.txt'), 'dirty\n')
    git(d, 'stash', '-q')
    const log = await readLog(d, 300)
    expect(log.more).toBe(false)
    expect(log.commits).toHaveLength(4)
    const [merge] = log.commits
    expect(merge.parents).toHaveLength(2)
    expect(merge.refs).toEqual(expect.arrayContaining([{ name: 'main', kind: 'head' }, { name: 'v1', kind: 'tag' }]))
    expect(log.commits.find((c: { sha: string }) => c.sha === side)).toMatchObject({ subject: 'côté ✓ 日本語', refs: [{ name: 'side', kind: 'branch' }] })
    expect(log.commits.at(-1).sha).toBe(first)
    expect(log.commits.some((c: { subject: string }) => /WIP on|index on/.test(c.subject))).toBe(false)
  })

  it('says there are more past the limit', async () => {
    const d = repo()
    for (let i = 0; i < 4; i++) commit(d, 'f.txt', `${i}\n`, `c${i}`)
    const log = await readLog(d, 3)
    expect(log.commits.map((c: { subject: string }) => c.subject)).toEqual(['c3', 'c2', 'c1'])
    expect(log.more).toBe(true)
  })

  it('reads a repository with no commits as an empty log, not an error', async () => {
    const d = repo()
    await expect(readLog(d, 300)).resolves.toEqual({ commits: [], more: false })
  })

  it('keeps how many a page may ask for within one page and 3,000, and a sha to a full one', () => {
    expect(logLimit(undefined)).toBe(LOG_PAGE)
    expect(logLimit(10)).toBe(LOG_PAGE)
    expect(logLimit(600)).toBe(600)
    expect(logLimit(1e9)).toBe(LOG_MAX)
    expect(isSha('a'.repeat(40))).toBe(true)
    expect(isSha('a'.repeat(64))).toBe(true)
    expect(isSha('abc1234')).toBe(false)
    expect(isSha('HEAD')).toBe(false)
    expect(isSha('--output=/tmp/x')).toBe(false)
  })
})

describe('history: one commit\'s diff', () => {
  it('shows a commit against its parent, the first commit as all added, and a merge against its first parent', async () => {
    const d = repo()
    const first = commit(d, 'a.txt', 'one\n')
    const second = commit(d, 'a.txt', 'one\ntwo\n')
    git(d, 'checkout', '-q', '-b', 'side')
    commit(d, 'b.txt', 'b\n')
    git(d, 'checkout', '-q', 'main')
    commit(d, 'c.txt', 'c\n')
    git(d, 'merge', '-q', '--no-edit', 'side')
    const merge = git(d, 'rev-parse', 'HEAD')
    expect((await showCommit(d, first)).files).toMatchObject([{ path: 'a.txt', status: 'added', hunks: [{ lines: ['+one'] }] }])
    expect((await showCommit(d, second)).files).toMatchObject([{ path: 'a.txt', status: 'modified', hunks: [{ lines: [' one', '+two'] }] }])
    expect((await showCommit(d, merge)).files.map((f: { path: string }) => f.path)).toEqual(['b.txt'])
  })

  it('refuses what is not a commit of that project', async () => {
    const d = repo()
    commit(d, 'a.txt', 'a\n')
    const tree = git(d, 'rev-parse', 'HEAD^{tree}')
    await expect(showCommit(d, tree)).rejects.toThrow(/no such commit/)
    await expect(showCommit(d, 'f'.repeat(40))).rejects.toThrow(/no such commit/)
  })
})

describe('history: which session made a commit', () => {
  const c = (sha: string, parents: string[], ct: number) => ({ sha, parents, ct, at: ct, author: 'x', refs: [], subject: sha })
  // main: m1 ← m2; feat: m1 ← f1 ← f2
  const log = [c('f2', ['f1'], 500), c('m2', ['m1'], 400), c('f1', ['m1'], 300), c('m1', [], 100)]

  it('walks parents among the commits read', () => {
    expect([...reachable(log, 'f2')].sort()).toEqual(['f1', 'f2', 'm1'])
    expect([...reachable(log, 'nope')]).toEqual([])
  })

  it('tags exactly what core recorded, whatever the guesses say', () => {
    const out = attribute(log, { records: new Map([['m1', { session: 'old1', name: 'gone-now' }]]), sessions: [], now: 1000 })
    expect(out.find((x: { sha: string }) => x.sha === 'm1').by).toEqual({ kind: 'exact', ids: ['old1'], names: ['gone-now'] })
    expect(out.find((x: { sha: string }) => x.sha === 'f1').by).toBeNull()
  })

  it('guesses a commit on the branch of a session\'s worktree, made in its lifetime', () => {
    const feat = { id: 's1', name: 'wt-feat', started: 250, ended: null, head: 'f2', onBase: false }
    const out = attribute(log, { records: new Map(), sessions: [feat], now: 1000 })
    const by = (sha: string) => out.find((x: { sha: string }) => x.sha === sha).by
    expect(by('f2')).toEqual({ kind: 'probable', ids: ['s1'], names: ['wt-feat'] })
    expect(by('f1')).toEqual({ kind: 'probable', ids: ['s1'], names: ['wt-feat'] })
    // Before the session started: not its.
    expect(by('m1')).toBeNull()
    // In its lifetime but not on its branch: not its.
    expect(by('m2')).toBeNull()
  })

  it('ends a dead session\'s lifetime at its last activity', () => {
    const feat = { id: 's1', name: 'wt-feat', started: 250, ended: 350, head: 'f2', onBase: false }
    const out = attribute(log, { records: new Map(), sessions: [feat], now: 1000 })
    expect(out.find((x: { sha: string }) => x.sha === 'f1').by?.ids).toEqual(['s1'])
    expect(out.find((x: { sha: string }) => x.sha === 'f2').by).toBeNull()
  })

  it('prefers a session away from main over one on main, and names every one still in the running', () => {
    const onMain = { id: 'm', name: 'on-main', started: 0, ended: null, head: 'f2', onBase: true }
    const feat = { id: 's1', name: 'wt-feat', started: 0, ended: null, head: 'f2', onBase: false }
    const also = { id: 's2', name: 'wt-also', started: 0, ended: null, head: 'f2', onBase: false }
    expect(attribute(log, { records: new Map(), sessions: [onMain, feat], now: 1000 })[0].by).toEqual({ kind: 'probable', ids: ['s1'], names: ['wt-feat'] })
    expect(attribute(log, { records: new Map(), sessions: [onMain], now: 1000 })[0].by).toEqual({ kind: 'probable', ids: ['m'], names: ['on-main'] })
    expect(attribute(log, { records: new Map(), sessions: [feat, also], now: 1000 })[0].by).toEqual({ kind: 'probable', ids: ['s1', 's2'], names: ['wt-feat', 'wt-also'] })
  })

  it('tags a real project: exact from records, a guess from a session\'s worktree, none outside it', async () => {
    const d = repo()
    const base = commit(d, 'a.txt', 'a\n', 'before any session')
    const wt = join(d, '.claude', 'worktrees', 'feat')
    git(d, 'worktree', 'add', '-q', wt, '-b', 'feat')
    const exact = commit(wt, 'b.txt', 'b\n', 'recorded')
    const guessed = commit(wt, 'c.txt', 'c\n', 'not recorded')
    const elsewhere = commit(d, 'd.txt', 'd\n', 'on main, no session there')
    const top = (f: string) => worktreeTop(f)
    const sessions = [{ id: 'feat01', name: 'wt-feat', folder: wt, root: d, status: 'idle', started: Date.now() - 60_000, active: null }]
    const h = await projectHistory(d, { limit: 300, sessions, topOf: top, records: new Map([[exact, { session: 'feat01', name: 'wt-feat' }]]) })
    const by = (sha: string) => h.commits.find((x: { sha: string }) => x.sha === sha).by
    expect(by(exact)).toEqual({ kind: 'exact', ids: ['feat01'], names: ['wt-feat'] })
    expect(by(guessed)).toEqual({ kind: 'probable', ids: ['feat01'], names: ['wt-feat'] })
    expect(by(elsewhere)).toBeNull()
    // Committed on main, which feat's branch reaches, but a minute before the session began.
    const old = await projectHistory(d, { limit: 300, sessions: [{ ...sessions[0], started: Date.now() + 60_000 }], topOf: top, records: new Map() })
    expect(old.commits.find((x: { sha: string }) => x.sha === base).by).toBeNull()
  })
})

describe('history: the page\'s rules', () => {
  const now = Date.UTC(2026, 10, 10, 12)
  const exact = (id: string, name: string) => ({ kind: 'exact', ids: [id], names: [name] })
  const guess = (ids: string[], names: string[]) => ({ kind: 'probable', ids, names })
  const k = (sha: string, ct: number, by: unknown) => ({ sha, parents: [], ct, at: ct, author: 'x', refs: [], subject: sha, by })

  it('says an exact tag as the name, a guess as "probably", and nothing for none', () => {
    expect(byLabel(exact('a', 'wt-feat'))).toBe('wt-feat')
    expect(byLabel(guess(['a'], ['wt-feat']))).toBe('probably wt-feat')
    expect(byLabel(guess(['a', 'b', 'c'], ['x', 'y', 'z']))).toBe('probably x, y or z')
    expect(byLabel(null)).toBe('')
    expect(orList(['a', 'b'])).toBe('a or b')
    expect(byTitle(guess(['a'], ['x']))).toMatch(/guess/i)
    for (const b of [exact('a', 'x'), guess(['a'], ['x']), null]) expect(`${byLabel(b)} ${byTitle(b)}`).not.toMatch(/claude/i)
  })

  it('says how long ago', () => {
    expect(ago(now - 10_000, now)).toBe('just now')
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(ago(now - 30 * 3_600_000, now)).toBe('yesterday')
    expect(ago(now - 4 * DAY_MS, now)).toBe('4 days ago')
    expect(ago(Date.UTC(2026, 0, 2), now)).toBe('2026-01-02')
  })

  it('groups the last 24 hours by session, guesses with their session, unsure and untagged apart', () => {
    const projects = [
      {
        root: '/p',
        name: 'p',
        commits: [
          k('n1', now - 60_000, exact('s1', 'one')),
          k('n2', now - 120_000, guess(['s2'], ['two'])),
          k('n3', now - 180_000, guess(['s1', 's2'], ['one', 'two'])),
          k('n4', now - 240_000, null),
          k('n5', now - 300_000, guess(['s1'], ['one'])),
          k('old', now - DAY_MS - 1, exact('s1', 'one'))
        ]
      }
    ]
    const g = todayBySession(projects, now)
    expect(g.map((x: { key: string }) => x.key)).toEqual(['s s1', 's s2', 'unsure /p', 'none /p'])
    expect(g[0].commits.map((c: { sha: string }) => c.sha)).toEqual(['n1', 'n5'])
    expect(groupCount(g[0])).toBe('2 commits, 1 a guess')
    expect(groupCount(g[1])).toBe('1 commit, all guesses')
    expect(groupCount(g[3])).toBe('1 commit')
    expect(g.flatMap((x: { commits: { sha: string }[] }) => x.commits.map((c) => c.sha))).not.toContain('old')
    expect(todayBySession([{ root: '/p', name: 'p', commits: [k('old', now - DAY_MS - 1, null)] }], now)).toEqual([])
  })

  it('puts the checked-out branch first among a commit\'s refs', () => {
    expect(refsShown([{ name: 'origin/main', kind: 'remote' }, { name: 'v1', kind: 'tag' }, { name: 'main', kind: 'head' }, { name: 'b', kind: 'branch' }]).map((r: { name: string }) => r.name)).toEqual(['main', 'b', 'v1', 'origin/main'])
  })
})

describe('commits: which commands commit', () => {
  it('knows git\'s committing subcommands, with global options before them', () => {
    for (const cmd of [
      'git commit -m "x"',
      'git add . && git commit -am fix',
      'cd sub; git merge --no-edit feat',
      'git -C ../other cherry-pick abc123',
      'git -c user.name=x rebase main',
      'git --no-pager revert HEAD',
      'git am < patch',
      'git pull --rebase',
      '(git commit --amend --no-edit)'
    ])
      expect(isCommitCommand(cmd), cmd).toBe(true)
    for (const cmd of ['git status', 'git log --grep commit', 'git diff', 'echo git commit-graph', 'gitcommit', 'git show HEAD:commit.txt', 'git commit-tree abc', 'npm run commit', 'git stash', 'git push']) expect(isCommitCommand(cmd), cmd).toBe(false)
    expect(isCommitCommand(undefined)).toBe(false)
  })

  it('finds the folders a command works in: its cwd, git -C and cd', () => {
    expect(commandDirs('git commit -m x', '/r')).toEqual(['/r'])
    expect(commandDirs('git -C ../o commit -m x', '/r/a')).toEqual(['/r/a', '/r/o'])
    expect(commandDirs('cd "/x y" && git commit', '/r')).toEqual(['/r', '/x y'])
    expect(commandDirs('cd $HOME && git commit; cd ~/x && git commit', '/r')).toEqual(['/r'])
  })

  it('reads the reflog, and knows which moves made a commit', () => {
    const a = 'a'.repeat(40)
    expect(parseReflog(`${a}\x1fHEAD@{1700000000}\x1fcommit: x\0junk\0`)).toEqual([{ sha: a, at: 1_700_000_000_000, message: 'commit: x' }])
    for (const m of ['commit: x', 'commit (initial): x', 'commit (amend): x', 'commit (merge): x', "merge feat: Merge made by the 'ort' strategy.", 'cherry-pick: x', 'revert: Revert "x"', 'rebase (pick): x', 'rebase -i (pick): x', 'rebase (continue): x', 'am: x', "pull: Merge made by the 'ort' strategy."])
      expect(madeCommit(m), m).toBe(true)
    for (const m of ['merge feat: Fast-forward', 'pull: Fast-forward', 'checkout: moving from a to b', 'reset: moving to HEAD~1', 'rebase (start): checkout main', 'rebase (finish): returning to refs/heads/x', 'rebase -i (finish): returning', 'branch: Created from HEAD'])
      expect(madeCommit(m), m).toBe(false)
  })
})

describe('commits: what a Bash call made', () => {
  const payload = (cwd: string, command: string, extra: Record<string, unknown> = {}) => ({ session_id: 'x', hook_event_name: 'PostToolUse', cwd, tool_name: 'Bash', tool_input: { command, description: 'd' }, tool_response: { stdout: '', stderr: '' }, duration_ms: 500, ...extra })

  it('finds the commit a call just made, and nothing for a call that made none', async () => {
    const d = repo()
    commit(d, 'a.txt', 'a\n')
    const made = commit(d, 'b.txt', 'b\n')
    const shas = await commitsOfCall(payload(d, 'git add b.txt && git commit -m b'))
    expect(shas).toContain(made)
    expect(await commitsOfCall(payload(d, 'git status'))).toEqual([])
    expect(await commitsOfCall({ ...payload(d, 'git commit -m b'), tool_name: 'Read' })).toEqual([])
    expect(await commitsOfCall(payload('relative/dir', 'git commit -m b'))).toEqual([])
  })

  it('looks only as far back as the call ran', async () => {
    const d = repo()
    commit(d, 'a.txt', 'a\n')
    // The reflog keeps seconds: a call that ended a minute after the commit did not make it.
    expect(await commitsOfCall(payload(d, 'git commit --amend --no-edit'), Date.now() + 60_000)).toEqual([])
  })

  it('does not take a commit made just before the call started', async () => {
    const now = Date.UTC(2026, 10, 10, 12, 0, 10)
    const sha = (c: string) => c.repeat(40)
    const reflog = async () => [
      { sha: sha('c'), at: now, message: 'commit: by the call' },
      { sha: sha('b'), at: now - 2000, message: 'commit: someone else, a moment before' }
    ]
    const d = repo()
    expect(await commitsOfCall(payload(d, 'git commit -m x', { duration_ms: 500 }), now, reflog)).toEqual([sha('c')])
  })

  it('does not count a fast-forward, whose commits were made elsewhere', async () => {
    const d = repo()
    commit(d, 'a.txt', 'a\n')
    git(d, 'checkout', '-q', '-b', 'feat')
    const theirs = commit(d, 'b.txt', 'b\n')
    git(d, 'checkout', '-q', 'main')
    // Everything before the merge happened "before the call".
    const reflog = async (dir: string) => (await readReflog(dir)).map((e) => (e.message.startsWith('merge') ? e : { ...e, at: 0 }))
    git(d, 'merge', '-q', '--ff-only', 'feat')
    expect(await commitsOfCall(payload(d, 'git merge feat'), Date.now(), reflog)).not.toContain(theirs)
  })

  it('takes the commit the CLI names in gitOperation, even when the command does not look like one', async () => {
    const d = repo()
    const made = commit(d, 'a.txt', 'a\n')
    const p = payload(d, './scripts/release.sh', { tool_response: { stdout: '', gitOperation: { commit: { sha: made.slice(0, 7), kind: 'committed', branch: 'main' } } } })
    expect(await commitsOfCall(p)).toEqual([made])
  })

  it('reads a commit made with git -C in another folder', async () => {
    const d = repo()
    const other = repo()
    const made = commit(other, 'a.txt', 'a\n')
    expect(await commitsOfCall(payload(d, `git -C ${other} commit -m a`))).toContain(made)
  })
})

describe('commits: the store', () => {
  const rec = (n: number, at = Date.now()) => ({ sha: n.toString(16).padStart(40, '0'), session: 'abc123', name: 'one', at })

  it('writes atomically, keeps nothing but shas, ids, names and times, and survives a restart', async () => {
    const dir = temp('ws-commits-')
    const file = join(dir, 'commits.json')
    const s = new CommitStore(file)
    expect(await s.add([rec(1), rec(2)])).toHaveLength(2)
    expect(await s.add([rec(1)])).toEqual([])
    expect(readdirSync(dir)).toEqual(['commits.json'])
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.format).toBe(1)
    expect(raw.commits[0]).toHaveLength(4)
    const again = new CommitStore(file)
    expect(again.all().map((r) => r.sha)).toEqual([rec(1).sha, rec(2).sha])
    expect(again.has(rec(2).sha)).toBe(true)
  })

  it('prunes by age first, then the oldest past the cap', async () => {
    const dir = temp('ws-commits-')
    const now = Date.UTC(2026, 10, 10)
    const s = new CommitStore(join(dir, 'c.json'), { max: 3, days: 10, now: () => now })
    await s.add([rec(1, now - 11 * 86_400_000), rec(2, now - 5), rec(3, now - 4), rec(4, now - 3), rec(5, now - 2)])
    expect(s.all().map((r) => r.sha)).toEqual([rec(3).sha, rec(4).sha, rec(5).sha])
    expect(STORE_MAX).toBeGreaterThanOrEqual(1000)
    // A pruned one read again after a restart is still gone.
    expect(new CommitStore(join(dir, 'c.json'), { max: 3, days: 10, now: () => now }).has(rec(1).sha)).toBe(false)
  })

  it('starts empty over a broken file', () => {
    const dir = temp('ws-commits-')
    const file = join(dir, 'c.json')
    writeFileSync(file, '{ nope')
    expect(new CommitStore(file).all()).toEqual([])
    writeFileSync(file, JSON.stringify({ format: 1, commits: [['a'.repeat(40), 's', 'n', 1], ['bad']] }))
    expect(new CommitStore(file, { days: 1e6 }).all()).toHaveLength(1)
  })

  it('records a session\'s commit from its hook and tells core, once', async () => {
    const d = repo()
    const made = commit(d, 'a.txt', 'a\n')
    const dir = temp('ws-commits-')
    const heard: number[] = []
    const r = new CommitRecorder(new CommitStore(join(dir, 'c.json')), (all) => heard.push(all.length))
    const p = { tool_name: 'Bash', cwd: d, tool_input: { command: 'git commit -m a' }, duration_ms: 100 }
    expect((await r.onTool({ id: 'abc123', name: 'one' }, p)).map((x) => x.sha)).toEqual([made])
    expect(await r.onTool({ id: 'def456', name: 'two' }, p)).toEqual([])
    expect(heard).toEqual([1])
    expect(r.store.all()[0]).toMatchObject({ sha: made, session: 'abc123', name: 'one' })
    expect(JSON.stringify(r.store.all())).not.toContain('git commit')
  })
})

describe('commits: the hook in the --settings file', () => {
  it('runs on Bash only, never blocks, and posts nothing for a call that does not mention git', () => {
    const home = temp('ws-hooks-')
    const s = new SessionSettings(home, '/app/bin/workshop-tile.mjs')
    s.setPort(1)
    const settings = JSON.parse(readFileSync(s.path, 'utf8'))
    const [group] = settings.hooks.PostToolUse
    expect(group.matcher).toBe('Bash')
    const cmd = group.hooks[0].command as string
    expect(cmd).toMatch(/\/hook\/tool/)
    expect(cmd).toMatch(/-m 2/)
    expect(cmd).toMatch(/exit 0$/)
    // With no server listening, the hook still exits 0 at once, with or without git in it.
    for (const input of ['{"tool_input":{"command":"ls"}}', '{"tool_input":{"command":"git commit"}}']) {
      const t0 = Date.now()
      execFileSync('/bin/sh', ['-c', cmd], { input, env: { ...process.env, WORKSHOP_AUTH: join(home, 'none') } })
      expect(Date.now() - t0).toBeLessThan(3000)
    }
    expect(existsSync(join(home, 'port'))).toBe(true)
  })
})
