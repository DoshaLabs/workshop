import { describe, expect, it } from 'vitest'
import { FALLBACK, FOXTROT, MASCOT_STATES, artBox, checkPack, fitScale, framesPerRow, guessGrid, pngSize, poseFor, recognise, runFor, spriteAt, tintCoat, type MascotPack } from '@shared/mascot'
import { encodePng, synthSheet } from './sheet'

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 1,
  name: 'Pip',
  image: 'sheet.png',
  sheet: { w: 128, h: 64 },
  frame: { w: 32, h: 32 },
  states: { idle: { row: 0, from: 0, frames: 4, ms: 200 } },
  ...over
})

describe('checkPack', () => {
  it('accepts a pack with one state, and fills in from', () => {
    const r = checkPack(base({ states: { run: { row: 1, frames: 2, ms: 80 } } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pack.states.run).toEqual({ row: 1, from: 0, frames: 2, ms: 80 })
  })
  it('refuses unknown fields and states, including an alert pose', () => {
    const r = checkPack(base({ colour: 'red', states: { alert: { row: 0, frames: 1, ms: 100 } } }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.join('\n')).toContain('unknown field "colour"')
      expect(r.errors.join('\n')).toContain('unknown state "alert"')
    }
  })
  it('refuses runs off the sheet, a box outside the frame and no states at all', () => {
    expect(checkPack(base({ states: { idle: { row: 2, frames: 1, ms: 100 } } })).ok).toBe(false)
    expect(checkPack(base({ states: { idle: { row: 0, from: 3, frames: 2, ms: 100 } } })).ok).toBe(false)
    expect(checkPack(base({ box: { x: 10, y: 0, w: 30, h: 10 } })).ok).toBe(false)
    expect(checkPack(base({ states: {} })).ok).toBe(false)
    expect(checkPack(base({ states: { idle: { row: 0, frames: 1, ms: 5 } } })).ok).toBe(false)
  })
  it('checks names, file names, the worker coat and credit', () => {
    expect(checkPack(base({ name: '' })).ok).toBe(false)
    expect(checkPack(base({ image: '../x.png' })).ok).toBe(false)
    expect(checkPack(base({ image: 'sheet.gif' })).ok).toBe(false)
    expect(checkPack(base({ worker: { swap: [['#ff0000', 'gold']] } })).ok).toBe(false)
    expect(checkPack(base({ credit: { by: 'x', url: 'http://x' } })).ok).toBe(false)
    const ok = checkPack(base({ worker: { swap: [['#FF0000', '#00ff00']] }, credit: { by: 'Someone', url: 'https://example.com' } }))
    expect(ok.ok && ok.pack.worker?.swap?.[0]).toEqual(['#ff0000', '#00ff00'])
    expect(checkPack(null).ok).toBe(false)
  })
  it('accepts the Foxtrot mapping workshop ships', () => {
    const r = checkPack({ ...FOXTROT.pack, name: 'Foxtrot' })
    expect(r.ok).toBe(true)
  })
})

describe('the state fallback', () => {
  const pack = { states: { run: { row: 0, from: 0, frames: 2, ms: 50 }, sleep: { row: 1, from: 0, frames: 2, ms: 300 } } } as Pick<MascotPack, 'states'>
  it('plays a state its own frames, else the nearest mapped one', () => {
    expect(runFor(pack, 'run')?.row).toBe(0)
    expect(runFor(pack, 'leap')?.row).toBe(0) // leap → run
    expect(runFor(pack, 'idle')?.row).toBe(1) // idle → sleep
    expect(runFor(pack, 'look')?.row).toBe(0) // look → idle (none) → leap (none) → run
    expect(runFor({ states: {} }, 'idle')).toBeNull()
  })
  it('lists every other state for every state', () => {
    for (const s of MASCOT_STATES) expect(new Set([s, ...FALLBACK[s]]).size).toBe(MASCOT_STATES.length)
  })
})

describe('poseFor', () => {
  it('follows section 8', () => {
    expect(poseFor('starting', false)).toBe('idle')
    expect(poseFor('unknown', false)).toBe('idle')
    expect(poseFor('busy', false)).toBe('run')
    expect(poseFor('idle', false)).toBe('sleep')
    expect(poseFor('idle', true)).toBe('look')
    expect(poseFor('blocked', false)).toBe('look')
    expect(poseFor('dead', true)).toBe('sleep')
  })
})

describe('reading a sheet', () => {
  it('guesses a grid of 32-pixel frames with margins', () => {
    const p = synthSheet({ frame: { w: 32, h: 32 }, cols: 6, counts: [4, 6, 2], box: { x: 4, y: 14, w: 22, h: 18 } })
    expect(guessGrid(p)).toEqual({ w: 32, h: 32 })
    expect(framesPerRow(p, { w: 32, h: 32 })).toEqual([4, 6, 2])
    expect(artBox(p, { w: 32, h: 32 })).toEqual({ x: 4, y: 14, w: 22, h: 18 })
  })
  it('guesses frames that are not square', () => {
    const p = synthSheet({ frame: { w: 48, h: 24 }, cols: 4, counts: [4, 3], box: { x: 2, y: 2, w: 40, h: 20 } })
    expect(guessGrid(p)).toEqual({ w: 48, h: 24 })
  })
  it('falls back to square frames in a strip when the art fills its frames', () => {
    const p = synthSheet({ frame: { w: 16, h: 16 }, cols: 5, counts: [5], box: { x: 0, y: 0, w: 16, h: 16 } })
    expect(guessGrid(p)).toEqual({ w: 16, h: 16 })
  })
  it('reads a PNG’s size from its header', () => {
    const png = encodePng(synthSheet({ frame: { w: 32, h: 32 }, cols: 3, counts: [1, 2], box: { x: 1, y: 1, w: 8, h: 8 } }))
    expect(pngSize(png)).toEqual({ w: 96, h: 64 })
    expect(pngSize(Buffer.from('GIF89a and some more bytes here'))).toBeNull()
  })
})

describe('recognising Foxtrot’s sheet by its layout', () => {
  // A synthetic sheet with the fox sheet's layout: plain blocks, none of its pixels.
  const fake = (counts: number[]) => synthSheet({ frame: { w: 32, h: 32 }, cols: 14, counts, box: { x: 4, y: 14, w: 22, h: 18 } })
  it('knows the layout and maps every state', () => {
    const p = fake(FOXTROT.rows)
    expect(guessGrid(p)).toEqual({ w: 32, h: 32 })
    const k = recognise(p)
    expect(k?.key).toBe('elthen-fox')
    expect(Object.keys(k!.pack.states).sort()).toEqual([...MASCOT_STATES].sort())
    expect(artBox(p, k!.frame)).toEqual(k!.pack.box)
  })
  it('does not claim a sheet of the same size laid out differently', () => {
    expect(recognise(fake([5, 14, 8, 11, 5, 6, 6]))).toBeNull()
    expect(recognise(synthSheet({ frame: { w: 32, h: 32 }, cols: 14, counts: [5, 14, 8, 11, 5, 6], box: { x: 4, y: 14, w: 22, h: 18 } }))).toBeNull()
  })
  it('never maps the alert row', () => {
    expect(Object.values(FOXTROT.pack.states).some((r) => r!.row === 4)).toBe(false)
  })
})

describe('the worker coat', () => {
  it('swaps exact colours and leaves the rest', () => {
    const d = new Uint8ClampedArray([0xd6, 0x79, 0x41, 255, 0x9d, 0x50, 0x21, 255, 10, 10, 10, 255, 0xd6, 0x79, 0x41, 0])
    tintCoat(d, FOXTROT.pack.worker!.swap)
    expect([...d]).toEqual([0xe5, 0xb8, 0x43, 255, 0xb7, 0x8c, 0x2a, 255, 10, 10, 10, 255, 0xd6, 0x79, 0x41, 0])
  })
  it('turns coloured pixels gold by default and keeps greys, whites and lightness', () => {
    const d = new Uint8ClampedArray([200, 60, 60, 255, 128, 128, 128, 255, 255, 255, 255, 255, 40, 40, 180, 255])
    tintCoat(d)
    const [r, g, b] = [d[0], d[1], d[2]]
    expect(r).toBeGreaterThan(b)
    expect(g).toBeGreaterThan(b)
    expect(r).toBeGreaterThan(g) // a warm gold, not green
    expect([...d.slice(4, 12)]).toEqual([128, 128, 128, 255, 255, 255, 255, 255])
    expect(d[14]).toBeLessThan(d[12]) // the blue one turned gold too
  })
})

describe('drawing', () => {
  it('places the sheet for a frame, art box and scale', () => {
    const run = FOXTROT.pack.states.sleep!
    expect(fitScale(FOXTROT.pack)).toBe(1)
    expect(spriteAt(FOXTROT.pack, run, 2, 1)).toEqual({ size: [448, 224], pos: [-(2 * 32 + 4), -(5 * 32 + 14)] })
    expect(spriteAt(FOXTROT.pack, run, 8, 1).pos[0]).toBe(-(2 * 32 + 4)) // wraps
    expect(fitScale({ frame: { w: 8, h: 8 } })).toBe(2)
    expect(fitScale({ frame: { w: 64, h: 64 } })).toBeCloseTo(18 / 64)
  })
})
