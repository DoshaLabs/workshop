import { describe, expect, it } from 'vitest'
import { BOX, MIN_CONTRAST, MODES, P, TAU, contrast, drawKnot, ensureContrast, goldOf, knotMode, knotPalette, knotPoints, parseColor, wrapClock, type KnotCtx, type KnotMode, type KnotTheme } from '@shared/knot'
import { THEMES } from '@shared/themes'

/** A canvas context that only records what it was asked to draw with. */
function recorder(): KnotCtx & { styles: Set<string>; widths: number[]; strokes: number } {
  const r = {
    strokeStyle: '' as KnotCtx['strokeStyle'],
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    styles: new Set<string>(),
    widths: [] as number[],
    strokes: 0,
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      r.styles.add(String(r.strokeStyle))
      r.widths.push(r.lineWidth)
      r.strokes++
    }
  }
  return r
}

const MODE_LIST = Object.keys(MODES) as KnotMode[]
const variants = THEMES.flatMap((t) => [
  ['light', t.light],
  ['dark', t.dark]
].map(([k, v]) => ({ name: `${t.id} ${k}`, theme: v as KnotTheme })))

describe('the curve', () => {
  it('closes after P loops, so a wrapped clock never jumps', () => {
    for (const ph of [0, 0.7, 2.1]) {
      const a = knotPoints(ph, 64)
      const b = knotPoints(ph + P * TAU, 64)
      a.forEach((p, i) => p.forEach((v, k) => expect(v).toBeCloseTo(b[i][k], 9)))
    }
    expect(wrapClock(P + 0.25)).toBeCloseTo(0.25)
    expect(wrapClock(-0.25)).toBeCloseTo(P - 0.25)
  })
  it('does not close after one loop (why the clock wraps at P loops, not 1)', () => {
    const a = knotPoints(0.3, 64)
    const b = knotPoints(0.3 + TAU, 64)
    expect(a.some((p, i) => Math.abs(p[0] - b[i][0]) > 1e-3)).toBe(true)
  })
  it('is one closed strand', () => {
    const pts = knotPoints(1, 96)
    pts[0].forEach((v, k) => expect(v).toBeCloseTo(pts[96][k], 9))
  })
  it('moves only a little from frame to frame at the fastest speed', () => {
    // 30 fps at a 2.4 s loop: the biggest step any point makes, in units of the knot (about 2 across).
    const dph = TAU / (2.4 * 30)
    const a = knotPoints(5, 64)
    const b = knotPoints(5 + dph, 64)
    expect(Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])))).toBeLessThan(0.4)
  })
})

describe('the status language', () => {
  it('maps every status', () => {
    expect(knotMode('busy', false)).toBe('work')
    expect(knotMode('idle', false)).toBe('rest')
    expect(knotMode('unknown', false)).toBe('rest')
    expect(knotMode('starting', false)).toBe('start')
    expect(knotMode('idle', true)).toBe('needs')
    expect(knotMode('blocked', false)).toBe('needs')
    expect(knotMode('dead', true)).toBe('dead')
  })
  it('is full size and fast at work, smaller and slow at rest, still when dead', () => {
    expect(MODES.work.size).toBe(1)
    expect(MODES.rest.size).toBeLessThanOrEqual(0.8)
    expect(MODES.rest.size).toBeLessThan(MODES.start.size)
    expect(MODES.start.size).toBeLessThan(MODES.needs.size)
    expect(MODES.needs.size).toBeLessThan(MODES.work.size)
    expect(MODES.work.loop).toBeLessThan(MODES.rest.loop / 5)
    for (const m of ["work", "needs", "start", "rest"] as const) expect(MODES[m].fps).toBe(30)
    expect(MODES.dead.loop).toBe(0)
  })
})

/** The knot's drawn height in a box of side S, averaged over a whole cycle, with the strand's width. */
function drawnHeight(S: number, size: number, flare = 0): { mean: number; max: number } {
  let sum = 0
  let max = 0
  const steps = 60
  for (let i = 0; i < steps; i++) {
    let lo = Infinity
    let hi = -Infinity
    let y = 0
    const ctx: KnotCtx = {
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      beginPath() {},
      moveTo(_x, y0) {
        y = y0
      },
      lineTo(_x, y1) {
        const w = ctx.lineWidth / 2
        lo = Math.min(lo, y - w, y1 - w)
        hi = Math.max(hi, y + w, y1 + w)
      },
      stroke() {}
    }
    drawKnot(ctx, { S, ph: (i / steps) * P * TAU, palette: knotPalette(variants[0].theme, 'rest'), size, flare })
    sum += hi - lo
    max = Math.max(max, hi - lo)
  }
  return { mean: sum / steps, max }
}

