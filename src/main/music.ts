// `workshop.music`: core reads and drives Spotify.app and Music.app for a tile that declares
// "music", so a Spotify tile can be built in the sandbox, the author's way, with no backend
// (Colin, 10 Nov 2026; ground rule 9). CLAUDE.md §5.
//
// How it talks to the apps: osascript, with three FIXED scripts (SCRIPTS below). Nothing a tile
// sends is ever put into a script's text: the player, the op and its one value go in as argv,
// after main has checked each against a closed list or a number range or SPOTIFY_URI_RE.
//
// It never launches an app. Every script asks `running()` first, which Launch Services answers
// without sending the app an Apple event, and only then talks to it. (A plain `tell application
// "Spotify"` that sends anything would start Spotify.) `show` (bridge 1.6) brings the app in use to
// the front with `activate()`, behind the same guard, so it too never starts one; the bridge allows
// it only straight after a click or key in the tile, once a second (music-bridge.ts).
//
// It polls only while some live tile page with "music" is watching: about once a second while
// playing, more slowly when paused, stopped or refused, and not at all when nobody watches. One
// osascript call reads both apps. `get()` without a watcher reads once, at most every 800 ms.
//
// The artwork: Spotify gives an https URL on its CDN, which main fetches (only those hosts, under
// 2 MB, and only a real image); Music gives the picture's bytes, which a fourth fixed script
// writes to a file in a folder main made. Either way it is kept in memory under a hash and served
// at tile://<id>/~music/art/<hash> on the asking tile's own origin, so the tile needs no `net`.
//
// No electron import: index.ts hands in the runner, so the unit tests and the smoke run drive
// this with a fake one and never touch the real apps.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MUSIC_ART_PREFIX,
  MUSIC_OPS,
  NOTHING,
  badSeek,
  badUri,
  badVolume,
  type MusicOp,
  type MusicPlayState,
  type MusicPlayer,
  type MusicRepeat,
  type MusicState
} from '@shared/music'

export type RunKind = 'poll' | 'control' | 'art'
/** Runs one of the fixed scripts with these arguments and resolves to what it printed. */
export type Runner = (kind: RunKind, args: string[]) => Promise<string>
/** Fetches Spotify's artwork URL: the image, or null. */
export type ArtFetcher = (url: string) => Promise<Art | null>

export interface Art {
  type: string
  body: Buffer
}

const APP_NAME: Record<MusicPlayer, string> = { spotify: 'Spotify', music: 'Music' }

/**
 * The scripts. JavaScript for Automation for the poll and the controls, because it reads an app's
 * terms when it runs, not when it compiles, so one script can name both apps whether or not each
 * is installed, and it prints JSON. AppleScript for Music's artwork, the one thing JXA cannot hand
 * back (raw picture data); it is written to the file named by argv[1], a path main chose.
 */
