// Smoke checks for the screen recorder (main/recorder.ts), called from smoke.ts: the top bar's button
// opens the frame, the frame is painted in the theme and runs on its own partition, a tile still
// cannot capture the screen while it is open, a take is filmed and saved, ⌘⇧O stops it and closes it.
//
// A smoke run never captures the screen and never needs macOS's Screen Recording permission: main
// hands the frame a stub source and the page films a test pattern instead of the display (the crop,
// the canvas, MediaRecorder, the chunks and the file are all real). It records no sound and never
// touches the Mac's audio output, so BlackHole and the sound helper are not exercised here.

import type { BrowserWindow, WebContents } from 'electron'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ASPECT, innerOf } from '@shared/recorder'
import type { Recorder } from './recorder'
import { findInPath, shellEnv } from './env'
import { execFileSync } from 'node:child_process'

type Check = (name: string, ok: boolean, detail?: string) => void

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await Promise.resolve().then(cond).catch(() => false)) return true
    await sleep(100)
  }
  return false
}

export async function recorderSmoke(
  check: Check,
  o: { win: BrowserWindow; recorder?: Recorder; userData: string; liveByTile: Map<string, { wc: WebContents }> }
): Promise<void> {
  const { win, recorder, userData } = o
  if (!recorder) return check('recorder: running', false, 'no recorder in the smoke context')
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const button = (): Promise<{ cls: string; text: string; title: string } | null> =>
    js(`(() => { const b = document.querySelector('.topbar .rec-btn'); return b && { cls: b.className, text: b.textContent, title: b.title } })()`)
  const cmdShiftO = (wc: WebContents): void => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['meta', 'shift'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['meta', 'shift'] })
  }

  const b0 = await button()
  check('recorder: the top bar has the button', !!b0 && b0.text.includes('Record') && b0.title.startsWith('Screen recorder'), JSON.stringify(b0))

  await js(`document.querySelector('.topbar .rec-btn').click(); true`)
  const opened = await waitFor(async () => !!recorder.page() && (await recorder.page()!.executeJavaScript(`!!document.querySelector('.rec-bar .rec-go') && !document.querySelector('.rec-go').disabled`)) === true)
  check('recorder: the button opens the frame', opened && recorder.isOpen())
  if (!opened) return
  const page = recorder.page()!
  const pjs = (code: string): Promise<any> => page.executeJavaScript(code)
  check('recorder: the button shows the frame is open', await waitFor(async () => (await button())?.cls.includes('is-open') ?? false), JSON.stringify(await button()))

  const inner = innerOf(recorder.bounds()!)
  check('recorder: the filmed rectangle is 9:16', Math.abs(inner.width - Math.round(inner.height * ASPECT)) <= 1, JSON.stringify(inner))
  const accent = String(await pjs(`getComputedStyle(document.documentElement).getPropertyValue('--ws-accent').trim()`))
  check('recorder: the frame is painted in the theme', accent.startsWith('#'), accent)
  check("recorder: the frame's page has no core API and no node", (await pjs(`typeof window.core === 'undefined' && typeof require === 'undefined' && typeof window.rec === 'object'`)) === true)
  const tileSessions = [...o.liveByTile.values()].map((g) => g.wc.session)
  check('recorder: the frame runs on its own partition', page.session !== win.webContents.session && !tileSessions.includes(page.session))
  check("recorder: the frame's partition loads nothing from the network", (await pjs(`fetch('https://example.com/').then(() => false, () => true)`)) === true)

  // A tile is still refused the screen while the recorder is open (main/tiles.ts holds, untouched).
  const probe = o.liveByTile.get('probe')?.wc
  if (probe) {
    const held = (await probe.executeJavaScript(`(async () => {
      const fails = async (p) => { try { await p; return false } catch { return true } }
      return [
        await fails(navigator.mediaDevices.getDisplayMedia({ video: true })),
        await fails(navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop' } } })),
        await fails(navigator.mediaDevices.getUserMedia({ audio: true }))
      ]
    })()`)) as boolean[]
    check('recorder: a tile still cannot capture the screen or sound while it is open', held.every(Boolean), JSON.stringify(held))
  }

  // A switch is remembered in core's settings.
  await pjs(`document.querySelectorAll('.rec-bar .rec-tog')[2].click(); true`)
  const kept = await waitFor(async () => JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).recorder?.guides === false)
  check('recorder: a switch is kept in core settings', kept)
  await pjs(`document.querySelectorAll('.rec-bar .rec-tog')[2].click(); true`)

  // A take: 3, 2, 1, film the test pattern, then ⌘⇧O from core's window stops and saves it.
  await pjs(`document.querySelector('.rec-go').click(); true`)
  const rolling = await waitFor(() => recorder.getState().phase === 'recording', 8000)
  const note = String(await pjs(`document.querySelector('.rec-note')?.textContent ?? ''`))
  check('recorder: a take starts after the countdown', rolling, `${recorder.getState().phase} ${note}`)
  if (!rolling) return
  await sleep(1600)
  const live = await button()
  check('recorder: the button is red with the time while recording', !!live && live.cls.includes('is-live') && /^\d+:\d\d$/.test(live.text.trim()), JSON.stringify(live))
  cmdShiftO(win.webContents)
  const saved = await waitFor(() => recorder.getState().phase === 'saved', 60_000)
  check('recorder: ⌘⇧O stops and saves the take', saved, `${recorder.getState().phase} ${await pjs(`document.querySelector('.rec-note')?.textContent ?? ''`)}`)
  if (saved) {
    const dir = join(userData, 'recordings')
    const files = await readdir(dir).catch(() => [] as string[])
    const f = files.find((n) => /^workshop \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.(mp4|webm)$/.test(n))
    const size = f ? (await stat(join(dir, f))).size : 0
    check('recorder: the take is saved, named by the time', !!f && size > 1000 && recorder.lastSaved === join(dir, f), `${JSON.stringify(files)} ${size} bytes`)
    // With ffmpeg on the PATH the take was made into what Instagram wants: say what ffprobe reads.
    const ffprobe = findInPath(shellEnv().PATH, 'ffprobe')
    if (f && ffprobe) {
      let got = ''
      try {
        got = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'csv=p=0', join(dir, f)], { encoding: 'utf8', timeout: 20_000 }).trim()
      } catch (e) {
        got = (e as Error).message
      }
      check('recorder: the saved take is 1080×1920 H.264 (ffprobe)', got === 'h264,1080,1920,yuv420p', got)
    }
    check('recorder: the button is back to rest after the take', !((await button())?.cls.includes('is-live') ?? true))
  }

  check('recorder: the bar has no Column / Brand switch', (await pjs(`!document.querySelector('.rec-fit')`)) === true)
  check('recorder: after a take, close and the resize grip are still in the bar', (await pjs(`(() => { const bar = document.querySelector('.rec-bar').getBoundingClientRect(); return ['.rec-close', '.rec-grip'].every((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return !!r && r.right <= bar.right + 0.5 }) })()`)) === true)

  // ⌘⇧O again, with nothing filming, closes the frame.
  cmdShiftO(win.webContents)
  const closed = await waitFor(() => !recorder.isOpen())
  check('recorder: ⌘⇧O closes the frame', closed)
  check('recorder: the button shows it closed', await waitFor(async () => !((await button())?.cls.includes('is-open') ?? true)), JSON.stringify(await button()))
}