// Colin, 10 Nov 2026: "the knot takes up the same height as foxtrot". In deck Foxtrot stands 15
// sheet pixels tall: 15 px in a session's head (1×), 60 px in the 88 px top bar (4×); asleep, 11 and 44.
describe("the knot stands as tall as Foxtrot", () => {
  it('in a session head, at rest: his 15 px, in a box no taller than before', () => {
    expect(BOX.head).toBeLessThanOrEqual(24)
    expect(drawnHeight(BOX.head, MODES.rest.size).mean).toBeGreaterThanOrEqual(14.5)
    expect(drawnHeight(BOX.head, MODES.rest.size).mean).toBeLessThanOrEqual(15.5)
  })
  // Colin, 11 Nov 2026: the top bar's knot was too large; 10% smaller (an 88 px box became 79).
  it('in the top bar, at rest: 10% under his 60 standing, and over his 44 asleep', () => {
    expect(BOX.mark).toBe(Math.round(88 * 0.9))
    const rest = drawnHeight(BOX.mark, MODES.rest.size)
    expect(rest.mean).toBeGreaterThanOrEqual(46)
    expect(rest.max).toBeLessThanOrEqual(55)
  })
  it('working and flaring, still inside its box', () => {
    for (const S of [BOX.head, BOX.mark]) expect(drawnHeight(S, 1, 1).max).toBeLessThanOrEqual(S)
  })
})

describe('colour', () => {
  it('parses theme colours', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255])
    expect(parseColor('#0a0c1d00')).toEqual([10, 12, 29])
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3])
  })
  it('moves a colour toward the ink only as far as it must', () => {
    const white: [number, number, number] = [255, 255, 255]
    const pale: [number, number, number] = [240, 230, 150]
    const fixed = ensureContrast(pale, [white], [20, 20, 20])
    expect(contrast(fixed, white)).toBeGreaterThanOrEqual(3)
    expect(ensureContrast([0, 0, 0], [white], [20, 20, 20])).toEqual([0, 0, 0])
  })
})

describe('the worker coat', () => {
  it('is gold, whatever the accent', () => {
    for (const accent of [[80, 140, 255], [200, 60, 200], [30, 30, 30], [240, 240, 240]] as [number, number, number][]) {
      const [r, g, b] = goldOf(accent)
      expect(r).toBeGreaterThan(b)
      expect(g).toBeGreaterThan(b)
      expect(r).toBeGreaterThanOrEqual(g)
    }
  })
  it('draws other colours than the session’s own', () => {
    const { theme } = variants[0]
    expect(knotPalette(theme, 'work', 'worker').strand[0][0]).not.toBe(knotPalette(theme, 'work').strand[0][0])
  })
})

describe('contrast, every theme, every mode, both coats, both sizes', () => {
  for (const { name, theme } of variants) {
    it(name, () => {
      const panel = parseColor(theme.panel)!
      const bg = parseColor(theme.bg)!
      for (const [mode, coat] of MODE_LIST.flatMap((m) => [[m, 'own'], [m, 'worker']] as const)) {
        const palette = knotPalette(theme, mode, coat)
        for (const size of [MODES.rest.size, 1]) {
          for (const flare of [0, 1]) {
            for (const [S, ph] of [[BOX.head, 0.4], [BOX.head, 2.5], [BOX.mark, 7]]) {
              const r = recorder()
              drawKnot(r, { S, ph, palette, size, flare })
              expect(r.strokes).toBeGreaterThan(0)
              for (const s of r.styles) {
                const c = parseColor(s)!
                const worst = Math.min(contrast(c, panel), contrast(c, bg))
                if (worst < MIN_CONTRAST) throw new Error(`${name} ${mode} ${coat} ${s}: ${worst.toFixed(2)}:1`)
              }
              // The strand stays a line at the small size: it thins with the radius, never below a pixel.
              expect(Math.min(...r.widths)).toBeGreaterThanOrEqual(1)
            }
          }
        }
      }
    })
  }
})
