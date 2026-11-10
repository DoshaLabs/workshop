// The Git tile's page rules, run against the file the tile ships (tiles/git/dist/model.js), and
// the two theme colours it draws diffs with.
import { describe, expect, it } from 'vitest'
import { THEMES, themeVars } from '@shared/themes'
import { luminance, parseColor } from '@shared/knot'
// @ts-expect-error plain JavaScript, as a tile's page is
import { badgeOf, branchLabel, filesLabel, shown, names, numbered, openIds, sessionsKey, signature, totals, worktreeOfSession } from '../tiles/git/dist/model.js'
// @ts-expect-error plain JavaScript, as the tile ships it
import { dropWorktrees, parseWorktrees } from '../tiles/git/lib/parse.mjs'

describe('git tile page', () => {
  it('draws nothing for what a condition left out of the bar, so no "null" before "live"', () => {
    const live = { live: true }
    expect(shown([null, undefined, false, '', live])).toEqual([live])
    expect(shown(['tabs', null, 'live'])).toEqual(['tabs', 'live'])
    for (const v of [null, undefined, NaN, 0, -1]) expect(badgeOf(v)).toBe('')
    expect(badgeOf(3)).toBe('3')
  })

  it('asks about open sessions only, and asks again when one opens, closes or changes status', () => {
    const list = [
      { id: 'a', open: true, status: 'busy' },
      { id: 'b', open: false, status: 'idle' },
      { id: 'c', open: true, status: 'dead' }
    ]
    expect(openIds(list)).toEqual(['a'])
    expect(sessionsKey(list)).not.toBe(sessionsKey([{ ...list[0], status: 'idle' }, list[1], list[2]]))
    expect(sessionsKey(list)).toBe(sessionsKey([list[2], list[1], list[0]]))
  })

  it('says a branch the way a person would', () => {
    expect(branchLabel({ head: 'main', oid: 'abc', ahead: 2, behind: 1 })).toBe('main ↑2 ↓1')
    expect(branchLabel({ head: null, oid: '1a2b3c4d5e', ahead: 0, behind: 0 })).toBe('detached at 1a2b3c4')
    expect(branchLabel({ head: 'main', oid: null, ahead: 0, behind: 0 })).toBe('main (no commits yet)')
    expect(filesLabel({ count: 1 })).toBe('1 file')
    expect(filesLabel({ count: 300, more: true })).toBe('300+ files')
    expect(names([{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toBe('a, b and c')
  })

  it('numbers a hunk’s lines on each side', () => {
    const rows = numbered({ oldStart: 10, newStart: 20, lines: [' a', '-b', '+c', '+d', ' e', '\\ No newline at end of file'] })
    expect(rows.map((r: { o: number | null; n: number | null; t: string }) => [r.t, r.o, r.n])).toEqual([
      [' ', 10, 20],
      ['-', 11, null],
      ['+', null, 21],
      ['+', null, 22],
      [' ', 12, 23],
      ['\\', null, null]
    ])
  })

  it('knows when an unfolded diff is stale, finds a session’s worktree, and totals the head', () => {
    const w = { top: '/r', count: 2, add: 3, del: 1, branch: { oid: 'x' }, files: [{ path: 'a', kind: 'modified', add: 3, del: 1 }], sessions: [{ id: 's1' }] }
    expect(signature(w)).toBe(signature({ ...w }))
    expect(signature(w)).not.toBe(signature({ ...w, files: [{ path: 'a', kind: 'modified', add: 4, del: 1 }] }))
    const projects = [{ worktrees: [w, { top: '/r2', count: 0, sessions: [{ id: 's2' }] }, { top: '/r3', error: 'x', sessions: [] }] }]
    expect(worktreeOfSession(projects, 's2').top).toBe('/r2')
    expect(worktreeOfSession(projects, 'nope')).toBeNull()
    expect(totals(projects)).toEqual({ files: 2, dirty: 1 })
  })

  it('drops another worktree of the same repo that git lists as an untracked folder', () => {
    const wts = parseWorktrees(['worktree /r', 'HEAD abc', 'branch refs/heads/main', '', 'worktree /r/.claude/worktrees/f', 'HEAD def', 'detached', '', ''].join('\0'))
    expect(wts).toEqual(['/r', '/r/.claude/worktrees/f'])
    const files = [
      { path: '.claude/worktrees/f/', kind: 'untracked' },
      { path: 'vendor/other-repo/', kind: 'untracked' },
      { path: 'a.ts', kind: 'modified' }
    ]
    expect(dropWorktrees(files, '/r', wts).map((f: { path: string }) => f.path)).toEqual(['vendor/other-repo/', 'a.ts'])
  })
})

describe('--ws-green and --ws-red', () => {
  const contrast = (a: string, b: string): number => {
    const [x, y] = [luminance(parseColor(a)!), luminance(parseColor(b)!)].sort((m, n) => n - m)
    return (x + 0.05) / (y + 0.05)
  }
  it('every theme has both, and each reads on its panel as small text (4.5:1)', () => {
    for (const t of THEMES)
      for (const v of [t.light, t.dark]) {
        const vars = themeVars(v)
        for (const k of ['--ws-green', '--ws-red']) expect(contrast(vars[k], vars['--ws-panel']), `${t.id} ${k} on ${vars['--ws-panel']}`).toBeGreaterThanOrEqual(4.5)
      }
  })
})
