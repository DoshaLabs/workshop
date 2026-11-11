import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { arrange, moved, ordered, pruned, ORDER_MAX } from '@shared/order'
import { cleanColumn } from '@shared/column'
import { columnOrder, shortcutOrder, type SessionsState, type SessionView } from '@shared/sessions'
import { keepImage, safeName } from '../src/main/drops'

describe('order: merging what shows with what was saved', () => {
  it('saved keys keep their place; new ones go to the foot in their own order', () => {
    expect(arrange(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd'])
    expect(ordered(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd'])
  })
  it('a key that is not showing keeps its place in the order, and is not drawn', () => {
    expect(arrange(['a', 'c'], ['c', 'x', 'a'])).toEqual(['c', 'x', 'a'])
    expect(ordered(['a', 'c'], ['c', 'x', 'a'])).toEqual(['c', 'a'])
  })
  it('duplicates in a saved order are dropped', () => {
    expect(arrange(['a'], ['a', 'a', 'b', 'a'])).toEqual(['a', 'b'])
  })
  it('a key that appears never pushes the others', () => {
    const before = ordered(['a', 'b'], ['b', 'a'])
    const after = ordered(['a', 'b', 'new'], ['b', 'a'])
    expect(after.slice(0, 2)).toEqual(before)
  })
})

describe('order: moving', () => {
  it('before or after a target, or to the foot', () => {
    expect(moved(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moved(['a', 'b', 'c'], 'a', 'b', true)).toEqual(['b', 'a', 'c'])
    expect(moved(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
    expect(moved(['a', 'b', 'c'], 'a', 'gone')).toEqual(['b', 'c', 'a'])
    expect(moved(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'c', 'b'])
  })
  it('a move among the showing keys leaves a hidden one where it was', () => {
    const full = arrange(['a', 'c'], ['a', 'x', 'c'])
    expect(moved(full, 'c', 'a')).toEqual(['c', 'a', 'x'])
  })
})

describe('order: pruning', () => {
  it('drops keys that cannot come back, keeps the showing ones', () => {
    expect(pruned(['a', 'gone', 'b'], ['a'], (k) => k !== 'gone')).toEqual(['a', 'b'])
  })
  it('caps the length, dropping hidden keys from the foot first', () => {
    const full = Array.from({ length: ORDER_MAX + 5 }, (_, i) => `k${i}`)
    const out = pruned(full, ['k0', `k${ORDER_MAX + 4}`])
    expect(out.length).toBe(ORDER_MAX)
    expect(out).toContain(`k${ORDER_MAX + 4}`)
    expect(out[0]).toBe('k0')
  })
})

describe('the column keeps the two orders', () => {
  it('cleans them, and leaves them out until they were saved', () => {
    expect(cleanColumn({ off: [], extra: [], spans: {} })).toEqual({ off: [], extra: [], spans: {} })
    expect(cleanColumn({ order: ['probe.2', 'wikipedia', 'Bad Id', 'wikipedia'], sessions: ['a1b2c3', 'nothex', 'a1b2c3'] })).toEqual({ off: [], extra: [], spans: {}, order: ['probe.2', 'wikipedia'], sessions: ['a1b2c3'] })
  })
})

const view = (id: string, createdAt: number, open = true): SessionView =>
  ({ id, createdAt, open, tmuxName: '', cliSessionId: '', cwd: '/', worktree: false, model: '', name: id, title: null, status: 'idle', attention: false, attached: open, tmuxAlive: true }) as SessionView

describe('⌘1–9 and the session column', () => {
  // Most recently active first, as main sends them: c was started last but b was used last.
  const state: SessionsState = { focus: null, sessions: [view('bbbbbb', 2), view('cccccc', 3), view('aaaaaa', 1), view('dddddd', 4, false)], recent: [], profile: 'x' }
  it('without a dragged order: the column by recency, the numbers by start', () => {
    expect(columnOrder(state)).toEqual(['bbbbbb', 'cccccc', 'aaaaaa'])
    expect(shortcutOrder(state)).toEqual(['aaaaaa', 'bbbbbb', 'cccccc'])
  })
  it('with one: both follow it, and a session it has not seen goes to the foot', () => {
    const manual = ['cccccc', 'aaaaaa']
    expect(columnOrder(state, manual)).toEqual(['cccccc', 'aaaaaa', 'bbbbbb'])
    expect(shortcutOrder(state, manual)).toEqual(['cccccc', 'aaaaaa', 'bbbbbb'])
  })
  it('a parked session in the order is skipped, and keeps its place for when it comes back', () => {
    const manual = ['dddddd', 'cccccc', 'aaaaaa', 'bbbbbb']
    expect(shortcutOrder(state, manual)).toEqual(['cccccc', 'aaaaaa', 'bbbbbb'])
    const back = { ...state, sessions: state.sessions.map((s) => ({ ...s, open: true })) }
    expect(shortcutOrder(back, manual)[0]).toBe('dddddd')
  })
})

describe('drops: a picture for a prompt', () => {
  const home = mkdtempSync(join(tmpdir(), 'ws-drops-'))
  it('a pasted picture is written to drops/, privately, under a name a prompt can carry', async () => {
    const p = await keepImage(home, { name: 'image.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3]) })
    expect(p.startsWith(join(home, 'drops'))).toBe(true)
    expect(p).toMatch(/\/pasted-[\d-T]+\.png$/)
    expect([...readFileSync(p)]).toEqual([1, 2, 3])
    expect(statSync(p).mode & 0o777).toBe(0o600)
    const again = await keepImage(home, { name: 'shot.png', type: 'image/png', bytes: new Uint8Array([4]) })
    const third = await keepImage(home, { name: 'shot.png', type: 'image/png', bytes: new Uint8Array([5]) })
    expect(third).not.toBe(again)
  })
  it('refuses what is not a picture, or nothing at all', async () => {
    await expect(keepImage(home, { name: 'x.exe', type: 'application/octet-stream', bytes: new Uint8Array([1]) })).rejects.toThrow(/picture/)
    await expect(keepImage(home, { name: 'x.png', type: 'image/png', bytes: new Uint8Array() })).rejects.toThrow(/no picture/)
    await expect(keepImage(home, null)).rejects.toThrow()
  })
  it('names: no slashes, spaces or leading dots', () => {
    expect(safeName('../../a b.png')).toBe('a-b.png')
    expect(safeName('.hidden', 'image/png')).toBe('hidden.png')
    expect(safeName('shot', 'image/jpeg')).toBe('shot.jpg')
  })
})
