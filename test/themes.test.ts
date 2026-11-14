import { describe, expect, it } from 'vitest'
import { THEMES, glassVariant, themeVars, type ThemeVariant } from '../src/shared/themes'
import { contrast, parseColor, type RGB } from '../src/shared/knot'

const rgb = (s: string): RGB => parseColor(s)!

const variants: [string, ThemeVariant][] = [
  ...THEMES.flatMap((t) => [[`${t.id} light`, t.light], [`${t.id} dark`, t.dark]] as [string, ThemeVariant][]),
  ...[0, 120, 210, 300].flatMap((hue) => [true, false].map((dark) => [`glass ${hue} ${dark ? 'dark' : 'light'}`, glassVariant(dark, { hue, sat: 0.5, accentHue: (hue + 90) % 360 })] as [string, ThemeVariant]))
]

describe('session heads', () => {
  it.each(variants)('%s: all four heads keep the ink readable and differ from each other', (_, v) => {
    expect(v.heads).toHaveLength(4)
    for (const h of v.heads) {
      expect(contrast(rgb(h), rgb(v.ink))).toBeGreaterThanOrEqual(4.5)
      // The muted text (the title beside the name) stays at 3:1, or loses little where the theme's
      // own muted was under that on the panel (Solarized, Catppuccin Latte).
      expect(contrast(rgb(h), rgb(v.muted))).toBeGreaterThanOrEqual(Math.min(3, 0.85 * contrast(rgb(v.panel), rgb(v.muted))))
    }
    // Four colours, not one: every two of them differ by 12 or more in some channel.
    const hs = v.heads.map(rgb)
    for (const [i, a] of hs.entries()) for (const b of hs.slice(i + 1)) expect(a.some((c, k) => Math.abs(c - b[k]) >= 12)).toBe(true)
  })

  it('reach the window and every tile as --ws-head-1 to --ws-head-4', () => {
    const vars = themeVars(THEMES[0].light)
    for (const i of [0, 1, 2, 3]) expect(vars[`--ws-head-${i + 1}`]).toBe(THEMES[0].light.heads[i])
  })
})

describe('colours a tile writes text in', () => {
  const tint = (c: RGB, panel: RGB, share: number): RGB => [0, 1, 2].map((i) => Math.round(c[i] * share + panel[i] * (1 - share))) as RGB
  it('a diff’s row and word backgrounds keep the ink readable (4.5:1), in every variant', () => {
    for (const [name, v] of variants) {
      const vars = themeVars(v)
      const ink = rgb(vars['--ws-ink'])
      for (const k of ['--ws-add-bg', '--ws-del-bg', '--ws-add-mark', '--ws-del-mark']) expect(contrast(ink, rgb(vars[k])), `${name} ink on ${k}`).toBeGreaterThanOrEqual(4.5)
      // A changed word is marked at least as strongly as its row (equal only where the ink is too weak
      // for more, Solarized light: the Git tile underlines changed words too, so they always show).
      expect(contrast(rgb(vars['--ws-add-mark']), rgb(vars['--ws-panel'])), name).toBeGreaterThanOrEqual(contrast(rgb(vars['--ws-add-bg']), rgb(vars['--ws-panel'])))
    }
  })
  it('--ws-green, -red, -yellow, -blue, -magenta, -cyan and -accent-ink read on the panel, on a diff’s backgrounds and on their own 16% tint', () => {
    for (const [name, v] of variants) {
      const vars = themeVars(v)
      const panel = rgb(vars['--ws-panel'])
      const surfaces = ['--ws-panel', '--ws-add-bg', '--ws-del-bg', '--ws-add-mark', '--ws-del-mark'].map((k) => [k, rgb(vars[k])] as const)
      for (const k of ['--ws-green', '--ws-red', '--ws-yellow', '--ws-blue', '--ws-magenta', '--ws-cyan', '--ws-accent-ink']) {
        const c = rgb(vars[k])
        for (const [sk, s] of surfaces) expect(contrast(c, s), `${name} ${k} on ${sk}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(c, tint(c, panel, 0.16)), `${name} ${k} on its tint`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
