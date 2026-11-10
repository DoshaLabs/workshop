// `workshop.music` (permission "music", bridge 1.3): what Spotify or Music is playing, and its
// transport. Core drives the apps (main/music.ts); the tile never runs a script, never names a
// path, and needs no `net` for the artwork, which core fetches and serves on the tile's own
// origin. The shapes and the input rules live here so the page's early errors and main's checks
// cannot drift apart. CLAUDE.md §5.

export type MusicPlayer = 'spotify' | 'music'
export type MusicPlayState = 'playing' | 'paused' | 'stopped'
export type MusicRepeat = 'off' | 'one' | 'all'

export interface MusicTrack {
  title: string
  artist: string
  album: string
  durationMs: number
  /** tile://<id>/~music/art/<key>, on the tile's own origin, or null until core has the picture (or there is none). */
  art: string | null
}

export interface MusicState {
  /** The app being shown and controlled: the one playing, else the one running. Null when neither runs. */
  player: MusicPlayer | null
  state: MusicPlayState
  track: MusicTrack | null
  positionMs: number
  /** The app's own volume, 0 to 100, or null when nothing runs. */
  volume: number | null
  shuffle?: boolean
  repeat?: MusicRepeat
  /**
   * Why core cannot read or drive the app: 'denied' when macOS's Automation setting says workshop
   * may not control it (System Settings › Privacy & Security › Automation), 'failed' otherwise.
   */
  error?: 'denied' | 'failed'
  /** The error in words, for the tile to show. */
  message?: string
}

/** What a control call asks for. `uri` is Spotify only. */
export type MusicOp = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'seek' | 'volume' | 'uri'
export const MUSIC_OPS: readonly MusicOp[] = ['play', 'pause', 'toggle', 'next', 'previous', 'seek', 'volume', 'uri']

/** Where core serves the artwork on a tile's origin. */
export const MUSIC_ART_PREFIX = '/~music/art/'
/** An artwork key: a hash, never anything a person would recognise. */
export const ART_KEY_RE = /^[0-9a-f]{32}$/

export const NOTHING: MusicState = { player: null, state: 'stopped', track: null, positionMs: 0, volume: null }

/** A seek: whole milliseconds, 0 to 24 hours. Returns the error, or null. */
export function badSeek(ms: unknown): string | null {
  return typeof ms === 'number' && Number.isInteger(ms) && ms >= 0 && ms <= 86_400_000 ? null : 'music.seek: a whole number of milliseconds, 0 or more'
}

/** A volume: a whole number from 0 to 100. Returns the error, or null. */
export function badVolume(v: unknown): string | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? null : 'music.setVolume: a whole number from 0 to 100'
}

/**
 * A Spotify URI as Spotify's own share menu gives it: `spotify:<kind>:<22 base-62 characters>`.
 * Nothing else: no user-scoped legacy form, no query, no spaces, so whatever reaches Spotify is
 * one of these and nothing a script could mistake for code (it is passed as an argument anyway).
 */
export const SPOTIFY_URI_RE = /^spotify:(track|album|playlist|artist|episode|show):[0-9A-Za-z]{22}$/

export function badUri(uri: unknown): string | null {
  return typeof uri === 'string' && SPOTIFY_URI_RE.test(uri) ? null : 'music.playUri: a Spotify URI like spotify:track:<22 letters and digits> (track, album, playlist, artist, episode or show)'
}