export const SCRIPTS: Record<RunKind, { lang: 'JavaScript' | 'AppleScript'; source: string }> = {
  poll: {
    lang: 'JavaScript',
    source: `function run() {
  var out = {}
  var apps = [['spotify', 'com.spotify.client'], ['music', 'com.apple.Music']]
  for (var i = 0; i < apps.length; i++) {
    var key = apps[i][0], app = null, running = false
    try { app = Application(apps[i][1]); running = app.running() } catch (e) {}
    if (!running) { out[key] = { running: false }; continue }
    var r = { running: true }
    try {
      r.state = String(app.playerState())
      r.volume = app.soundVolume()
      if (key === 'spotify') { r.shuffle = app.shuffling(); r.repeat = app.repeating() ? 'all' : 'off' }
      else { r.shuffle = app.shuffleEnabled(); r.repeat = String(app.songRepeat()) }
      r.position = app.playerPosition()
      try {
        var t = app.currentTrack
        r.track = { title: t.name(), artist: t.artist(), album: t.album(), duration: t.duration() }
        if (key === 'spotify') { r.track.id = t.id(); r.track.art = t.artworkUrl() } else r.track.id = t.persistentID()
      } catch (e) { r.track = null }
    } catch (e) { r.error = e.errorNumber || -1; r.message = String(e.message || e) }
    out[key] = r
  }
  return JSON.stringify(out)
}`
  },
  control: {
    lang: 'JavaScript',
    source: `function run(argv) {
  var which = argv[0], op = argv[1], arg = argv[2]
  var id = which === 'spotify' ? 'com.spotify.client' : which === 'music' ? 'com.apple.Music' : ''
  if (!id) return JSON.stringify({ ok: false, error: 'player' })
  var app = Application(id)
  if (!app.running()) return JSON.stringify({ ok: false, error: 'not-running' })
  try {
    if (op === 'play') app.play()
    else if (op === 'pause') app.pause()
    else if (op === 'toggle') app.playpause()
    else if (op === 'next') app.nextTrack()
    else if (op === 'previous') app.previousTrack()
    else if (op === 'seek') { var ms = Number(arg); if (!isFinite(ms) || ms < 0) throw new Error('seek'); app.playerPosition = ms / 1000 }
    else if (op === 'volume') { var v = Number(arg); if (!isFinite(v) || v < 0 || v > 100) throw new Error('volume'); app.soundVolume = v }
    else if (op === 'uri' && which === 'spotify' && /^spotify:[a-z]+:[0-9A-Za-z]{22}$/.test(arg)) app.playTrack(arg)
    else if (op === 'show') app.activate()
    else return JSON.stringify({ ok: false, error: 'op' })
  } catch (e) { return JSON.stringify({ ok: false, error: e.errorNumber || -1, message: String(e.message || e) }) }
  return JSON.stringify({ ok: true })
}`
  },
  art: {
    lang: 'AppleScript',
    source: `on run argv
	if not (application id "com.apple.Music" is running) then return "none"
	tell application id "com.apple.Music"
		try
			set d to raw data of artwork 1 of current track
		on error
			return "none"
		end try
	end tell
	set f to open for access (POSIX file (item 1 of argv)) with write permission
	try
		set eof f to 0
		write d to f
		close access f
	on error m number n
		close access f
		error m number n
	end try
	return "ok"
end run`
  }
}

/** The real runner: /usr/bin/osascript with the fixed script and argv, never a shell. */
export const osascriptRunner: Runner = (kind, args) =>
  new Promise((resolve, reject) => {
    const { lang, source } = SCRIPTS[kind]
    execFile('/usr/bin/osascript', ['-l', lang, '-e', source, ...args], { timeout: 8000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)))
      else resolve(String(stdout).trim())
    })
  })

/** macOS's "not allowed to send Apple events" (the user said no, or has not been asked and cannot be). */
export const NOT_PERMITTED = -1743

// ---- Reading what the poll printed ---------------------------------------------------------

export interface TrackReading {
  title: string
  artist: string
  album: string
  durationMs: number
  /** Spotify's track URI, Music's persistent id: what the artwork is keyed on. */
  id: string
  /** Spotify only: its artwork URL. */
  artUrl?: string
}

export interface AppReading {
  running: boolean
  state?: MusicPlayState
  volume?: number
  shuffle?: boolean
  repeat?: MusicRepeat
  positionMs?: number
  track?: TrackReading | null
  /** An Apple event error number (NOT_PERMITTED when macOS refused). */
  error?: number
  message?: string
}

export type PollReading = Record<MusicPlayer, AppReading>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function playState(v: unknown): MusicPlayState {
  // Music says "fast forwarding" and "rewinding" too: the music is moving, so it is playing.
  if (v === 'playing' || v === 'fast forwarding' || v === 'rewinding') return 'playing'
  return v === 'paused' ? 'paused' : 'stopped'
}

