import { writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AFTER_CONTROL_MS,
  MusicHost,
  NOT_PERMITTED,
  POLL_IDLE_MS,
  POLL_PAUSED_MS,
  POLL_PLAYING_MS,
  POLL_REFUSED_MS,
  SCRIPTS,
  artKeyOf,
  artUrlAllowed,
  choosePlayer,
  allowShow,
  controlArgs,
  controlError,
  forTile,
  nextDelay,
  parsePoll,
  sniffImage,
  toState,
  type HostState,
  type RunKind,
  type Runner
} from '../src/main/music'
import { SPOTIFY_URI_RE, badSeek, badUri, badVolume } from '@shared/music'

const SPOTIFY_TRACK = { title: 'Umbrella Sky', artist: 'DowtownRain', album: 'Umbrella Sky', duration: 117433, id: 'spotify:track:2Y4rRlanUi7BHYLBDTYELz', art: 'https://i.scdn.co/image/ab67616d0000b2735553907d6385de59b951e48e' }
/** What the poll printed on a real Mac (10 Nov 2026), Spotify playing and Music closed. */
const REAL = JSON.stringify({ spotify: { running: true, state: 'playing', volume: 81, shuffle: true, repeat: 'off', position: 40.895999908447266, track: SPOTIFY_TRACK }, music: { running: false } })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

describe('reading the poll', () => {
  it('reads Spotify as the real poll printed it: milliseconds for the length, seconds for the position', () => {
    const r = parsePoll(REAL)
    expect(r.spotify).toEqual({
      running: true,
      state: 'playing',
      volume: 81,
      shuffle: true,
      repeat: 'off',
      positionMs: 40896,
      track: { title: 'Umbrella Sky', artist: 'DowtownRain', album: 'Umbrella Sky', durationMs: 117433, id: SPOTIFY_TRACK.id, artUrl: SPOTIFY_TRACK.art }
    })
    expect(r.music).toEqual({ running: false })
  })

  it('reads Music in seconds, its fast-forward as playing, its repeat as it says it', () => {
    const r = parsePoll(JSON.stringify({ spotify: { running: false }, music: { running: true, state: 'fast forwarding', volume: 100.4, shuffle: false, repeat: 'one', position: 2.5, track: { title: 'Song', artist: 'A', album: 'B', duration: 200.25, id: 'ABCDEF0123456789' } } }))
    expect(r.music.state).toBe('playing')
    expect(r.music.track?.durationMs).toBe(200250)
    expect(r.music.positionMs).toBe(2500)
    expect(r.music.volume).toBe(100)
    expect(r.music.repeat).toBe('one')
    // Music has no artwork URL: core asks it for the bytes instead.
    expect(r.music.track?.artUrl).toBeUndefined()
  })

  it('keeps an app\'s error, and takes no track when there is none', () => {
    const r = parsePoll(JSON.stringify({ spotify: { running: true, error: NOT_PERMITTED, message: 'Not authorized' }, music: { running: true, state: 'stopped', volume: 50, position: 0, track: null } }))
    expect(r.spotify).toEqual({ running: true, error: NOT_PERMITTED, message: 'Not authorized' })
    expect(r.music.track).toBeNull()
    expect(r.music.state).toBe('stopped')
  })

  it('takes nothing it does not expect: odd types are dropped, long strings cut, garbage refused', () => {
    const r = parsePoll(JSON.stringify({ spotify: { running: true, state: 'weird', volume: 'loud', repeat: 'sometimes', shuffle: 'yes', position: null, track: { title: 'x'.repeat(1000), duration: 'long' } }, music: 'no' }))
    expect(r.spotify.state).toBe('stopped')
    expect(r.spotify.volume).toBeUndefined()
    expect(r.spotify.repeat).toBeUndefined()
    expect(r.spotify.shuffle).toBeUndefined()
    expect(r.spotify.positionMs).toBe(0)
    expect(r.spotify.track?.title.length).toBe(300)
    expect(r.spotify.track?.durationMs).toBe(0)
    expect(r.music).toEqual({ running: false })
    expect(() => parsePoll('execution error: nope')).toThrow()
    expect(() => parsePoll('[]')).toThrow(/something else/)
  })
})

