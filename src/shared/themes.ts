// Themes are data: each variant is a handful of colours that core writes into CSS variables, for
// its own window and for every tile (a tile reads them as --ws-*). No colour is hard-coded in a
// stylesheet. Carried from deck's src/shared/themes.ts; the rest of its catalog comes over with
// the core extraction (roadmap step 3). Keep this file dependency-free.

export type Appearance = 'system' | 'light' | 'dark'

export interface ThemeVariant {
  /** Window / gutter background. */
  bg: string
  /** A pane's or a tile's face. */
  panel: string
  ink: string
  muted: string
  line: string
  accent: string
  busy: string
  idle: string
  blocked: string
}

export interface ThemeFamily {
  id: string
  name: string
  light: ThemeVariant
  dark: ThemeVariant
}

/** Deep Space without its star-field wall yet: dark in both appearances. */
const space: ThemeVariant = {
  bg: '#04050d',
  panel: '#0a0c1d',
  ink: '#eceefe',
  muted: '#a9aed6',
  line: '#2f3566',
  accent: '#b99cff',
  busy: '#f9e2af',
  idle: '#6c7086',
  blocked: '#f38ba8'
}

const cream: ThemeFamily = {
  id: 'cream',
  name: 'Cream',
  light: { bg: '#efe9dc', panel: '#f7f3ea', ink: '#2b2a26', muted: '#7a766c', line: '#d9d2c2', accent: '#c8552d', busy: '#d99a1e', idle: '#a9a497', blocked: '#d3402a' },
  dark: { bg: '#1c1a17', panel: '#24221e', ink: '#ece6d8', muted: '#9a9486', line: '#3a362f', accent: '#e07a50', busy: '#e0b050', idle: '#6f6a5f', blocked: '#e8604a' }
}

export const DEFAULT_THEME = 'cosmos'
export const THEMES: ThemeFamily[] = [{ id: 'cosmos', name: 'Deep Space', light: space, dark: space }, cream]

export function resolveVariant(themeId: string, appearance: Appearance, systemDark: boolean): ThemeVariant {
  const fam = THEMES.find((t) => t.id === themeId) ?? THEMES[0]
  const dark = appearance === 'dark' || (appearance === 'system' && systemDark)
  return dark ? fam.dark : fam.light
}

/** The CSS variables a variant becomes, named the same in core's window and in every tile. */
export function themeVars(v: ThemeVariant): Record<string, string> {
  return {
    '--ws-bg': v.bg,
    '--ws-panel': v.panel,
    '--ws-ink': v.ink,
    '--ws-muted': v.muted,
    '--ws-line': v.line,
    '--ws-accent': v.accent,
    '--ws-busy': v.busy,
    '--ws-idle': v.idle,
    '--ws-blocked': v.blocked
  }
}
