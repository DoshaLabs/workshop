// Theme catalog shared by main (window background at boot, every tile's --ws-* variables) and
// the renderer (CSS variables + xterm palettes). Carried over from deck's src/shared/themes.ts. Every family has a light and a dark variant; `appearance` in settings
// picks which one is live. Keep this file dependency-free (the colour maths it borrows from ./knot is pure too).
import { ensureContrast, hex, parseColor } from './knot'

export type Appearance = 'system' | 'light' | 'dark'

/** ANSI-16 palette + xterm chrome for one variant. Field names match xterm's ITheme. */
export interface TermPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** One variant of a family: the app chrome colors (CSS variables) + the terminal palette. */
export interface ThemeVariant {
  /** Window / gutter background. */
  bg: string
  /** Pane background. MUST equal `term.background` or tiles show a seam. */
  panel: string
  ink: string
  muted: string
  line: string
  accent: string
  busy: string
  idle: string
  blocked: string
  starting: string
  dead: string
  /**
   * The session column's two head colours, alternated tile by tile so a column of conversations
   * is not one wall of text: two of the family's own hues washed toward the panel, each keeping
   * the ink at 4.5:1 (test/themes.test.ts).
   */
  heads: [string, string]
  term: TermPalette
}

export interface ThemeFamily {
  id: string
  name: string
  light: ThemeVariant
  dark: ThemeVariant
}

function variant(v: Omit<ThemeVariant, 'term'> & { term: Omit<TermPalette, 'background' | 'cursorAccent' | 'selectionForeground'> }): ThemeVariant {
  return { ...v, term: { ...v.term, background: v.panel, cursorAccent: v.panel, selectionForeground: v.term.foreground } }
}

const cream: ThemeFamily = {
  id: 'cream',
  name: 'Cream',
  light: variant({
    bg: '#efe9dc',
    panel: '#f7f3ea',
    ink: '#2b2a26',
    muted: '#7a766c',
    line: '#d9d2c2',
    accent: '#c8552d',
    busy: '#d99a1e',
    idle: '#a9a497',
    blocked: '#d3402a',
    starting: '#3a7bd5',
    dead: '#8a2f1c',
    heads: ['#f1dccd', '#dfe6d3'], // terracotta and sage, washed into the cream
    term: {
      foreground: '#2b2a26',
      cursor: '#c8552d',
      selectionBackground: '#d8cfb8',
      black: '#2b2a26',
      red: '#c8552d',
      green: '#4f7d3a',
      yellow: '#b5831c',
      blue: '#3a6ea8',
      magenta: '#8d5a9e',
      cyan: '#2f7f87',
      white: '#d9d2c2',
      brightBlack: '#7a766c',
      brightRed: '#e0623a',
      brightGreen: '#5f9648',
      brightYellow: '#cf9a2a',
      brightBlue: '#4a83c4',
      brightMagenta: '#a56cb8',
      brightCyan: '#3a9aa3',
      brightWhite: '#faf7f0'
    }
  }),
  dark: variant({
    bg: '#1a1917',
    panel: '#232220',
    ink: '#ece6d8',
    muted: '#8f8a7c',
    line: '#3a3833',
    accent: '#e0764f',
    busy: '#e0aa3a',
    idle: '#5f5b52',
    blocked: '#e25a42',
    starting: '#5b93d8',
    dead: '#9c3f2a',
    heads: ['#3a2a22', '#283326'], // rust and moss
    term: {
      foreground: '#ece6d8',
      cursor: '#e0764f',
      selectionBackground: '#45423a',
      black: '#232220',
      red: '#e0764f',
      green: '#8fb872',
      yellow: '#dfb04a',
      blue: '#6f9fd8',
      magenta: '#b98cc9',
      cyan: '#66b3ba',
      white: '#c9c2b2',
      brightBlack: '#6e6a5f',
      brightRed: '#ee8a63',
      brightGreen: '#a3cc86',
      brightYellow: '#efc45e',
      brightBlue: '#86b2e8',
      brightMagenta: '#cba1da',
      brightCyan: '#7ec8cf',
      brightWhite: '#faf7f0'
    }
  })
}