function repeatOf(v: unknown): MusicRepeat | undefined {
  return v === 'off' || v === 'one' || v === 'all' ? v : undefined
}

/** One app's part of the poll. Spotify's duration is in milliseconds, Music's in seconds; positions are seconds for both. */
export function readApp(raw: unknown, player: MusicPlayer): AppReading {
  if (!isObj(raw) || raw.running !== true) return { running: false }
  const r: AppReading = { running: true }
  if (raw.error !== undefined) {
    r.error = num(raw.error) ?? -1
    r.message = text(raw.message)
    return r
  }
  r.state = playState(raw.state)
  const vol = num(raw.volume)
  if (vol !== undefined) r.volume = Math.max(0, Math.min(100, Math.round(vol)))
  if (typeof raw.shuffle === 'boolean') r.shuffle = raw.shuffle
  const rep = repeatOf(raw.repeat)
  if (rep) r.repeat = rep
  r.positionMs = Math.max(0, Math.round((num(raw.position) ?? 0) * 1000))
  const t = raw.track
  if (isObj(t) && (text(t.title) || text(t.id))) {
    const d = num(t.duration) ?? 0
    r.track = {
      title: text(t.title),
      artist: text(t.artist),
      album: text(t.album),
      durationMs: Math.max(0, Math.round(player === 'spotify' ? d : d * 1000)),
      id: text(t.id, 200)
    }
    const art = text(t.art, 500)
    if (player === 'spotify' && art) r.track.artUrl = art
  } else r.track = null
  return r
}

/** The poll's output. Throws on anything that is not the poll script's JSON. */
export function parsePoll(stdout: string): PollReading {
  const raw = JSON.parse(stdout) as unknown
  if (!isObj(raw)) throw new Error('music: the poll printed something else')
  return { spotify: readApp(raw.spotify, 'spotify'), music: readApp(raw.music, 'music') }
}

// ---- Choosing the app ----------------------------------------------------------------------

const rank = (a: AppReading): number => (!a.running ? 0 : a.state === 'playing' ? 3 : a.state === 'paused' && a.track ? 2 : 1)

/**
 * Which app to show and drive: the one playing, else one paused on a track, else one running.
 * A tie keeps the app chosen last time (so two apps both paused do not swap), then Spotify.
 */
export function choosePlayer(r: PollReading, previous: MusicPlayer | null): MusicPlayer | null {
  const s = rank(r.spotify)
  const m = rank(r.music)
  if (!s && !m) return null
  if (s !== m) return s > m ? 'spotify' : 'music'
  return previous ?? 'spotify'
}

/** Why core cannot reach `player`, in words a tile can show. */
export function deniedMessage(player: MusicPlayer): string {
  return `macOS has not allowed workshop to control ${APP_NAME[player]}. Turn it on in System Settings › Privacy & Security › Automation, then come back.`
}

/** The tile's view of a poll, with the artwork as a key (`artKey`) that the bridge turns into a URL on each tile's origin. */
export interface HostState extends Omit<MusicState, 'track'> {
  track: (Omit<MusicState['track'] & object, 'art'> & { artKey: string | null }) | null
}

export function toState(r: PollReading, player: MusicPlayer | null, artKey: string | null): HostState {
  if (!player) return { ...NOTHING, track: null }
  const a = r[player]
  if (a.error !== undefined) {
    const denied = a.error === NOT_PERMITTED
    return { ...NOTHING, track: null, player, error: denied ? 'denied' : 'failed', message: denied ? deniedMessage(player) : `${APP_NAME[player]} did not answer: ${a.message || `error ${a.error}`}` }
  }
  const s: HostState = {
    player,
    state: a.state ?? 'stopped',
    track: a.track ? { title: a.track.title, artist: a.track.artist, album: a.track.album, durationMs: a.track.durationMs, artKey } : null,
    positionMs: a.positionMs ?? 0,
    volume: a.volume ?? null
  }
  if (a.shuffle !== undefined) s.shuffle = a.shuffle
  if (a.repeat) s.repeat = a.repeat
  return s
}