describe('choosing the app', () => {
  const app = (state: string, track = true): unknown => ({ running: true, state, volume: 1, position: 0, track: track ? { title: 't', id: 'i' } : null })
  const poll = (spotify: unknown, music: unknown) => parsePoll(JSON.stringify({ spotify, music }))
  const off = { running: false }

  it('prefers the one playing, then one paused on a track, then one running', () => {
    expect(choosePlayer(poll(app('paused'), app('playing')), 'spotify')).toBe('music')
    expect(choosePlayer(poll(app('stopped', false), app('paused')), 'spotify')).toBe('music')
    expect(choosePlayer(poll(off, app('stopped', false)), 'spotify')).toBe('music')
    expect(choosePlayer(poll(off, off), 'music')).toBeNull()
  })

  it('a tie keeps the last choice, then Spotify', () => {
    expect(choosePlayer(poll(app('paused'), app('paused')), 'music')).toBe('music')
    expect(choosePlayer(poll(app('playing'), app('playing')), null)).toBe('spotify')
  })

  it('an app that refuses is still the one shown, so the tile can say why', () => {
    const r = poll({ running: true, error: NOT_PERMITTED }, off)
    expect(choosePlayer(r, null)).toBe('spotify')
    const s = toState(r, 'spotify', null)
    expect(s.error).toBe('denied')
    expect(s.message).toMatch(/System Settings › Privacy & Security › Automation/)
    expect(s.track).toBeNull()
    expect(toState(poll({ running: true, error: -600, message: 'gone' }, off), 'spotify', null)).toMatchObject({ error: 'failed', message: expect.stringMatching(/gone/) })
  })
})

describe('the state a tile sees', () => {
  it('puts the artwork on the asking tile\'s own origin', () => {
    const r = parsePoll(REAL)
    const key = artKeyOf('spotify', r.spotify.track!)
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    const s = toState(r, 'spotify', key)
    expect(forTile(s, 'spotify-tile').track?.art).toBe(`tile://spotify-tile/~music/art/${key}`)
    expect(forTile(s, 'other').track?.art).toBe(`tile://other/~music/art/${key}`)
    expect(forTile(toState(r, 'spotify', null), 'x').track?.art).toBeNull()
    // Nothing remote ever reaches the page.
    expect(JSON.stringify(forTile(s, 'x'))).not.toMatch(/scdn|https/)
    expect(forTile(s, 'x')).toMatchObject({ player: 'spotify', state: 'playing', positionMs: 40896, volume: 81, shuffle: true, repeat: 'off' })
  })

  it('says nothing is playing when no app runs', () => {
    expect(forTile(toState(parsePoll('{"spotify":{"running":false},"music":{"running":false}}'), null, null), 'x')).toEqual({ player: null, state: 'stopped', track: null, positionMs: 0, volume: null })
  })
})

describe('when to poll', () => {
  it('not at all with nobody watching; faster while playing; slowly when refused', () => {
    expect(nextDelay(0, { player: 'spotify', state: 'playing' })).toBeNull()
    expect(nextDelay(1, { player: 'spotify', state: 'playing' })).toBe(POLL_PLAYING_MS)
    expect(nextDelay(2, { player: 'music', state: 'paused' })).toBe(POLL_PAUSED_MS)
    expect(nextDelay(1, { player: 'music', state: 'stopped' })).toBe(POLL_IDLE_MS)
    expect(nextDelay(1, { player: null, state: 'stopped' })).toBe(POLL_IDLE_MS)
    expect(nextDelay(1, { player: 'spotify', state: 'stopped', error: 'denied' })).toBe(POLL_REFUSED_MS)
    expect(nextDelay(1, { player: null, state: 'stopped', error: 'failed' })).toBe(POLL_IDLE_MS)
    expect(POLL_PLAYING_MS).toBeGreaterThanOrEqual(1000)
  })
})

