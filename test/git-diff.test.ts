// The Git tile's redesign, its rules run as shipped (tiles/git/dist and lib): how a diff reads
// (syntax, changed words, side by side), the history's graph and search, the lanes, the notes sent
// to a session, the Worktrees board, and what gh's answers become.
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript, as the tile ships it
import { fileSig, hunkHeader, langOf, lines, segments, splitRows, tokenize, wordDiff } from '../tiles/git/dist/diff.js'
// @ts-expect-error plain JavaScript, as the tile ships it
import { layout, graphWidth } from '../tiles/git/dist/graph.js'
// @ts-expect-error plain JavaScript, as the tile ships it
import { chips, isEmpty, matches, parseQuery } from '../tiles/git/dist/query.js'
// @ts-expect-error plain JavaScript, as the tile ships it
import { barOf, bandOf, boardGroup, byFolder, chipFiles, fixMessage, laneOverlaps, laneStatus, notesMessage, NOTES_CHARS, prOfBranch, took } from '../tiles/git/dist/model.js'
// @ts-expect-error plain JavaScript, as the tile ships it
import { check, latestRuns, logLine, pr, rollup, runOf, ghProblem } from '../tiles/git/lib/gh.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { parseTrack } from '../tiles/git/lib/refs.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { headerOf, hunkPatch } from '../tiles/git/lib/write.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { kept } from '../tiles/git/lib/oplog.mjs'
// @ts-expect-error plain JavaScript, as the tile ships it
import { logPath } from '../tiles/git/lib/log.mjs'

type Tok = { s: string; k: string }
const join = (t: Tok[]): string => t.map((x) => x.s).join('')

describe('a diff, read', () => {
  it('colours a line by its file type, and the pieces join back to the line', () => {
    expect(langOf('src/a.tsx')).toBe('js')
    expect(langOf('x/Makefile')).toBe('sh')
    expect(langOf('notes.txt')).toBeNull()
    const line = `  const greet = (name) => fetch('/hi', { n: 42 }) // say hello`
    const t = tokenize(line, 'js') as Tok[]
    expect(join(t)).toBe(line)
    expect(t.find((x) => x.s === 'const')?.k).toBe('kw')
    expect(t.find((x) => x.s === "'/hi'")?.k).toBe('str')
    expect(t.find((x) => x.s === '42')?.k).toBe('num')
    expect(t.find((x) => x.s === 'fetch')?.k).toBe('fn')
    expect(t.at(-1)).toEqual({ s: '// say hello', k: 'com' })
    expect(tokenize('def go(self): # x', 'py').at(-1)).toEqual({ s: '# x', k: 'com' })
    expect(tokenize('{"a": "b"}', 'json').map((x: Tok) => x.k)).toContain('pr')
    // A file with no family is one plain piece; a huge line is never tokenized.
    expect(tokenize('<b>', null)).toEqual([{ s: '<b>', k: '' }])
    expect(tokenize('x'.repeat(2000), 'js')).toHaveLength(1)
  })

  it('marks only the words that changed, and gives up on a line that was rewritten', () => {
    const w = wordDiff('<AgentSwitch value={cli} />', '<AgentSwitch value={cli} compact />')
    expect(w.a).toEqual([])
    expect(w.b.map(([f, t]: number[]) => '<AgentSwitch value={cli} compact />'.slice(f, t))).toEqual(['compact '])
    expect(wordDiff('return a + b', 'throw new Error("nothing alike at all here")')).toBeNull()
  })

  it('numbers a hunk, pairs removed lines with added ones for their marks, and lays them side by side', () => {
    const h = { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [' a', '-let x = 1', '+let x = 2', '+let y = 3', ' b'] }
    const rows = lines(h)
    expect(rows.map((r: { t: string; o: number | null; n: number | null }) => [r.t, r.o, r.n])).toEqual([
      [' ', 10, 10],
      ['-', 11, null],
      ['+', null, 11],
      ['+', null, 12],
      [' ', 12, 13]
    ])
    expect(rows[1].marks).toEqual([[8, 9]])
    expect(rows[2].marks).toEqual([[8, 9]])
    const split = splitRows(rows)
    expect(split.map((r: { left: { t: string } | null; right: { t: string } | null }) => [r.left?.t ?? null, r.right?.t ?? null])).toEqual([
      [' ', ' '],
      ['-', '+'],
      [null, '+'],
      [' ', ' ']
    ])
    expect(hunkHeader(h)).toBe('@@ -10,3 +10,4 @@')
    expect(headerOf(h)).toBe(hunkHeader(h))
  })

  it('cuts a line into coloured pieces at its marks', () => {
    const seg = segments('let x = 2', 'js', [[8, 9]])
    expect(seg.map((g: { s: string; k: string; mark: boolean }) => [g.s, g.k, g.mark])).toEqual([
      ['let', 'kw', false],
      [' x = ', '', false],
      ['2', 'num', true]
    ])
  })

  it('a viewed tick holds only while the file’s diff is the same', () => {
    const f = { path: 'a', status: 'modified', binary: false, hunks: [{ lines: ['+x'] }] }
    expect(fileSig(f)).toBe(fileSig({ ...f }))
    expect(fileSig(f)).not.toBe(fileSig({ ...f, hunks: [{ lines: ['+y'] }] }))
  })

  it('a hunk becomes a patch git apply takes, with its "no newline" line', () => {
    const p = hunkPatch('a b.txt', { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, section: 'fn()', lines: ['-a', '+b', '\\ No newline at end of file'] })
    expect(p).toBe('diff --git a/a b.txt b/a b.txt\n--- a/a b.txt\n+++ b/a b.txt\n@@ -1,1 +1,1 @@ fn()\n-a\n+b\n\\ No newline at end of file\n')
  })
})