/** The state as one tile sees it: the artwork on that tile's own origin. */
export function forTile(s: HostState, tileId: string): MusicState {
  if (!s.track) return { ...s, track: null }
  const { artKey, ...t } = s.track
  return { ...s, track: { ...t, art: artKey ? `tile://${tileId}${MUSIC_ART_PREFIX}${artKey}` : null } }
}

/** A track's artwork key: a hash of which app and which track, so it says nothing by itself. */
export function artKeyOf(player: MusicPlayer, track: TrackReading): string {
  return createHash('sha256').update(`${player}\0${track.id}\0${track.title}\0${track.artist}\0${track.album}`).digest('hex').slice(0, 32)
}

// ---- When to poll --------------------------------------------------------------------------

export const POLL_PLAYING_MS = 1000
export const POLL_PAUSED_MS = 3000
export const POLL_IDLE_MS = 5000
export const POLL_REFUSED_MS = 15_000
/** How soon after a control the state is read again (the app takes a moment to change). */
export const AFTER_CONTROL_MS = 250
/** A get() within this of the last reading is answered from it. */
export const FRESH_MS = 800

/** How long until the next poll, or null for none: nobody is watching. */
export function nextDelay(watchers: number, s: Pick<MusicState, 'player' | 'state' | 'error'>): number | null {
  if (watchers <= 0) return null
  if (s.error === 'denied') return POLL_REFUSED_MS
  if (s.error) return POLL_IDLE_MS
  if (!s.player) return POLL_IDLE_MS
  return s.state === 'playing' ? POLL_PLAYING_MS : s.state === 'paused' ? POLL_PAUSED_MS : POLL_IDLE_MS
}

// ---- Controls ------------------------------------------------------------------------------

/**
 * The argv for a control, or a thrown error: the op from the closed list, its value checked
 * (seek and volume whole numbers in range, a URI only Spotify's own form and only to Spotify).
 */
export function controlArgs(player: MusicPlayer | null, op: unknown, arg?: unknown): string[] {
  if (typeof op !== 'string' || !(MUSIC_OPS as readonly string[]).includes(op)) throw new Error('music: not a control')
  const o = op as MusicOp
  let bad: string | null = null
  if (o === 'seek') bad = badSeek(arg)
  else if (o === 'volume') bad = badVolume(arg)
  else if (o === 'uri') bad = badUri(arg)
  if (bad) throw new Error(bad)
  if (!player) throw new Error('music: neither Spotify nor Music is open (workshop never opens them for you)')
  if (o === 'uri' && player !== 'spotify') throw new Error('music.playUri: Spotify only, and Spotify is not the app in use')
  return o === 'seek' || o === 'volume' || o === 'uri' ? [player, o, String(arg)] : [player, o]
}

/** How long after a click or key in the page `show` may follow it (as the overlay and a sign-in). */
export const SHOW_GESTURE_MS = 5000
/** At most one `show` a second per tile, as openExternal. */
export const SHOW_EVERY_MS = 1000

/**
 * Whether a page may bring the player to the front now (bridge 1.6): bringing an app forward takes
 * focus from the user, so only straight after real input in that page (`gestureAt`, set by
 * index.ts from Chromium's input events, never a script's click), one call per input, and once a
 * second per tile. Throws the sentence the tile sees; on success uses the input up.
 */
export function allowShow(g: { tile: { manifest: { id: string } }; gestureAt: number }, lastShow: Map<string, number>, now: number): void {
  if (now - g.gestureAt > SHOW_GESTURE_MS) throw new Error('music.show: only in answer to a click or key in the tile')
  const id = g.tile.manifest.id
  if (now - (lastShow.get(id) ?? -Infinity) < SHOW_EVERY_MS) throw new Error('music.show: one a second')
  g.gestureAt = 0
  lastShow.set(id, now)
}

