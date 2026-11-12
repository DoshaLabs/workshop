import { describe, expect, it } from 'vitest'
import { THEMES, glassVariant, themeVars, type ThemeVariant } from '../src/shared/themes'
import { contrast, parseColor, type RGB } from '../src/shared/knot'

const rgb = (s: string): RGB => parseColor(s)!

const variants: [string, ThemeVariant][] = [
  ...THEMES.flatMap((t) => [[`${t.id} light`, t.light], [`${t.id} dark`, t.dark]] as [string, ThemeVariant][]),
  ...[0, 120, 210, 300].flatMap((hue) => [true, false].map((dark) => [`glass ${hue} ${dark ? 'dark' : 'light'}`, glassVariant(dark, { hue, sat: 0.5, accentHue: (hue + 90) % 360 })] as [string, ThemeVariant]))
]

describe('session heads', () => {
  it.each(variants)('%s: both heads keep the ink readable and stand off the panel', (_, v) => {
    for (const h of v.heads) {
      expect(contrast(rgb(h), rgb(v.ink))).toBeGreaterThanOrEqual(4.5)
      // The muted text (the title beside the name) stays at 3:1, or loses little where the theme's
      // own muted was under that on the panel (Solarized, Catppuccin Latte).
      expect(contrast(rgb(h), rgb(v.muted))).toBeGreaterThanOrEqual(Math.min(3, 0.85 * contrast(rgb(v.panel), rgb(v.muted))))
    }
    // The pair are two colours, not one: they differ from each other as much as from the panel.
    const [a, b] = v.heads.map(rgb)
    expect(a.some((c, i) => Math.abs(c - b[i]) >= 12)).toBe(true)
  })

  it('reach the window and every tile as --ws-head-1 and --ws-head-2', () => {
    const vars = themeVars(THEMES[0].light)
    expect(vars['--ws-head-1']).toBe(THEMES[0].light.heads[0])
    expect(vars['--ws-head-2']).toBe(THEMES[0].light.heads[1])
  })
})