describe('what a tile may send', () => {
  it('takes whole numbers in range for seek and volume', () => {
    expect(badSeek(0)).toBeNull()
    expect(badSeek(61_000)).toBeNull()
    for (const v of [-1, 1.5, NaN, Infinity, '100', null, 86_400_001]) expect(badSeek(v)).toMatch(/seek/)
    expect(badVolume(0)).toBeNull()
    expect(badVolume(100)).toBeNull()
    for (const v of [-1, 101, 50.5, '50', undefined]) expect(badVolume(v)).toMatch(/0 to 100/)
  })

  it('takes a Spotify URI only in the form Spotify\'s share menu gives', () => {
    for (const u of ['spotify:track:2Y4rRlanUi7BHYLBDTYELz', 'spotify:album:4LH4d3cOWNNsVw41Gqt2kv', 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 'spotify:artist:0OdUWJ0sBjDrqHygGUXeCF', 'spotify:episode:512ojhOuo1ktJprKbVcKyQ', 'spotify:show:5CfCWKI5pZ28U0uOzXkDHe'])
      expect(badUri(u)).toBeNull()
    for (const u of [
      'spotify:track:2Y4rRlanUi7BHYLBDTYELz" & do shell script "id',
      'spotify:track:2Y4rRlanUi7BHYLBDTYEL',
      'spotify:track:2Y4rRlanUi7BHYLBDTYELzz',
      'spotify:user:someone:playlist:37i9dQZF1DXcBWIGoYBM5M',
      'spotify:local:a:b:c:1',
      'https://open.spotify.com/track/2Y4rRlanUi7BHYLBDTYELz',
      'spotify:track:2Y4rRlanUi7BHYLBDTYEL\n',
      'SPOTIFY:track:2Y4rRlanUi7BHYLBDTYELz',
      42
    ])
      expect(badUri(u)).toMatch(/Spotify URI/)
    expect(SPOTIFY_URI_RE.test('spotify:track:2Y4rRlanUi7BHYLBDTYELz')).toBe(true)
  })

  it('turns a control into argv: a closed list of ops, values as checked strings', () => {
    expect(controlArgs('spotify', 'play')).toEqual(['spotify', 'play'])
    expect(controlArgs('music', 'toggle')).toEqual(['music', 'toggle'])
    expect(controlArgs('spotify', 'seek', 61000)).toEqual(['spotify', 'seek', '61000'])
    expect(controlArgs('music', 'volume', 0)).toEqual(['music', 'volume', '0'])
    expect(controlArgs('spotify', 'uri', 'spotify:track:2Y4rRlanUi7BHYLBDTYELz')).toEqual(['spotify', 'uri', 'spotify:track:2Y4rRlanUi7BHYLBDTYELz'])
    expect(() => controlArgs('spotify', 'quit')).toThrow(/not a control/)
    expect(() => controlArgs('spotify', 'volume', 101)).toThrow(/0 to 100/)
    expect(() => controlArgs('music', 'uri', 'spotify:track:2Y4rRlanUi7BHYLBDTYELz')).toThrow(/Spotify only/)
    expect(() => controlArgs(null, 'play')).toThrow(/never opens them/)
  })

  it('show takes no value, and never names an app that is not open', () => {
    expect(controlArgs('spotify', 'show')).toEqual(['spotify', 'show'])
    expect(controlArgs('music', 'show', 'Calculator')).toEqual(['music', 'show'])
    expect(() => controlArgs(null, 'show')).toThrow('music: neither Spotify nor Music is open (workshop never opens them for you)')
    expect(SCRIPTS.control.source).toMatch(/if \(!app\.running\(\)\) return[\s\S]*op === 'show'\) app\.activate\(\)/)
  })

  it('show needs a click or key in the tile, one call per input, once a second', () => {
    const last = new Map<string, number>()
    const g = { tile: { manifest: { id: 'spotify' } }, gestureAt: 0 }
    expect(() => allowShow(g, last, 100_000)).toThrow(/click or key/)
    g.gestureAt = 100_000
    expect(() => allowShow(g, last, 106_000)).toThrow(/click or key/)
    allowShow(g, last, 101_000)
    expect(g.gestureAt).toBe(0)
    expect(() => allowShow(g, last, 101_100)).toThrow(/click or key/)
    g.gestureAt = 101_200
    expect(() => allowShow(g, last, 101_300)).toThrow(/one a second/)
    expect(g.gestureAt).toBe(101_200)
    allowShow(g, last, 102_100)
    const other = { tile: { manifest: { id: 'other' } }, gestureAt: 102_100 }
    allowShow(other, last, 102_200)
  })

  it('reads what the control script printed', () => {
    expect(controlError('{"ok":true}', 'spotify')).toBeNull()
    expect(controlError('{"ok":false,"error":"not-running"}', 'music')).toMatch(/Music is not open/)
    expect(controlError(`{"ok":false,"error":${NOT_PERMITTED}}`, 'spotify')).toMatch(/Automation/)
    expect(controlError('{"ok":false,"error":-10000,"message":"no"}', 'spotify')).toMatch(/Spotify refused \(no\)/)
    expect(controlError('oops', 'spotify')).toMatch(/something else/)
  })

  it('never puts anything into a script\'s text: every script is fixed and reads argv', () => {
    // The scripts name no value a tile could send; the control script re-checks its own values.
    expect(SCRIPTS.control.source).toMatch(/function run\(argv\)/)
    expect(SCRIPTS.art.source).toMatch(/on run argv/)
    // Each app is asked whether it runs before anything is sent to it, so none is ever launched.
    expect(SCRIPTS.poll.source).toMatch(/running\(\)[\s\S]*playerState/)
    expect(SCRIPTS.control.source.indexOf('app.running()')).toBeLessThan(SCRIPTS.control.source.indexOf('app.play()'))
    expect(SCRIPTS.art.source.indexOf('is running')).toBeLessThan(SCRIPTS.art.source.indexOf('tell application'))
  })
})