/** What the control script printed, as an error to throw or null. */
export function controlError(stdout: string, player: MusicPlayer): string | null {
  let r: { ok?: unknown; error?: unknown; message?: unknown }
  try {
    r = JSON.parse(stdout)
  } catch {
    return 'music: the control script printed something else'
  }
  if (r?.ok === true) return null
  if (r?.error === 'not-running') return `music: ${APP_NAME[player]} is not open`
  if (r?.error === NOT_PERMITTED) return deniedMessage(player)
  return `music: ${APP_NAME[player]} refused (${typeof r?.message === 'string' ? r.message.slice(0, 200) : String(r?.error)})`
}

// ---- Artwork -------------------------------------------------------------------------------

export const ART_MAX = 2 * 1024 * 1024
/** Spotify's image hosts. The URL comes from Spotify.app, not a tile, but core still goes nowhere else. */
const SPOTIFY_ART_HOST = /(^|\.)(scdn\.co|spotifycdn\.com)$/

export function artUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.port && !u.username && SPOTIFY_ART_HOST.test(u.hostname)
  } catch {
    return false
  }
}

/** The picture's type from its first bytes, or null if it is not a JPEG, PNG, WebP or GIF. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif'
  return null
}

/** The real fetcher: Spotify's CDN only, no redirects, 5 s, 2 MB, an image or nothing. */
export const fetchSpotifyArt: ArtFetcher = async (url) => {
  if (!artUrlAllowed(url)) return null
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
  if (!res.ok || !res.body) return null
  if (Number(res.headers.get('content-length') ?? 0) > ART_MAX) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length
    if (size > ART_MAX) return null
    chunks.push(Buffer.from(c))
  }
  const body = Buffer.concat(chunks)
  const type = sniffImage(body)
  return type ? { type, body } : null
}

// ---- The host ------------------------------------------------------------------------------

export interface MusicHostOptions {
  runner: Runner
  fetchArt: ArtFetcher
  /** Every time what the tiles see changes. */
  onChange: (s: HostState) => void
  /** A folder for Music's artwork file; made on first use. */
  tmpDir?: () => Promise<string>
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  now?: () => number
}

/** How many pictures are kept: the current track's, and a few before it for a tile drawing a history. */
const ART_KEPT = 16

export class MusicHost {
  private watchers = new Set<number>()
  private state: HostState = { ...NOTHING, track: null }
  private player: MusicPlayer | null = null
  private readAt = 0
  private timer: unknown = null
  private inflight: Promise<HostState> | null = null
  private art = new Map<string, Art>()
  /** Artwork being fetched, or found to have none (null), by key. */
  private artTried = new Map<string, Promise<void> | null>()
  private controls: Promise<unknown> = Promise.resolve()
  private queued = 0
  private dir: Promise<string> | null = null
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (t: unknown) => void
  private readonly now: () => number

