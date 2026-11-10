import { describe, expect, it } from 'vitest'
import { shortcutOf, stepFrom } from '@shared/shortcuts'
import { shortcutOrder, type SessionView, type SessionsState } from '@shared/sessions'

const key = (key: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = { meta: true }, code = '') => ({
  type: 'keyDown',
  key,
  code,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods
})

describe('shortcutOf', () => {
  it('⌘1–9, ⌘[ ⌘], ⌘N', () => {
    expect(shortcutOf(key('1'))).toEqual({ kind: 'focus', n: 1 })
    expect(shortcutOf(key('9'))).toEqual({ kind: 'focus', n: 9 })
    expect(shortcutOf(key('['))).toEqual({ kind: 'step', dir: -1 })
    expect(shortcutOf(key(']'))).toEqual({ kind: 'step', dir: 1 })
    expect(shortcutOf(key('N'))).toEqual({ kind: 'new' })
  })
  it('by the physical key when the layout names it otherwise', () => {
    expect(shortcutOf(key('&', { meta: true }, 'Digit1'))).toEqual({ kind: 'focus', n: 1 })
    expect(shortcutOf(key('ü', { meta: true }, 'BracketLeft'))).toEqual({ kind: 'step', dir: -1 })
  })
  it('nothing else', () => {
    expect(shortcutOf(key('1', {}))).toBeNull()
    expect(shortcutOf(key('0'))).toBeNull()
    expect(shortcutOf(key('n', { meta: true, shift: true }))).toBeNull()
    expect(shortcutOf(key('1', { meta: true, alt: true }))).toBeNull()
    expect(shortcutOf({ ...key('1'), type: 'keyUp' })).toBeNull()
    expect(shortcutOf(key('c'))).toBeNull()
  })
})

describe('stepFrom', () => {
  it('wraps, and starts at an end from nothing', () => {
    expect(stepFrom(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(stepFrom(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(stepFrom(['a', 'b'], null, 1)).toBe('a')
    expect(stepFrom(['a', 'b'], 'gone', -1)).toBe('b')
    expect(stepFrom([], 'a', 1)).toBeNull()
  })
})

describe('shortcutOrder', () => {
  it('open sessions in the order they were started, whatever was active last', () => {
    const s = (id: string, createdAt: number, activeAt: number, open = true) => ({ id, createdAt, activeAt, open }) as SessionView
    const state = { focus: null, recent: [], profile: 'x', sessions: [s('b', 2, 9), s('a', 1, 5), s('p', 0, 0, false)] } as SessionsState
    expect(shortcutOrder(state)).toEqual(['a', 'b'])
    expect(shortcutOrder(null)).toEqual([])
  })
})