describe('the artwork', () => {
  it('fetches only from Spotify\'s image hosts, over https', () => {
    expect(artUrlAllowed('https://i.scdn.co/image/ab67')).toBe(true)
    expect(artUrlAllowed('https://image-cdn-ak.spotifycdn.com/image/ab67')).toBe(true)
    for (const u of ['http://i.scdn.co/image/x', 'https://evil.com/i.scdn.co', 'https://scdn.co.evil.com/x', 'https://i.scdn.co:444/x', 'https://u:p@i.scdn.co/x', 'file:///etc/hosts', 'not a url'])
      expect(artUrlAllowed(u)).toBe(false)
  })

  it('serves only real pictures, typed from their bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(Buffer.from('GIF89a...'))).toBe('image/gif')
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull()
    expect(sniffImage(Buffer.from('<html>'))).toBeNull()
  })
})

/** A host on a fake runner and a hand-driven clock. */
function harness(reply: (kind: RunKind, args: string[]) => string | Promise<string>) {
  const calls: { kind: RunKind; args: string[] }[] = []
  const timers: { fn: () => void; ms: number; id: number }[] = []
  let clock = 1_000_000
  let nextId = 1
  const changes: HostState[] = []
  const runner: Runner = async (kind, args) => {
    calls.push({ kind, args })
    return reply(kind, args)
  }
  const host = new MusicHost({
    runner,
    fetchArt: async (url) => (url === SPOTIFY_TRACK.art ? { type: 'image/png', body: PNG } : null),
    onChange: (s) => changes.push(s),
    tmpDir: async () => mkdtempSync(join(tmpdir(), 'music-test-')),
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: nextId++ }
      timers.push(t)
      return t.id
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id)
      if (i >= 0) timers.splice(i, 1)
    },
    now: () => clock
  })
  /** Runs the one pending timer (there is never more than one), after moving the clock on. */
  const tick = async (): Promise<number | null> => {
    const t = timers.shift()
    if (!t) return null
    clock += t.ms
    t.fn()
    await new Promise((r) => setTimeout(r, 5))
    return t.ms
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
  return { host, calls, timers, changes, tick, flush, advance: (ms: number) => (clock += ms), polls: () => calls.filter((c) => c.kind === 'poll').length }
}

