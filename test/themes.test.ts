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
