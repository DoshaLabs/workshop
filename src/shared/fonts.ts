// Core's typefaces, shared by its own window and every tile: Nunito for the interface, JetBrains
// Mono for terminals, paths and code, Source Serif 4 for prose that is read rather than operated
// (an article, a rendered note, a conversation). All three are under the SIL Open Font License
// and are in assets/fonts with their licences (ground rule 6). The files are the Latin subsets;
// other scripts fall back to the system's fonts, which the stacks below end with.

export interface FontFile {
  family: string
  file: string
  style: 'normal' | 'italic'
  /** A variable font's weight range, as @font-face writes it. */
  weight: string
}

export const FONT_FILES: FontFile[] = [
  { family: 'Nunito', file: 'nunito.woff2', style: 'normal', weight: '200 1000' },
  { family: 'Nunito', file: 'nunito-italic.woff2', style: 'italic', weight: '200 1000' },
  { family: 'JetBrains Mono', file: 'jetbrains-mono.woff2', style: 'normal', weight: '100 800' },
  { family: 'Source Serif 4', file: 'source-serif-4.woff2', style: 'normal', weight: '200 900' },
  { family: 'Source Serif 4', file: 'source-serif-4-italic.woff2', style: 'italic', weight: '200 900' }
]

export const FONT_SANS = "'Nunito', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif"
export const FONT_MONO = "'JetBrains Mono', 'SF Mono', Menlo, Monaco, monospace"
export const FONT_SERIF = "'Source Serif 4', 'Iowan Old Style', Georgia, serif"

/** Handed to core's window and to every tile beside the theme's colours. */
export const FONT_VARS: Record<string, string> = {
  '--ws-font': FONT_SANS,
  '--ws-font-mono': FONT_MONO,
  '--ws-font-serif': FONT_SERIF
}

/** Where a tile's page finds a font file: its own origin, so its CSP needs only `font-src 'self'`. */
export const FONTS_PREFIX = '/~fonts/'
