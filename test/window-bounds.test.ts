import { describe, expect, it } from 'vitest'
import { cleanRect, placeWindow } from '../src/main/window-bounds'
import { cleanSettings } from '../src/main/settings'

const laptop = { x: 0, y: 25, width: 1512, height: 920 }
const external = { x: 1512, y: 0, width: 2560, height: 1415 }
const MIN = { width: 900, height: 600 }

describe('placeWindow', () => {
  it('fills the work area the first time', () => {
    expect(placeWindow(undefined, [laptop], laptop, MIN)).toEqual(laptop)
  })
  it('opens where it was left', () => {
    const left = { x: 100, y: 80, width: 1200, height: 800 }
    expect(placeWindow(left, [laptop], laptop, MIN)).toEqual(left)
    const there = { x: 1700, y: 100, width: 2000, height: 1200 }
    expect(placeWindow(there, [laptop, external], laptop, MIN)).toEqual(there)
  })
  it('fills the screen again when its place is gone (a display unplugged)', () => {
    expect(placeWindow({ x: 1700, y: 100, width: 2000, height: 1200 }, [laptop], laptop, MIN)).toEqual(laptop)
  })
  it('never opens smaller than the minimum', () => {
    expect(placeWindow({ x: 10, y: 30, width: 300, height: 200 }, [laptop], laptop, MIN)).toEqual({ x: 10, y: 30, width: 900, height: 600 })
  })
})

describe('the saved place', () => {
  it('takes only a well-formed rectangle', () => {
    expect(cleanRect({ x: 1.4, y: 2, width: 800.6, height: 600 })).toEqual({ x: 1, y: 2, width: 801, height: 600 })
    expect(cleanRect({ x: 1, y: 2, width: 0, height: 600 })).toBeUndefined()
    expect(cleanRect({ x: '1', y: 2, width: 800, height: 600 })).toBeUndefined()
    expect(cleanRect(null)).toBeUndefined()
  })
  it('is kept in settings, and left out until there is one', () => {
    expect(cleanSettings({}).window).toBeUndefined()
    expect(cleanSettings({ window: { x: 0, y: 25, width: 1512, height: 920 } }).window).toEqual(laptop)
    expect(cleanSettings({ window: 'big' }).window).toBeUndefined()
  })
})