  constructor(private readonly o: MusicHostOptions) {
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout))
    this.now = o.now ?? Date.now
  }

  /** A page started watching (by webContents id). The first watcher starts the poll. */
  watch(id: number): void {
    const first = this.watchers.size === 0
    this.watchers.add(id)
    if (first) this.schedule(0)
  }

  /** A page stopped watching, reloaded or closed. The last one stops the poll. */
  unwatch(id: number): void {
    if (!this.watchers.delete(id) || this.watchers.size) return
    this.cancel()
  }

  get watching(): number {
    return this.watchers.size
  }

  /** The last reading, or null before the first. */
  last(): HostState | null {
    return this.readAt ? this.state : null
  }

  /** The state now: the last reading if it is fresh, else a new one. */
  async get(): Promise<HostState> {
    if (this.readAt && this.now() - this.readAt < FRESH_MS) return this.state
    return this.poll()
  }

  /** A transport call to the app in use. Throws with a sentence a tile can show. */
  async control(op: unknown, arg?: unknown): Promise<void> {
    if (this.queued >= 4) throw new Error('music: too many calls at once')
    // Checked before it waits in line, so a bad value is refused at once.
    controlArgs(this.player ?? 'spotify', op, arg)
    this.queued++
    const run = this.controls.then(async () => {
      if (!this.readAt || this.now() - this.readAt > POLL_IDLE_MS) await this.poll()
      const player = this.player
      const args = controlArgs(player, op, arg)
      if (player && this.state.error === 'denied') throw new Error(deniedMessage(player))
      const err = controlError(await this.o.runner('control', args), player!)
      if (err) throw new Error(err)
    })
    this.controls = run.catch(() => undefined).finally(() => this.queued--)
    try {
      await run
    } finally {
      if (this.watchers.size) this.schedule(AFTER_CONTROL_MS)
    }
  }

  /** A picture core holds, by key: for the tile:// handler. */
  artwork(key: string): Art | undefined {
    return this.art.get(key)
  }

  stop(): void {
    this.watchers.clear()
    this.cancel()
  }

  private cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.cancel()
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.poll()
    }, ms)
  }

  /** One reading of both apps; one at a time, whoever asks. */
  poll(): Promise<HostState> {
    if (!this.inflight) {
      this.inflight = this.read().finally(() => {
        this.inflight = null
        const next = nextDelay(this.watchers.size, this.state)
        if (next !== null && this.timer === null) this.schedule(next)
      })
    }
    return this.inflight
  }

  private async read(): Promise<HostState> {
    let next: HostState
    try {
      const r = parsePoll(await this.o.runner('poll', []))
      this.player = choosePlayer(r, this.player)
      const t = this.player ? r[this.player].track : null
      const key = this.player && t ? artKeyOf(this.player, t) : null
      if (key && this.player && t) this.wantArt(key, this.player, t)
      next = toState(r, this.player, key && this.art.has(key) ? key : null)
    } catch (err) {
      next = { ...NOTHING, track: null, error: 'failed', message: `music: ${(err as Error).message}`.slice(0, 300) }
    }
    this.readAt = this.now()
    this.set(next)
    return this.state
  }

  private set(next: HostState): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    this.o.onChange(next)
  }

  /** Starts fetching a track's picture once; when it lands, the tiles hear of it. */
  private wantArt(key: string, player: MusicPlayer, t: TrackReading): void {
    if (this.art.has(key) || this.artTried.has(key)) return
    const job = (async () => {
      let got: Art | null = null
      try {
        got = player === 'spotify' ? (t.artUrl ? await this.o.fetchArt(t.artUrl) : null) : await this.musicArt()
      } catch {
        got = null
      }
      this.artTried.set(key, null)
      if (this.artTried.size > 64) this.artTried.delete(this.artTried.keys().next().value!)
      if (!got) return
      this.art.set(key, got)
      if (this.art.size > ART_KEPT) this.art.delete(this.art.keys().next().value!)
      const cur = this.state.track
      if (cur && cur.artKey === null && this.player === player && artKeyOf(player, t) === key && cur.title === t.title) this.set({ ...this.state, track: { ...cur, artKey: key } })
    })()
    this.artTried.set(key, job)
  }

  /** Music's picture of the current track, through a file in core's own temporary folder. */
  private async musicArt(): Promise<Art | null> {
    this.dir ??= this.o.tmpDir ? this.o.tmpDir() : mkdtemp(join(tmpdir(), 'workshop-music-'))
    const file = join(await this.dir, `art-${process.pid}-${this.now()}`)
    try {
      if ((await this.o.runner('art', [file])) !== 'ok') return null
      const body = await readFile(file)
      const type = body.length <= ART_MAX ? sniffImage(body) : null
      return type ? { type, body } : null
    } finally {
      await rm(file, { force: true })
    }
  }
}
