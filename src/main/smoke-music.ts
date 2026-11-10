// The smoke run's part for `workshop.music`. A smoke run never touches Spotify or Music: index.ts
// hands the music host this file's stand-in for osascript (smokeMusicIo), which answers the poll
// with a made-up Spotify, records every control it is asked to run, and hands back a tiny PNG as
// the artwork. test/fixtures/music is loaded as a dev tile and driven from inside its page.

import type { WebContents } from 'electron'
import { resolve } from 'node:path'
import { app } from 'electron'
import type { ArtFetcher, MusicHost, RunKind, Runner } from './music'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Ctx {
  liveByTile: Map<string, { wc: WebContents }>
  addDevTile: (folder: string) => Promise<string>
  music?: MusicHost
}

const ART_URL = 'https://i.scdn.co/image/smoke'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const TRACK_ID = `spotify:track:${'4uLU6hMCjMI75M1A2tKUQC'}`

/** The stand-in's state, which the checks below change and read. */
const fake = {
  mode: 'playing' as 'playing' | 'paused' | 'denied' | 'none',
  volume: 40,
  calls: [] as { kind: RunKind; args: string[] }[]
}

const reading = (): unknown => {
  if (fake.mode === 'none') return { spotify: { running: false }, music: { running: false } }
  if (fake.mode === 'denied') return { spotify: { running: true, error: -1743, message: 'Not authorized to send Apple events to Spotify.' }, music: { running: false } }
  return {
    spotify: {
      running: true,
      state: fake.mode,
      volume: fake.volume,
      shuffle: false,
      repeat: 'off',
      position: 61.5,
      track: { title: 'Smoke on the Water', artist: 'Deep Purple', album: 'Machine Head', duration: 340_000, id: TRACK_ID, art: ART_URL }
    },
    music: { running: false }
  }
}

const runner: Runner = async (kind, args) => {
  fake.calls.push({ kind, args: [...args] })
  if (kind === 'poll') return JSON.stringify(reading())
  if (kind === 'control') {
    if (fake.mode === 'denied') return JSON.stringify({ ok: false, error: -1743 })
    if (fake.mode === 'none') return JSON.stringify({ ok: false, error: 'not-running' })
    const [, op, arg] = args
    if (op === 'pause') fake.mode = 'paused'
    else if (op === 'play') fake.mode = 'playing'
    else if (op === 'toggle') fake.mode = fake.mode === 'playing' ? 'paused' : 'playing'
    else if (op === 'volume') fake.volume = Number(arg)
    return JSON.stringify({ ok: true })
  }
  return 'none'
}
const fetchArt: ArtFetcher = async (url) => (url === ART_URL ? { type: 'image/png', body: PNG } : null)

