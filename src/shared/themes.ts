// Theme catalog shared by main (window background at boot, every tile's --ws-* variables) and
// the renderer (CSS variables + xterm palettes). Carried over from deck's src/shared/themes.ts. Every family has a light and a dark variant; `appearance` in settings
// picks which one is live. Keep this file dependency-free (the colour maths it borrows from ./knot is pure too).
import { contrast, ensureContrast, hex, luminance, parseColor, type RGB } from './knot'

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
   * The session column's four head colours, cycled tile by tile so a column of conversations is
   * not one wall of text: four of the family's own hues washed toward the panel, warm and cool in
   * turn, each keeping the ink at 4.5:1 (test/themes.test.ts).
   */
  heads: [string, string, string, string]
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
    heads: ['#f1dccd', '#dfe6d3', '#dce4ee', '#ece0ea'], // terracotta, sage, slate blue and plum, washed into the cream
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
    heads: ['#3a2a22', '#283326', '#24303d', '#35283a'], // rust, moss, slate and plum
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
    heads: ['#f8ebcc', '#e6f0ea', '#f9e9e5', '#efebf7'], // yellow, cyan, red and violet; close to the panel, as Solarized's own ink is only 5:1 on it
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
    heads: ['#04364a', '#11304a', '#10352d', '#262c48'], // cyan, blue, green and violet, just lifted off base03
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
    heads: ['#f2dfb0', '#e3e6c1', '#f0d5c0', '#e9dbd8'], // yellow, aqua, orange and purple
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
    heads: ['#3a3022', '#2b3530', '#3a2a2e', '#262f40'], // orange, aqua, purple and blue
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
    heads: ['#e6ddf7', '#d9eaf0', '#f3e0e4', '#e0eedd'], // mauve, sky, pink and green
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
    heads: ['#2c2540', '#1f2f3a', '#382634', '#22322a'], // mauve, sapphire, pink and green
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
    heads: ['#dbe4ef', '#e9e2d6', '#dcebdc', '#ece0e6'], // frost, sand, aurora green and purple
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
    heads: ['#323d52', '#3f3a45', '#2f3e38', '#4a3636'], // frost, aurora purple, green and red
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
    heads: ['#dfeafb', '#f2e4f4', '#e2f1e6', '#f6ebdc'], // blue, lavender, green and orange
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
    heads: ['#1d2a3c', '#2a2433', '#1f3127', '#33291d'], // blue, plum, green and orange
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
 * Robin's Egg: a 1950s kitchen fridge (Colin, 12 Nov 2026, from a photo of a retro French-door
 * fridge; the enamel there reads #84bec0). The window is the enamel, the panes the white
 * enamel inside the door, the lines chrome trim. Accents from the same kitchens: cherry red,
 * atomic mustard. Dark is the same fridge with the kitchen light off.
 */
