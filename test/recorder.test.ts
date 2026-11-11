import { describe, expect, it } from 'vitest'
import { ASPECT, MIN_H, REC, REC_BAR, REC_DEFAULTS, REC_PAD, centerWindow, clock, cleanPrefs, cropOf, firstFrame, innerOf, int, isPhase, outSize, resized, takeName, windowFor } from '@shared/recorder'
import { isRecorderKey, shortcutOf } from '@shared/shortcuts'
import { cleanSettings } from '../src/main/settings'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const area = { x: 0, y: 25, width: 1512, height: 957 }

describe('the frame', () => {
  it('opens centred on the work area at 9:16, its filmed rectangle 80% of the height', () => {
    const f = firstFrame(area)
    const inner = innerOf(f)
    expect(inner.height).toBe(Math.round(957 * 0.8) - 2 * REC_PAD - REC_BAR)
    expect(inner.width).toBe(Math.round(inner.height * ASPECT))
    expect(f.x).toBe(Math.round((1512 - f.width) / 2))
    expect(f.y).toBe(Math.round(25 + (957 - f.height) / 2))
  })
  it('never opens smaller than MIN_H, even on a short display', () => {
    expect(innerOf(firstFrame({ x: 0, y: 0, width: 800, height: 400 })).height).toBe(MIN_H)
  })
  it('the window is the filmed rectangle, a border on every side and the bar under it', () => {
    expect(windowFor(10, 20, 800)).toEqual({ x: 10, y: 20, width: 450 + 28, height: 800 + 28 + 46 })
    expect(innerOf(windowFor(10, 20, 800))).toEqual({ x: 24, y: 34, width: 450, height: 800 })
  })
  it('resizing keeps 9:16 and the top-left corner, between MIN_H and the display', () => {
    const b = windowFor(100, 50, 600)
    const r = resized(b, 700, area)
    expect([r.x, r.y]).toEqual([100, 50])
    expect(innerOf(r).height).toBe(700)
    expect(innerOf(r).width).toBe(Math.round(700 * ASPECT))
    expect(innerOf(resized(b, 10, area)).height).toBe(MIN_H)
    expect(innerOf(resized(b, 99999, area)).height).toBe(957 - 2 * REC_PAD - REC_BAR)
    expect(innerOf(resized(b, NaN, area)).height).toBe(MIN_H)
  })
  it('coordinates are int32s, never -0 (Electron refuses -0)', () => {
    expect(Object.is(int(-0.3), 0)).toBe(true)
    expect(int(12.6)).toBe(13)
    expect(Object.is(windowFor(-0.2, -0.4, 500).x, 0)).toBe(true)
  })
})

describe('the crop', () => {
  const display = { x: 0, y: 0, width: 1512, height: 982 }
  it("scales points to the video's pixels (a Retina capture is twice the size)", () => {
    expect(cropOf({ x: 100, y: 50, width: 450, height: 800 }, display, 3024, 1964)).toEqual({ sx: 200, sy: 100, sw: 900, sh: 1600 })
  })
  it('follows a display that is not at the origin', () => {
    expect(cropOf({ x: 1612, y: 50, width: 450, height: 800 }, { ...display, x: 1512 }, 1512, 982)).toEqual({ sx: 100, sy: 50, sw: 450, sh: 800 })
  })
  it('a frame half off the screen films the half on it', () => {
    const c = cropOf({ x: -100, y: 600, width: 450, height: 800 }, display, 1512, 982)!
    expect(c.sx).toBe(0)
    expect(c.sy).toBe(600)
    expect(c.sh).toBe(382)
  })
  it('nothing before the video has a size', () => {
    expect(cropOf({ x: 0, y: 0, width: 10, height: 10 }, display, 0, 0)).toBeNull()
  })
})

describe('the file', () => {
  const d = new Date(2026, 10, 10, 9, 3, 7)
  it('is named by local time, with dots for Finder', () => {
    expect(takeName(d, 'mp4')).toBe('workshop 2026-11-10 09.03.07.mp4')
  })
  it('a second take in the same second gets " 2"', () => {
    const taken = new Set(['workshop 2026-11-10 09.03.07.mp4', 'workshop 2026-11-10 09.03.07 2.mp4'])
    expect(takeName(d, 'mp4', (n) => taken.has(n))).toBe('workshop 2026-11-10 09.03.07 3.mp4')
  })
  it('an extension the page made up becomes webm', () => {
    expect(takeName(d, '../x')).toBe('workshop 2026-11-10 09.03.07.webm')
  })
  it('the clock', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(7_900)).toBe('0:07')
    expect(clock(761_000)).toBe('12:41')
    expect(clock(3_723_000)).toBe('1:02:03')
    expect(clock(-5)).toBe('0:00')
  })
})