export const smokeMusicIo = { runner, fetchArt }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export async function musicSmoke(check: Check, { liveByTile, addDevTile, music }: Ctx): Promise<void> {
  if (!music) throw new Error('no music host in the smoke context')
  await addDevTile(resolve(app.getAppPath(), 'test/fixtures/music'))
  await waitFor('the music tile to load', async () => (await liveByTile.get('music-probe')?.wc.executeJavaScript('window.musicReady === true').catch(() => false)) === true)
  const page = liveByTile.get('music-probe')!.wc
  const inPage = (code: string): Promise<any> => page.executeJavaScript(code)
  /** A call from the page: { ok, result } or { ok: false, error }. */
  const call = (expr: string): Promise<any> => inPage(`(async () => { try { return { ok: true, result: await ${expr} } } catch (e) { return { ok: false, error: e.message } } })()`)
  const controls = (): string[] => fake.calls.filter((c) => c.kind === 'control').map((c) => c.args.join(' '))
  const polls = (): number => fake.calls.filter((c) => c.kind === 'poll').length

  const probeHas = await liveByTile.get('probe')?.wc.executeJavaScript('"music" in window.workshop')
  check('music: a tile without the permission has no workshop.music', probeHas === false, String(probeHas))

  // The first reading starts the artwork's fetch; a later one carries its URL on the tile's origin.
  let s: any = null
  await waitFor('the artwork to arrive', async () => {
    s = (await call('workshop.music.get()')).result
    return !!s?.track?.art
  }).catch(() => undefined)
  check('music: get() reads the app in use, through core', s?.player === 'spotify' && s.state === 'playing' && s.track?.title === 'Smoke on the Water' && s.track.durationMs === 340_000 && s.positionMs === 61_500 && s.volume === 40, JSON.stringify(s))
  check('music: the artwork is a URL on the tile\'s own origin, never the remote one', /^tile:\/\/music-probe\/~music\/art\/[0-9a-f]{32}$/.test(s?.track?.art ?? '') && !JSON.stringify(s).includes('scdn'), s?.track?.art)
  const art = await inPage(`fetch(${JSON.stringify(s?.track?.art ?? '')}).then(async (r) => ({ ok: r.ok, type: r.headers.get('content-type'), n: (await r.arrayBuffer()).byteLength }), (e) => ({ ok: false, error: e.message }))`)
  check('music: the page loads the artwork from its own origin (no net)', art.ok && art.type === 'image/png' && art.n === PNG.length, JSON.stringify(art))
  const key = String(s?.track?.art ?? '').split('/').pop()
  const probeArt = await liveByTile.get('probe')!.wc.executeJavaScript(`fetch('tile://probe/~music/art/${key}').then((r) => r.status, () => 'refused')`)
  check('music: a tile without the permission gets no artwork on its origin', probeArt === 404, String(probeArt))

  // Watching: polls run while a page watches, and the page hears a change a control made.
  const before = polls()
  await inPage(`window.seen = []; window.stopMusic = workshop.music.watch((s) => window.seen.push(s)); true`)
  await sleep(2500)
  check('music: watching polls about once a second while playing', music.watching === 1 && polls() - before >= 2 && polls() - before <= 4, `${music.watching} watching, ${polls() - before} polls`)
  check('music: a new watcher hears the state at once', (await inPage('window.seen.length')) >= 1)
  const paused = await call('workshop.music.pause()')
  await waitFor('the page to hear it paused', async () => (await inPage(`window.seen.some((s) => s.state === 'paused')`)) === true, 5000).catch(() => undefined)
  check('music: pause() reaches the app, and the watcher hears it', paused.ok && controls().at(-1) === 'spotify pause' && (await inPage(`window.seen.at(-1).state`)) === 'paused', `${JSON.stringify(paused)} ${controls().join(', ')}`)
  await call('workshop.music.play()')

  // Values: checked in the page, and again in main, which is what counts. A refused call never reaches the runner.
  const n = controls().length
  const seek = await call('workshop.music.seek(61000)')
  const vol = await call('workshop.music.setVolume(65)')
  const uri = await call(`workshop.music.playUri('spotify:track:4uLU6hMCjMI75M1A2tKUQC')`)
  check('music: seek, volume and a Spotify URI reach the runner as checked arguments', seek.ok && vol.ok && uri.ok && controls().slice(n).join(', ') === 'spotify seek 61000, spotify volume 65, spotify uri spotify:track:4uLU6hMCjMI75M1A2tKUQC', controls().slice(n).join(', '))
  const m = controls().length
  const bad = await Promise.all([
    call('workshop.music.setVolume(150)'),
    call('workshop.music.seek(-1)'),
    call('workshop.music.seek(1.5)'),
    call(`workshop.music.playUri('spotify:track:x" & do shell script "touch /tmp/pwned')`),
    call(`workshop.music.playUri('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')`)
  ])
  check('music: bad values are refused in the page', bad.every((b) => !b.ok), JSON.stringify(bad))
  const inMain = await Promise.all([
    music.control('volume', 150).then(() => 'ran', (e: Error) => e.message),
    music.control('uri', 'spotify:track:x"; do shell script "id"').then(() => 'ran', (e: Error) => e.message),
    music.control('quit').then(() => 'ran', (e: Error) => e.message),
    music.control('seek', '100').then(() => 'ran', (e: Error) => e.message)
  ])
  check('music: main refuses them too, before the runner hears of it', inMain.every((x) => x !== 'ran') && controls().length === m, `${JSON.stringify(inMain)} ${controls().slice(m).join(', ')}`)

  // Refused by macOS: a state the tile can show, and controls that say why. Nothing falls over.
  fake.mode = 'denied'
  await sleep(900)
  const denied = (await call('workshop.music.get()')).result
  const play = await call('workshop.music.play()')
  check('music: a denied Automation prompt is a state the tile can show', denied?.error === 'denied' && /Automation/.test(denied.message) && denied.track === null, JSON.stringify(denied))
  check('music: a control while denied says why', !play.ok && /Automation/.test(play.error), JSON.stringify(play))
  fake.mode = 'none'
  await sleep(900)
  const none = (await call('workshop.music.get()')).result
  const noneNext = await call('workshop.music.next()')
  check('music: neither app open is player null, and a control does not open one', none?.player === null && !noneNext.ok && /never opens/.test(noneNext.error) && !controls().some((c) => c.endsWith('next')), `${JSON.stringify(none)} ${JSON.stringify(noneNext)}`)
  fake.mode = 'playing'

  // The last watcher stops: no more polls.
  await inPage('window.stopMusic(); true')
  await sleep(300)
  const after = polls()
  await sleep(2500)
  check('music: no watcher, no polling', music.watching === 0 && polls() === after, `${music.watching} watching, ${polls() - after} polls after`)
}
