// `sessions: "launch"` (bridge 1.4): the manifest takes it only for a tile built for 1.4 or later,
// the words say what it does, and what a tile may fill the launcher with is checked for shape.
// Also the Worktrees tab's page rules (tiles/git/dist/model.js), as the tile ships them.
import { describe, expect, it } from 'vitest'
import { BRIDGE_VERSION, checkManifest } from '@shared/manifest'
import { needsAsking, permissionChange, permissionWords } from '@shared/permissions'
import { launchRequest, worktreeName } from '@shared/sessions'
// @ts-expect-error plain JavaScript, as a tile's page is
import { ARM_MS, actionsFor, filtered, isArmed, press, projectOverlaps, versusBase } from '../tiles/git/dist/model.js'

const base = { id: 'x', name: 'X', version: '1.0.0', author: 'a', entry: 'dist/index.html' }
const errs = (m: unknown): string[] => {
  const r = checkManifest(m)
  return r.ok ? [] : r.errors
}

describe('sessions: "launch"', () => {
  it('is bridge 1.4', () => {
    expect(BRIDGE_VERSION).toBe('1.4.0')
  })

  it('is taken only by a tile that says it needs bridge 1.4 or later', () => {
    const r = checkManifest({ ...base, workshop: '^1.4', permissions: { sessions: 'launch' } })
    expect(r.ok && r.manifest.permissions.sessions).toBe('launch')
    expect(errs({ ...base, workshop: '^1', permissions: { sessions: 'launch' } })[0]).toMatch(/"launch" is bridge 1.4; set "workshop" to "\^1.4"/)
    expect(errs({ ...base, workshop: '^1.3', permissions: { sessions: 'launch' } })[0]).toMatch(/bridge 1.4/)
    expect(checkManifest({ ...base, workshop: '^1', permissions: { sessions: 'read' } }).ok).toBe(true)
    expect(errs({ ...base, workshop: '^1.4', permissions: { sessions: 'start' } })[0]).toMatch(/"read", "launch" or "write"/)
  })

  it('is said in words, and asks again when a tile moves to it', () => {
    expect(permissionWords({ sessions: 'launch' })).toEqual(['see your sessions, and open the new-session form filled in for you to start'])
    expect(needsAsking({ sessions: 'read' }, { sessions: 'launch' })).toBe(true)
    expect(permissionChange({ sessions: 'read' }, { sessions: 'launch' }).added).toEqual(['see your sessions, and open the new-session form filled in for you to start'])
  })

  it('takes an absolute folder and, optionally, a new worktree with a name git and the CLI both take', () => {
    expect(launchRequest({ folder: '/p' })).toEqual({ folder: '/p', worktree: false })
    expect(launchRequest({ folder: '/p', worktree: {} })).toEqual({ folder: '/p', worktree: true })
    expect(launchRequest({ folder: '/p', worktree: { branch: 'fix-auth' } })).toEqual({ folder: '/p', worktree: true, branch: 'fix-auth' })
    expect(() => launchRequest({ folder: 'p' })).toThrow(/absolute/)
    expect(() => launchRequest(null)).toThrow(/absolute/)
    expect(() => launchRequest({ folder: '/p', worktree: { branch: '--force' } })).toThrow(/worktree.branch/)
    expect(() => launchRequest({ folder: '/p', worktree: 'yes' })).toThrow(/true or \{ branch \}/)
    // A tile can say nothing about the prompt, the model or the permission mode: there is nowhere to put them.
    expect(launchRequest({ folder: '/p', prompt: 'rm -rf', permissionMode: 'bypassPermissions' })).toEqual({ folder: '/p', worktree: false })
    expect(worktreeName('a.b_c-1')).toBe('a.b_c-1')
    for (const bad of ['', 'A', '-x', 'a..b', 'x.lock', 'a/b', 'x.', 'a b', 'x'.repeat(61)]) expect(worktreeName(bad)).toBeNull()
  })
})

describe('git tile page: worktrees', () => {
  it('arms a destructive button on the first click and acts only on a second within three seconds', () => {
    const one = press(null, 'merge /w', 1000)
    expect(one.act).toBe(false)
    expect(isArmed(one.armed, 'merge /w', 1000 + ARM_MS)).toBe(true)
    expect(isArmed(one.armed, 'merge /w', 1001 + ARM_MS)).toBe(false)
    // Another button's click arms that one instead.
    expect(press(one.armed, 'remove /w', 1500)).toEqual({ act: false, armed: { key: 'remove /w', at: 1500 } })
    expect(press(one.armed, 'merge /w', 1000 + ARM_MS)).toEqual({ act: true, armed: null })
    expect(press(one.armed, 'merge /w', 1001 + ARM_MS).act).toBe(false)
  })

  it('says where a worktree stands against main, and offers only what could work', () => {
    const b = { name: 'main', oid: 'x', remote: false }
    const w = { path: '/w', branch: 'side', ahead: 2, behind: 1, dirty: 0, sessions: [], main: false, isBase: false, prunable: null, bare: false }
    expect(versusBase(w, b)).toBe('↑2 ↓1 on main')
    expect(versusBase({ ...w, ahead: 0, behind: 0 }, b)).toBe('even with main')
    expect(actionsFor(w, b)).toEqual({ diff: true, open: true, rebase: true, merge: true, remove: true })
    expect(actionsFor({ ...w, behind: 0, ahead: 0 }, b)).toMatchObject({ rebase: false, merge: false, diff: false })
    expect(actionsFor({ ...w, sessions: [{ id: 'a' }] }, b).remove).toBe(false)
    expect(actionsFor({ ...w, isBase: true, branch: 'main', main: true }, b)).toMatchObject({ rebase: false, merge: false, remove: false, diff: false })
    expect(actionsFor({ ...w, prunable: '' }, b)).toMatchObject({ open: false, remove: false })
    expect(filtered([{ stale: 'merged' }, { stale: null }], 'stale')).toEqual([{ stale: 'merged' }])
  })

  it('names each overlap once', () => {
    const p = {
      worktrees: [
        { path: '/a', short: 'a', overlaps: [{ with: '/b', short: 'b', files: ['x'], count: 1 }] },
        { path: '/b', short: 'b', overlaps: [{ with: '/a', short: 'a', files: ['x'], count: 1 }] }
      ]
    }
    expect(projectOverlaps(p)).toEqual([{ a: 'a', b: 'b', files: ['x'], count: 1 }])
  })
})