const solarized: ThemeFamily = {
  id: 'solarized',
  name: 'Solarized',
  light: variant({
    bg: '#eee8d5',
    panel: '#fdf6e3',
    ink: '#586e75',
    muted: '#93a1a1',
    line: '#e0d9c3',
    accent: '#cb4b16',
    busy: '#b58900',
    idle: '#b8b3a0',
    blocked: '#dc322f',
    starting: '#268bd2',
    dead: '#8b2b26',
    heads: ['#f8ebcc', '#e6f0ea'], // yellow and cyan; close to the panel, as Solarized's own ink is only 5:1 on it
    term: {
      foreground: '#586e75',
      cursor: '#cb4b16',
      selectionBackground: '#e3dcc4',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#93a1a1',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  }),
  dark: variant({
    bg: '#00212b',
    panel: '#002b36',
    ink: '#93a1a1',
    muted: '#657b83',
    line: '#0f3b47',
    accent: '#cb4b16',
    busy: '#b58900',
    idle: '#3c5560',
    blocked: '#dc322f',
    starting: '#268bd2',
    dead: '#8b2b26',
    heads: ['#04364a', '#11304a'], // cyan and blue, just lifted off base03
    term: {
      foreground: '#93a1a1',
      cursor: '#cb4b16',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#93a1a1',
      brightYellow: '#839496',
      brightBlue: '#657b83',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  })
}

const gruvbox: ThemeFamily = {
  id: 'gruvbox',
  name: 'Gruvbox',
  light: variant({
    bg: '#ebdbb2',
    panel: '#fbf1c7',
    ink: '#3c3836',
    muted: '#7c6f64',
    line: '#d5c4a1',
    accent: '#d65d0e',
    busy: '#d79921',
    idle: '#bdae93',
    blocked: '#cc241d',
    starting: '#458588',
    dead: '#9d0006',
    heads: ['#f2dfb0', '#e3e6c1'], // yellow and aqua
    term: {
      foreground: '#3c3836',
      cursor: '#d65d0e',
      selectionBackground: '#d5c4a1',
      black: '#fbf1c7',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#7c6f64',
      brightBlack: '#928374',
      brightRed: '#9d0006',
      brightGreen: '#79740e',
      brightYellow: '#b57614',
      brightBlue: '#076678',
      brightMagenta: '#8f3f71',
      brightCyan: '#427b58',
      brightWhite: '#3c3836'
    }
  }),
  dark: variant({
    bg: '#1d2021',
    panel: '#282828',
    ink: '#ebdbb2',
    muted: '#a89984',
    line: '#3c3836',
    accent: '#fe8019',
    busy: '#fabd2f',
    idle: '#665c54',
    blocked: '#fb4934',
    starting: '#83a598',
    dead: '#cc241d',
    heads: ['#3a3022', '#2b3530'], // orange and aqua
    term: {
      foreground: '#ebdbb2',
      cursor: '#fe8019',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2'
    }
  })
}

const catppuccin: ThemeFamily = {
  id: 'catppuccin',
  name: 'Catppuccin',
  light: variant({
    // Latte
    bg: '#e6e9ef',
    panel: '#eff1f5',
    ink: '#4c4f69',
    muted: '#8c8fa1',
    line: '#ccd0da',
    accent: '#8839ef',
    busy: '#df8e1d',
    idle: '#acb0be',
    blocked: '#d20f39',
    starting: '#1e66f5',
    dead: '#a3123a',
    heads: ['#e6ddf7', '#d9eaf0'], // mauve and sky
    term: {
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      selectionBackground: '#ccd0da',
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#d20f39',
      brightGreen: '#40a02b',
      brightYellow: '#df8e1d',
      brightBlue: '#1e66f5',
      brightMagenta: '#ea76cb',
      brightCyan: '#179299',
      brightWhite: '#bcc0cc'
    }
  }),
  dark: variant({
    // Mocha
    bg: '#181825',
    panel: '#1e1e2e',
    ink: '#cdd6f4',
    muted: '#7f849c',
    line: '#313244',
    accent: '#cba6f7',
    busy: '#f9e2af',
    idle: '#45475a',
    blocked: '#f38ba8',
    starting: '#89b4fa',
    dead: '#e64553',
    heads: ['#2c2540', '#1f2f3a'], // mauve and sapphire
    term: {
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
    }
  })
}

const nord: ThemeFamily = {
  id: 'nord',
  name: 'Nord',
  light: variant({
    bg: '#e5e9f0',
    panel: '#eceff4',
    ink: '#2e3440',
    muted: '#7b869a',
    line: '#d8dee9',
    accent: '#5e81ac',
    busy: '#ebcb8b',
    idle: '#b6bfcf',
    blocked: '#bf616a',
    starting: '#81a1c1',
    dead: '#8f4a51',
    heads: ['#dbe4ef', '#e9e2d6'], // frost and sand
    term: {
      foreground: '#2e3440',
      cursor: '#5e81ac',
      selectionBackground: '#d8dee9',
      black: '#3b4252',
      red: '#bf616a',
      green: '#7c9a4f',
      yellow: '#b48a35',
      blue: '#5e81ac',
      magenta: '#b48ead',
      cyan: '#6f9ba2',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#88c0d0',
      brightWhite: '#eceff4'
    }
  }),
  dark: variant({
    bg: '#242933',
    panel: '#2e3440',
    ink: '#d8dee9',
    muted: '#7b88a1',
    line: '#3b4252',
    accent: '#88c0d0',
    busy: '#ebcb8b',
    idle: '#4c566a',
    blocked: '#bf616a',
    starting: '#81a1c1',
    dead: '#8f4a51',
    heads: ['#323d52', '#3f3a45'], // frost and aurora purple
    term: {
      foreground: '#d8dee9',
      cursor: '#88c0d0',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  })
}

const graphite: ThemeFamily = {
  id: 'graphite',
  name: 'Graphite',
  light: variant({
    bg: '#e9e9eb',
    panel: '#f5f5f7',
    ink: '#1d1d1f',
    muted: '#6e6e73',
    line: '#d2d2d7',
    accent: '#0a84ff',
    busy: '#ff9f0a',
    idle: '#aeaeb2',
    blocked: '#ff453a',
    starting: '#0a84ff',
    dead: '#a52a20',
    heads: ['#dfeafb', '#f2e4f4'], // blue and lavender
    term: {
      foreground: '#1d1d1f',
      cursor: '#0a84ff',
      selectionBackground: '#d2d2d7',
      black: '#1d1d1f',
      red: '#d70015',
      green: '#248a3d',
      yellow: '#b25000',
      blue: '#0040dd',
      magenta: '#8944ab',
      cyan: '#0071a4',
      white: '#d2d2d7',
      brightBlack: '#6e6e73',
      brightRed: '#ff453a',
      brightGreen: '#30d158',
      brightYellow: '#ff9f0a',
      brightBlue: '#0a84ff',
      brightMagenta: '#bf5af2',
      brightCyan: '#64d2ff',
      brightWhite: '#ffffff'
    }
  }),
  dark: variant({
    bg: '#0f0f10',
    panel: '#1c1c1e',
    ink: '#f2f2f7',
    muted: '#8e8e93',
    line: '#2c2c2e',
    accent: '#0a84ff',
    busy: '#ff9f0a',
    idle: '#48484a',
    blocked: '#ff453a',
    starting: '#0a84ff',
    dead: '#a52a20',
    heads: ['#1d2a3c', '#2a2433'], // blue and plum
    term: {
      foreground: '#f2f2f7',
      cursor: '#0a84ff',
      selectionBackground: '#3a3a3c',
      black: '#1c1c1e',
      red: '#ff453a',
      green: '#30d158',
      yellow: '#ffd60a',
      blue: '#0a84ff',
      magenta: '#bf5af2',
      cyan: '#64d2ff',
      white: '#aeaeb2',
      brightBlack: '#636366',
      brightRed: '#ff6961',
      brightGreen: '#5ee27a',
      brightYellow: '#ffe14d',
      brightBlue: '#409cff',
      brightMagenta: '#da8fff',
      brightCyan: '#8fe0ff',
      brightWhite: '#ffffff'
    }
  })
}

/**
 * What a glass wall reads off its backdrop picture (deck's lib/glass.ts; not in workshop yet): the hue the picture leans to and how strongly
 * (0..1), and the hue of its most vivid patch, for the accent. Hues in degrees.
 */
export interface GlassTint {
  hue: number
  sat: number
  accentHue: number
}

export const GLASS_ID = 'glass'

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): string => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/**
 * The glass theme's variant for a picture: the chrome is the picture's own hue, held to
 * lightnesses that keep the text readable THROUGH the panes. styles.css lays a veil of `panel`
 * over the blurred picture (50% dark / 55% light) and each pane a tint of it (58% / 68%), so
 * under the worst picture there is — pure white in dark, pure black in light — a pane still
 * comes out at about 0.29 / 0.82 sRGB, where `ink` holds 7:1 or better and `muted` 4.5:1. Change
 * those alphas and these lightnesses together. The status colors and the ANSI palette are
 * Cream's: they mean something, so the picture does not get to repaint them. The terminal's
 * own background is clear (the pane behind it is the glass). `null` = no picture yet: neutral.
 */
export function glassVariant(dark: boolean, tint: GlassTint | null): ThemeVariant {
  const base = dark ? cream.dark : cream.light
  const h = tint?.hue ?? 30
  const s = tint ? 0.08 + 0.3 * Math.min(1, tint.sat * 1.6) : 0.06
  const panel = dark ? hsl(h, s, 0.1) : hsl(h, s * 0.8, 0.96)
  const ink = dark ? hsl(h, 0.2, 0.95) : hsl(h, 0.25, 0.11)
  const accent = tint ? (dark ? hsl(tint.accentHue, 0.78, 0.7) : hsl(tint.accentHue, 0.7, 0.38)) : base.accent
  return {
    ...base,
    bg: dark ? hsl(h, s, 0.07) : hsl(h, s * 0.8, 0.9),
    panel,
    ink,
    muted: dark ? hsl(h, 0.14, 0.75) : hsl(h, 0.14, 0.3),
    line: dark ? hsl(h, s * 0.8, 0.3) : hsl(h, s * 0.6, 0.72),
    accent,
    // The wall's hue and, tinted, the accent's (else the opposite hue), as faint washes of the panel.
    heads: [dark ? hsl(h, 0.3, 0.17) : hsl(h, 0.4, 0.89), dark ? hsl(tint?.accentHue ?? h + 180, 0.3, 0.17) : hsl(tint?.accentHue ?? h + 180, 0.4, 0.89)],
    term: {
      ...base.term,
      background: `${panel}00`,
      cursorAccent: panel,
      foreground: ink,
      selectionForeground: ink,
      cursor: accent,
      selectionBackground: `${accent}59`,
      black: dark ? base.term.black : ink,
      white: dark ? hsl(h, 0.12, 0.82) : base.term.white,
      brightBlack: dark ? hsl(h, 0.1, 0.62) : hsl(h, 0.1, 0.38)
    }
  }
}

/** Glass in the catalog: the neutral variants, which is all main ever needs (the window color). */
const glass: ThemeFamily = { id: GLASS_ID, name: 'Glass', light: glassVariant(false, null), dark: glassVariant(true, null) }

export const COSMOS_ID = 'cosmos'

/**
 * Deep Space: a flight through a field of stars and nebulae (renderer/src/cosmos.ts paints it on canvases
 * behind the window) with every pane a dark, see-through sheet over it, the terminal included.
 * Space is dark, so the family is dark in both appearances (`forcesDark`). Catppuccin Mocha's
 * status colors and ANSI palette (they mean something); the chrome is starlight on indigo; the
 * terminal's own background is clear, like glass's.
 */
const cosmosVariant: ThemeVariant = (() => {
  const base = catppuccin.dark
  const panel = '#0a0c1d'
  const ink = '#eceefe'
  const accent = '#b99cff'
  return {
    ...base,
    bg: '#04050d',
    panel,
    ink,
    muted: '#a9aed6',
    line: '#2f3566',
    accent,
    // Nebula violet and a deep teal (the stylesheet lets the sky through them, as through the panes).
    heads: ['#2a2058', '#0f3a4c'],
    term: { ...base.term, background: `${panel}00`, cursorAccent: panel, foreground: ink, selectionForeground: ink, cursor: accent, selectionBackground: `${accent}59` }
  }
})()
const cosmos: ThemeFamily = { id: COSMOS_ID, name: 'Deep Space', light: cosmosVariant, dark: cosmosVariant }

/** Themes painted over a wall of their own (glass's picture, cosmos's sky): the panes are see-through. */
export function seeThrough(themeId: string): boolean {
  return themeId === GLASS_ID || themeId === COSMOS_ID
}

/** Themes that are dark whatever `appearance` says. */
export function forcesDark(themeId: string): boolean {
  return themeId === COSMOS_ID
}

export const THEMES: ThemeFamily[] = [cream, solarized, gruvbox, catppuccin, nord, graphite, glass, cosmos]
/** Deep Space is workshop's default (CLAUDE.md §3). */
export const DEFAULT_THEME_ID = COSMOS_ID

export function themeById(id: string): ThemeFamily {
  return THEMES.find((t) => t.id === id) ?? cream
}

/** Resolve family + appearance (+ what the OS says, for `system`) to the live variant. */
export function resolveVariant(themeId: string, appearance: Appearance, systemDark: boolean): ThemeVariant {
  const fam = themeById(themeId)
  const dark = appearance === 'dark' || (appearance === 'system' && systemDark)
  return dark ? fam.dark : fam.light
}

/**
 * The CSS variables a variant becomes, named the same in core's window and in every tile, so a
 * tile's page can follow the theme with `var(--ws-panel)` and friends.
 */
/** `color` as text on the panel: moved toward the ink just far enough to reach 4.5:1. */
function readable(color: string, v: ThemeVariant): string {
  const c = parseColor(color)
  const panel = parseColor(v.panel)
  const ink = parseColor(v.ink)
  return c && panel && ink ? hex(ensureContrast(c, [panel], ink, 4.5)) : color
}

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
    '--ws-blocked': v.blocked,
    '--ws-starting': v.starting,
    '--ws-dead': v.dead,
    '--ws-head-1': v.heads[0],
    '--ws-head-2': v.heads[1],
    // Added and removed, good and bad (a diff's counts, a passing check): the terminal's own green
    // and red, moved toward the ink where needed so small text in them reads on the panel (4.5:1).
    '--ws-green': readable(v.term.green, v),
    '--ws-red': readable(v.term.red, v)
  }
}