describe('the host', () => {
  it('polls only while watched, at the pace of what is playing', async () => {
    let state = 'playing'
    const h = harness(() => JSON.stringify({ spotify: { running: true, state, volume: 5, position: 1, track: SPOTIFY_TRACK }, music: { running: false } }))
    expect(h.timers.length).toBe(0)
    h.host.watch(1)
    h.host.watch(2)
    expect(await h.tick()).toBe(0) // the first watcher reads at once
    expect(h.polls()).toBe(1)
    expect(h.timers.map((t) => t.ms)).toEqual([POLL_PLAYING_MS])
    state = 'paused'
    expect(await h.tick()).toBe(POLL_PLAYING_MS)
    expect(h.timers.map((t) => t.ms)).toEqual([POLL_PAUSED_MS])
    h.host.unwatch(1)
    expect(h.timers.length).toBe(1) // one page still watches
    h.host.unwatch(2)
    expect(h.timers.length).toBe(0)
    expect(h.host.watching).toBe(0)
  })

  it('answers get() from a fresh reading, and reads again once it is stale', async () => {
    const h = harness(() => REAL)
    await h.host.get()
    await h.host.get()
    expect(h.polls()).toBe(1)
    h.advance(1000)
    await h.host.get()
    expect(h.polls()).toBe(2)
    // Without a watcher, a get() leaves no timer behind.
    expect(h.timers.length).toBe(0)
  })

  it('reads at most once at a time, however many ask', async () => {
    let release: (s: string) => void = () => {}
    const h = harness(() => new Promise<string>((r) => (release = r)))
    const a = h.host.get()
    const b = h.host.get()
    release(REAL)
    expect(await a).toBe(await b)
    expect(h.polls()).toBe(1)
  })

  it('fetches the artwork once and tells the tiles when it lands', async () => {
    const h = harness(() => REAL)
    const first = await h.host.get()
    expect(first.track?.artKey).toBeNull()
    for (let i = 0; i < 200 && !h.changes.at(-1)?.track?.artKey; i++) await h.flush()
    const key = artKeyOf('spotify', parsePoll(REAL).spotify.track!)
    expect(h.changes.at(-1)?.track?.artKey).toBe(key)
    expect(h.host.artwork(key)?.body.equals(PNG)).toBe(true)
    h.advance(1000)
    expect((await h.host.get()).track?.artKey).toBe(key)
  })

  it('asks Music for its picture through a file in its own folder, and removes the file', async () => {
    let path = ''
    const h = harness(async (kind, args) => {
      if (kind === 'art') {
        path = args[0]
        await writeFile(path, PNG)
        return 'ok'
      }
      return JSON.stringify({ spotify: { running: false }, music: { running: true, state: 'playing', volume: 5, position: 1, track: { title: 'S', artist: 'A', album: 'B', duration: 10, id: 'P1' } } })
    })
    await h.host.get()
    // The file round trip is real disk work: wait for it rather than for a fixed few ticks.
    for (let i = 0; i < 200 && !h.changes.at(-1)?.track?.artKey; i++) await h.flush()
    const key = h.changes.at(-1)?.track?.artKey
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(h.host.artwork(key!)?.type).toBe('image/png')
    expect(path).toMatch(/music-test-.*art-/)
    await expect(import('node:fs/promises').then((f) => f.stat(path))).rejects.toThrow()
  })

  it('runs a control as argv to the app in use, then reads again soon', async () => {
    const h = harness((kind) => (kind === 'poll' ? REAL : '{"ok":true}'))
    h.host.watch(1)
    await h.tick()
    await h.host.control('seek', 30_000)
    expect(h.calls.filter((c) => c.kind === 'control').map((c) => c.args)).toEqual([['spotify', 'seek', '30000']])
    expect(h.timers.map((t) => t.ms)).toEqual([AFTER_CONTROL_MS])
    await expect(h.host.control('volume', 101)).rejects.toThrow(/0 to 100/)
    await expect(h.host.control('rm -rf', 1)).rejects.toThrow(/not a control/)
    expect(h.calls.filter((c) => c.kind === 'control').length).toBe(1)
  })

  it('never opens an app: with neither running a control is refused before any script runs', async () => {
    const h = harness((kind) => (kind === 'poll' ? '{"spotify":{"running":false},"music":{"running":false}}' : '{"ok":true}'))
    await expect(h.host.control('play')).rejects.toThrow(/never opens them/)
    expect(h.calls.map((c) => c.kind)).toEqual(['poll'])
  })

  it('a refusal from macOS is a state, and controls say why without trying', async () => {
    const h = harness((kind) => (kind === 'poll' ? JSON.stringify({ spotify: { running: true, error: NOT_PERMITTED }, music: { running: false } }) : '{"ok":true}'))
    h.host.watch(1)
    await h.tick()
    expect(h.changes.at(-1)).toMatchObject({ player: 'spotify', error: 'denied' })
    expect(h.timers.map((t) => t.ms)).toEqual([POLL_REFUSED_MS])
    await expect(h.host.control('pause')).rejects.toThrow(/Automation/)
    expect(h.calls.some((c) => c.kind === 'control')).toBe(false)
  })

  it('a poll that fails (osascript gone, a timeout) is a state too, and the poll carries on', async () => {
    let fail = true
    const h = harness(() => (fail ? Promise.reject(new Error('timed out')) : REAL))
    h.host.watch(1)
    await h.tick()
    expect(h.changes.at(-1)).toMatchObject({ player: null, error: 'failed', message: expect.stringMatching(/timed out/) })
    fail = false
    expect(await h.tick()).toBe(POLL_IDLE_MS)
    expect(h.changes.at(-1)).toMatchObject({ player: 'spotify', state: 'playing' })
  })

  it('tells the tiles only when something changed', async () => {
    const h = harness(() => REAL)
    h.host.watch(1)
    await h.tick()
    for (let i = 0; i < 200 && !h.changes.at(-1)?.track?.artKey; i++) await h.flush()
    const n = h.changes.length
    await h.tick()
    await h.tick()
    expect(h.changes.length).toBe(n)
  })
})