const robin: ThemeFamily = {
  id: 'robin',
  name: "Robin's Egg",
  light: variant({
    bg: '#8ec9c8',
    panel: '#f6fbfa',
    ink: '#1c3336',
    muted: '#5a7477',
    line: '#c6d8d8',
    accent: '#22807f',
    busy: '#c98a1c',
    idle: '#9fb6b6',
    blocked: '#c8372d',
    starting: '#3478b0',
    dead: '#8a3328',
    heads: ['#d7ecea', '#f3e6d8', '#f8d6d6', '#f3ecc8'], // the egg's blue, its warm shell, cherry and mustard
    term: {
      foreground: '#1c3336',
      cursor: '#22807f',
      selectionBackground: '#c4e4e2',
      black: '#1c3336',
      red: '#c03a2e',
      green: '#2f7a3e',
      yellow: '#a8700f',
      blue: '#2f68a3',
      magenta: '#8c4f8f',
      cyan: '#1d7b7b',
      white: '#c6d8d8',
      brightBlack: '#5a7477',
      brightRed: '#de5446',
      brightGreen: '#43955a',
      brightYellow: '#c98a1c',
      brightBlue: '#4a86c2',
      brightMagenta: '#a86aab',
      brightCyan: '#2f9e9c',
      brightWhite: '#ffffff'
    }
  }),
  dark: variant({
    bg: '#0e2224',
    panel: '#15302f',
    ink: '#e4f3f1',
    muted: '#88a6a5',
    line: '#2a4a4a',
    accent: '#84cfcb',
    busy: '#e2a83e',
    idle: '#4f6b6b',
    blocked: '#e8594b',
    starting: '#6aa6dc',
    dead: '#a3443a',
    heads: ['#1d4441', '#33362a', '#43282a', '#3f3a20'], // teal, olive, cherry and mustard
    term: {
      foreground: '#e4f3f1',
      cursor: '#84cfcb',
      selectionBackground: '#2c5453',
      black: '#15302f',
      red: '#ec6a5c',
      green: '#8cc98e',
      yellow: '#e8bb5a',
      blue: '#7db0e0',
      magenta: '#c99ccc',
      cyan: '#84cfcb',
      white: '#c4d8d6',
      brightBlack: '#5f7d7c',
      brightRed: '#f5847a',
      brightGreen: '#a4dba5',
      brightYellow: '#f2cc74',
      brightBlue: '#97c3ea',
      brightMagenta: '#dab2dc',
      brightCyan: '#a3e0dc',
      brightWhite: '#f6fbfa'
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
    // Four washes of the panel a quarter turn apart round the wheel, from the accent's hue when
    // tinted, else from the wall's.
    heads: [0, 90, 180, 270].map((turn) => {
      const hue = ((tint?.accentHue ?? h) + turn) % 360
      return dark ? hsl(hue, 0.3, 0.17) : hsl(hue, 0.45, 0.89)
    }) as ThemeVariant['heads'],
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
    // Nebula violet, deep teal, magenta and blue (the stylesheet lets the sky through them, as through the panes).
    heads: ['#2a2058', '#0f3a4c', '#47204a', '#1a2a5c'],
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

export const THEMES: ThemeFamily[] = [cream, solarized, gruvbox, catppuccin, nord, graphite, robin, glass, cosmos]
/** Robin's Egg is workshop's default (Colin, 14 Nov 2026; CLAUDE.md §3). */
export const DEFAULT_THEME_ID = robin.id

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

/** How much of a colour a tinted chip lays over the panel (`color-mix(in srgb, X 16%, panel)`). */
export const TINT = 0.16

/** `a` laid over `b` at `share`, channel by channel in sRGB, as CSS color-mix(in srgb) does. */
function over(a: number[], b: number[], share: number): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round(a[i] * share + b[i] * (1 - share))) as [number, number, number]
}

/**
 * `base` tinted over the panel as strongly as `max` allows while the ink still reads on it (4.5:1):
 * a diff's row and word backgrounds. A theme whose ink is weak on its own panel (Solarized light,
 * 5:1) gets a fainter tint rather than unreadable code.
 */
function strongestTint(base: RGB, panel: RGB, ink: RGB, max: number): RGB {
  for (let share = max; share > 0.03; share -= 0.01) {
    const t = over(base, panel, share)
    if (contrast(ink, t) >= 4.5) return t
  }
  return over(base, panel, 0.03)
}

/**
 * `c` as small text reading 4.5:1 on every surface: moved toward the ink first, and past it, toward
 * black on a light panel or white on a dark one, when the ink itself is not enough. The colour's own
 * 16% tint (a chip) is one of the surfaces, asked again as the colour moves.
 */
function readableOn(c: RGB, surfaces: RGB[], panel: RGB, ink: RGB): RGB {
  const far: RGB = luminance(panel) > 0.18 ? [0, 0, 0] : [255, 255, 255]
  const ok = (x: RGB): boolean => [...surfaces, over(x, panel, TINT)].every((s) => contrast(x, s) >= 4.5)
  for (let step = 0; step <= 20; step++) {
    const x = step <= 10 ? over(ink, c, step / 10) : over(far, ink, (step - 10) / 10)
    if (ok(x)) return x
  }
  return far
}

/** A diff's backgrounds and the colours a tile writes text in, for one variant (see themeVars). */
function tileColours(v: ThemeVariant): Record<string, string> {
  const panel = parseColor(v.panel)
  const ink = parseColor(v.ink)
  const green = parseColor(readable(v.term.green, v))
  const red = parseColor(readable(v.term.red, v))
  if (!panel || !ink || !green || !red) return {}
  const addBg = strongestTint(green, panel, ink, 0.14)
  const delBg = strongestTint(red, panel, ink, 0.14)
  const addMark = strongestTint(green, panel, ink, 0.32)
  const delMark = strongestTint(red, panel, ink, 0.32)
  const surfaces = [panel, addBg, delBg, addMark, delMark]
  const text = (s: string): string => {
    const c = parseColor(s)
    return c ? hex(readableOn(c, surfaces, panel, ink)) : s
  }
  return {
    // Green and red again, now also readable on the diff's own backgrounds (a string in an added line).
    '--ws-green': text(hex(green)),
    '--ws-red': text(hex(red)),
    '--ws-add-bg': hex(addBg),
    '--ws-del-bg': hex(delBg),
    '--ws-add-mark': hex(addMark),
    '--ws-del-mark': hex(delMark),
    '--ws-yellow': text(v.term.yellow),
    '--ws-blue': text(v.term.blue),
    '--ws-magenta': text(v.term.magenta),
    '--ws-cyan': text(v.term.cyan),
    '--ws-accent-ink': text(v.accent)
  }
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
    ...Object.fromEntries(v.heads.map((c, i) => [`--ws-head-${i + 1}`, c])),
    // Added and removed, good and bad (a diff's counts, a passing check): the terminal's own green
    // and red, moved toward the ink where needed so small text in them reads on the panel (4.5:1).
    '--ws-green': readable(v.term.green, v),
    '--ws-red': readable(v.term.red, v),
    // A diff's backgrounds (rows, then changed words), as strong as the ink allows; then the
    // terminal's other four and the accent as text that reads (4.5:1) on the panel, on those, and on
    // a chip of its own 16% tint (TINT), so a tile can colour code, warnings and buttons in every
    // theme. --ws-accent itself stays the theme's: a fill, not always readable as text.
    ...tileColours(v)
  }
}