describe('settings', () => {
  it('prefs: booleans only, field by field', () => {
    expect(cleanPrefs(undefined)).toEqual(REC_DEFAULTS)
    expect(cleanPrefs({ sound: false, mic: 'yes', guides: false, extra: 1 })).toEqual({ sound: false, mic: false, guides: false, fit: 'reel' })
    expect(cleanPrefs({ mic: true }, { sound: false, mic: false, guides: false, fit: 'center' })).toEqual({ sound: false, mic: true, guides: false, fit: 'center' })
    expect(cleanPrefs({ fit: 'square' }).fit).toBe('reel')
    expect(cleanPrefs({ fit: 'center' }).fit).toBe('center')
    // Settings saved before `fit` existed read as the 9:16 frame.
    expect(cleanPrefs({ sound: true, mic: false, guides: true }, { sound: true, mic: false, guides: true } as never).fit).toBe('reel')
  })
  it('core settings keep them, and leave them out until first saved', () => {
    expect(cleanSettings({}).recorder).toBeUndefined()
    expect(cleanSettings({ recorder: { sound: false } }).recorder).toEqual({ sound: false, mic: false, guides: true, fit: 'reel' })
    const base = cleanSettings({ recorder: { mic: true } })
    expect(cleanSettings({ theme: 'nope' }, base).recorder).toEqual({ sound: true, mic: true, guides: true, fit: 'reel' })
  })
  it('phases', () => {
    expect(isPhase('recording')).toBe(true)
    expect(isPhase('rolling')).toBe(false)
  })
})

describe('⌘⇧O', () => {
  const k = (key: string, m: Partial<{ meta: boolean; shift: boolean; alt: boolean; control: boolean }>, code = '') => ({ type: 'keyDown', key, code, meta: false, shift: false, alt: false, control: false, ...m })
  it('is the recorder, by key or by physical key', () => {
    expect(isRecorderKey(k('O', { meta: true, shift: true }))).toBe(true)
    expect(isRecorderKey(k('ø', { meta: true, shift: true }, 'KeyO'))).toBe(true)
  })
  it('and nothing near it', () => {
    expect(isRecorderKey(k('o', { meta: true }))).toBe(false)
    expect(isRecorderKey(k('o', { meta: true, shift: true, alt: true }))).toBe(false)
    expect(isRecorderKey({ ...k('o', { meta: true, shift: true }), type: 'keyUp' })).toBe(false)
  })
  it('is no session shortcut (⌘⇧ keys never are)', () => {
    expect(shortcutOf(k('O', { meta: true, shift: true }))).toBeNull()
  })
})

describe('the preload', () => {
  // The recorder's preload spells the channel names out (it must be one file); they must be REC's.
  it('uses exactly the channels in REC', () => {
    const src = readFileSync(join(__dirname, '../src/preload/recorder.ts'), 'utf8')
    const used = new Set([...src.matchAll(/'(ws:rec:[a-z-]+)'/g)].map((m) => m[1]))
    expect([...used].sort()).toEqual(Object.values(REC).sort())
  })
})

describe('the center column fit', () => {
  const column = { x: 500, y: 300, width: 800, height: 1100 }
  it('frames the column exactly, its bar above it', () => {
    const w = centerWindow(column)
    expect(innerOf(w, 'center')).toEqual(column)
    expect(w.y).toBe(column.y - REC_PAD - REC_BAR)
    // The reel's inside of the same window would be off by the bar: the fit is what places it.
    expect(innerOf(w).y).toBe(column.y - REC_BAR)
  })
  it('films the column in the display\'s own pixels, each side even', () => {
    expect(outSize('center', { x: 0, y: 0, width: 801, height: 1101 }, 2)).toEqual({ w: 1602, h: 2202 })
    expect(outSize('center', { x: 0, y: 0, width: 333, height: 777 }, 1)).toEqual({ w: 334, h: 778 })
    expect(outSize('reel', column, 2)).toEqual({ w: 1080, h: 1920 })
  })
  it('caps the long side at 4096', () => {
    const o = outSize('center', { x: 0, y: 0, width: 1600, height: 2400 }, 2)
    expect(Math.max(o.w, o.h)).toBeLessThanOrEqual(4096)
    expect(o.w % 2 + o.h % 2).toBe(0)
  })
})
