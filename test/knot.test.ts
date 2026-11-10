import { describe, expect, it } from 'vitest'
import { MIN_CONTRAST, MODES, P, TAU, contrast, drawKnot, ensureContrast, knotMode, knotPalette, knotPoints, parseColor, wrapClock, type KnotCtx, type KnotMode, type KnotTheme } from '@shared/knot'
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
  it('is full size and fast at work, much smaller and slow at rest, still when dead', () => {
    expect(MODES.work.size).toBe(1)
    expect(MODES.rest.size).toBeLessThanOrEqual(0.65)
    expect(MODES.work.loop).toBeLessThan(MODES.rest.loop / 5)
    expect(MODES.rest.fps).toBeLessThanOrEqual(8)
    expect(MODES.dead.loop).toBe(0)
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

describe('contrast, every theme, every mode, both sizes', () => {
  for (const { name, theme } of variants) {
    it(name, () => {
      const panel = parseColor(theme.panel)!
      const bg = parseColor(theme.bg)!
      for (const mode of MODE_LIST) {
        const palette = knotPalette(theme, mode)
        for (const size of [MODES.rest.size, 1]) {
          for (const flare of [0, 1]) {
            for (const ph of [0.4, 2.5, 7]) {
              const r = recorder()
              drawKnot(r, { S: 20, ph, palette, size, flare })
              expect(r.strokes).toBeGreaterThan(0)
              for (const s of r.styles) {
                const c = parseColor(s)!
                const worst = Math.min(contrast(c, panel), contrast(c, bg))
                if (worst < MIN_CONTRAST) throw new Error(`${name} ${mode} ${s}: ${worst.toFixed(2)}:1`)
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