describe('the history', () => {
  const c = (sha: string, parents: string[], by: unknown = null) => ({ sha, parents, by })
  it('lays out a branch and its merge: a second column joins back at the merge base', () => {
    // m merges f into b; f and b both come from a.
    const rows = layout([c('m', ['b', 'f']), c('f', ['a'], { ids: ['s1'], kind: 'exact' }), c('b', ['a']), c('a', [])])
    expect(rows.map((r: { col: number }) => r.col)).toEqual([0, 1, 0, 0])
    expect(graphWidth(rows)).toBe(2)
    // f's lane takes its session's colour; the merge's second parent line leaves column 0 for 1.
    expect(rows[1].colour).toBe('s1')
    expect(rows[0].down).toContainEqual([0, 1, ''])
    // At a, both lanes end in it.
    expect(rows[3].up.map((u: number[]) => [u[0], u[1]])).toEqual(expect.arrayContaining([[0, 0], [1, 0]]))
  })

  it('reads a search: words, session:, author:, path:, since:, quoted values', () => {
    const q = parseQuery('fix session:"Launcher folders" author:colin path:src/ since:2d Theme')
    expect(q).toEqual({ text: ['fix', 'theme'], session: 'Launcher folders', author: 'colin', path: 'src/', since: 2 * 86_400_000 })
    expect(isEmpty(parseQuery('  '))).toBe(true)
    expect(chips(q).map((x: { key: string }) => x.key)).toEqual(['session', 'author', 'path', 'since', '', ''])
    const now = Date.now()
    const commit = { sha: 'abc1234', subject: 'Fix the theme menu', author: 'Colin', ct: now - 3600_000, by: { names: ['Launcher folders'] } }
    expect(matches(commit, q, now)).toBe(true)
    expect(matches(commit, parseQuery('session:other'), now)).toBe(false)
    expect(matches(commit, parseQuery('abc12'), now)).toBe(true)
    expect(matches({ ...commit, ct: now - 3 * 86_400_000 }, parseQuery('since:2d'), now)).toBe(false)
  })

  it('searches the log by a path only a page may name', () => {
    expect(logPath('src/a.ts')).toBe('src/a.ts')
    expect(logPath('./src')).toBe('src')
    for (const bad of ['--all', ':(top)x', '/etc', '', 3, 'a\0b']) expect(logPath(bad)).toBeNull()
  })
})

describe('lanes', () => {
  const sessions = [
    { id: 'a', band: 2, status: 'busy' },
    { id: 'b', band: null, status: 'blocked' }
  ]
  it('wear their session’s band, and show the most urgent status', () => {
    expect(bandOf({ sessions: [{ id: 'b' }, { id: 'a' }] }, sessions)).toBe(2)
    expect(bandOf({ sessions: [{ id: 'b' }] }, sessions)).toBeNull()
    expect(laneStatus({ sessions: [{ id: 'a' }, { id: 'b' }] }, sessions)).toBe('blocked')
  })
  it('warn when two lanes change one file, and draw the bar and chips', () => {
    const p = {
      worktrees: [
        { top: '/r', name: 'r', sessions: [{ name: 'one' }], files: [{ path: 'x.css', add: 1, del: 0 }, { path: 'a.ts', add: 9, del: 1 }] },
        { top: '/w', name: 'w', sessions: [{ name: 'two' }], files: [{ path: 'x.css' }] },
        { top: '/e', name: 'e', error: 'gone', sessions: [], files: [] }
      ]
    }
    expect(laneOverlaps(p)).toEqual([{ a: 'one', b: 'two', files: ['x.css'] }])
    expect(barOf({ add: 3, del: 1 })).toEqual({ add: 75, del: 25 })
    expect(barOf({ add: 0, del: 0 })).toEqual({ add: 0, del: 0 })
    const { shown, more } = chipFiles({ ...p.worktrees[0], count: 5 }, 1)
    expect(shown.map((f: { path: string }) => f.path)).toEqual(['a.ts'])
    expect(more).toBe(4)
    expect(byFolder([{ path: 'b/x' }, { path: 'a/y' }, { path: 'z' }]).map((g: { dir: string }) => g.dir)).toEqual(['', 'a', 'b'])
  })
  it('send a review’s notes as one message, each with its file and line, never past the paste limit', () => {
    const m = notesMessage([{ path: 'src/a.ts', line: 12, code: '  const x = 1', text: 'Use a better name.' }])
    expect(m).toBe('A review note on your uncommitted changes:\n1. src/a.ts:12\n   > const x = 1\n   Use a better name.')
    const long = notesMessage(Array.from({ length: 200 }, (_, i) => ({ path: 'f', line: i, text: 'x'.repeat(100) })))
    expect(long.length).toBeLessThanOrEqual(NOTES_CHARS)
    expect(long).toMatch(/cut: too long/)
  })
})

describe('the Worktrees board and pull requests', () => {
  it('puts each worktree in one column', () => {
    expect(boardGroup({ stale: 'merged', sessions: [] })).toBe('stale')
    expect(boardGroup({ sessions: [{}] })).toBe('working')
    expect(boardGroup({ main: true, sessions: [] })).toBe('working')
    expect(boardGroup({ sessions: [], ahead: 2 })).toBe('ready')
    expect(boardGroup({ sessions: [], ahead: 0 })).toBe('idle')
  })

  it('reads gh: checks of both kinds, a rollup, a run id, a pull request, main’s latest runs', () => {
    expect(check({ __typename: 'CheckRun', name: 'eslint', workflowName: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-14T10:00:00Z', completedAt: '2026-11-14T10:00:18Z', detailsUrl: 'https://github.com/o/r/actions/runs/123/job/9' })).toEqual({
      name: 'lint / eslint',
      state: 'fail',
      ms: 18_000,
      url: 'https://github.com/o/r/actions/runs/123/job/9',
      run: '123'
    })
    expect(check({ __typename: 'StatusContext', context: 'ci/x', state: 'PENDING', targetUrl: 'https://x' }).state).toBe('run')
    expect(check({ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' }).state).toBe('skip')
    expect(rollup([])).toBeNull()
    expect(rollup([{ state: 'ok' }, { state: 'run' }])).toBe('run')
    expect(rollup([{ state: 'run' }, { state: 'fail' }])).toBe('fail')
    expect(runOf('https://github.com/o/r/pull/3')).toBeNull()
    const p = pr({ number: 14, title: 'Search', headRefName: 'feat/search', baseRefName: 'main', additions: 3, deletions: 1, reviewDecision: '', isDraft: false, url: 'u', author: { login: 'c' }, updatedAt: '2026-11-14T10:00:00Z', statusCheckRollup: [] })
    expect(p).toMatchObject({ number: 14, head: 'feat/search', review: null, state: null })
    expect(prOfBranch([p], 'feat/search')).toBe(p)
    expect(prOfBranch([p], null)).toBeNull()
    const runs = latestRuns([
      { workflowName: 'ci', status: 'completed', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/2' },
      { workflowName: 'ci', status: 'completed', conclusion: 'success', url: 'https://github.com/o/r/actions/runs/1' },
      { workflowName: 'pages', status: 'in_progress', conclusion: '', url: 'https://github.com/o/r/actions/runs/3' }
    ])
    expect(runs.state).toBe('fail')
    expect(runs.checks).toHaveLength(2)
  })

  it('reads a failed log’s lines without their timestamps or colour, and says what to do when gh cannot', () => {
    expect(logLine('lint\teslint\t2026-11-14T09:12:03.1234567Z \x1b[31merror\x1b[0m  x is unused')).toBe('error  x is unused')
    expect(ghProblem({ missing: true, err: '' })).toMatch(/not installed/)
    expect(ghProblem({ missing: false, err: 'To get started with GitHub CLI, please run:  gh auth login' })).toMatch(/not signed in/)
    expect(took(72_000)).toBe('1m 12s')
    expect(fixMessage({ number: 3, title: 'T', head: 'b' }, { name: 'lint' }, ['e1'])).toMatch(/"lint" failed on pull request #3[\s\S]*e1[\s\S]*fix it/)
  })

  it('reads a branch’s upstream tracking, and keeps the operation log to its window', () => {
    expect(parseTrack('ahead 2, behind 1')).toEqual({ ahead: 2, behind: 1, gone: false })
    expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0, gone: true })
    const now = Date.now()
    expect(kept([{ id: 'a', at: now - 15 * 86_400_000 }, { id: 'b', at: now }, null], now).map((e: { id: string }) => e.id)).toEqual(['b'])
  })
})
