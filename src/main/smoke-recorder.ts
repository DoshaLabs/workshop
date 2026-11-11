// Smoke checks for the screen recorder (main/recorder.ts), called from smoke.ts: the top bar's button
// opens the frame, the frame is painted in the theme and runs on its own partition, a tile still
// cannot capture the screen while it is open, a take is filmed and saved, ⌘⇧O stops it and closes it.
//
// A smoke run never captures the screen and never needs macOS's Screen Recording permission: main
// hands the frame a stub source and the page films a test pattern instead of the display (the crop,
// the canvas, MediaRecorder, the chunks and the file are all real). It records no sound and never
// touches the Mac's audio output, so BlackHole and the sound helper are not exercised here.

import type { BrowserWindow, WebContents } from 'electron'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ASPECT, innerOf, outSize } from '@shared/recorder'
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

  // The center column: the frame sits on it exactly, its bar above, follows core's window, and the
  // take is the column at its own size.
  const center = async () => {
    const r = (await js(`(() => { const r = document.querySelector('.col.center').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)) as { x: number; y: number; width: number; height: number }
    const c = win.getContentBounds()
    return { x: Math.round(c.x + r.x), y: Math.round(c.y + r.y), width: Math.round(r.width), height: Math.round(r.height) }
  }
  const onColumn = async () => {
    const want = await center()
    const got = innerOf(recorder.bounds()!, 'center')
    return Math.abs(got.x - want.x) <= 1 && Math.abs(got.y - want.y) <= 1 && Math.abs(got.width - want.width) <= 1 && Math.abs(got.height - want.height) <= 1
  }
  await pjs(`document.querySelectorAll('.rec-fit button')[1].click(); true`)
  const snapped = await waitFor(onColumn)
  check('recorder: Column puts the frame on the center column, its bar above it', snapped, JSON.stringify({ frame: innerOf(recorder.bounds()!, 'center'), column: await center() }))
  check('recorder: Column is kept in core settings, and hides the 9:16 grip', (await waitFor(async () => JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).recorder?.fit === 'center')) && (await pjs(`!document.querySelector('.rec-grip') && document.querySelector('.rec').classList.contains('fit-center')`)) === true)
  const before = win.getBounds()
  win.setBounds({ ...before, x: before.x + 40, width: before.width - 60 })
  check('recorder: the column frame follows the window', await waitFor(onColumn), JSON.stringify({ frame: innerOf(recorder.bounds()!, 'center'), column: await center() }))
  win.setBounds(before)
  await waitFor(onColumn)
  await pjs(`document.querySelector('.rec-go').click(); true`)
  if (await waitFor(() => recorder.getState().phase === 'recording', 8000)) {
    await sleep(1200)
    cmdShiftO(win.webContents)
    const ok = await waitFor(() => recorder.getState().phase === 'saved', 60_000)
    const ffprobe = findInPath(shellEnv().PATH, 'ffprobe')
    if (ok && ffprobe && recorder.lastSaved.endsWith('.mp4')) {
      const display = (await import('electron')).screen.getDisplayMatching(recorder.bounds()!)
      const want = outSize('center', innerOf(recorder.bounds()!, 'center'), display.scaleFactor)
      let got = ''
      try {
        got = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', recorder.lastSaved], { encoding: 'utf8', timeout: 20_000 }).trim()
      } catch (e) {
        got = (e as Error).message
      }
      check('recorder: a Column take is the column at its own size (ffprobe)', got === `h264,${want.w},${want.h}`, `${got} want ${want.w}x${want.h}`)
    } else check('recorder: a Column take is saved', ok, recorder.getState().phase)
  } else check('recorder: a Column take starts', false, recorder.getState().phase)
  // The brand clip: made, not filmed. Its canvas is the preview in the frame and what a take records.
  await pjs(`document.querySelectorAll('.rec-fit button')[2].click(); true`)
  const shown = await waitFor(async () => (await pjs(`(() => { const c = document.querySelector('.rec-inner .rec-brand canvas'); return !!c && c.width === 1080 && c.height === 1920 })()`)) === true)
  check('recorder: Brand shows the brand clip in the frame, 1080 × 1920', shown)
  check('recorder: Brand keeps the 9:16 frame (off the column)', await waitFor(() => {
    const i = innerOf(recorder.bounds()!)
    return Math.abs(i.width - Math.round(i.height * ASPECT)) <= 1
  }), JSON.stringify(recorder.bounds()))
  // Drawn, not blank: the sky's dark, the Knot's and the word's light, and it moves.
  const look = (await pjs(`(() => {
    const c = document.querySelector('.rec-brand canvas'), g = c.getContext('2d')
    const lum = (x, y, w, h) => { const d = g.getImageData(x, y, w, h).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3 }
    return { corner: lum(0, 0, 120, 120), middle: lum(240, 560, 600, 800), url: c.toDataURL('image/png') }
  })()`)) as { corner: number; middle: number; url: string }
  check('recorder: the brand clip is drawn: a dark sky, the mark and the word lit in the middle', look.corner < 60 && look.middle > look.corner + 8, JSON.stringify({ corner: look.corner, middle: look.middle }))
  if (process.env.WORKSHOP_SHOT_BRAND) {
    // Three frames a second apart (…-1.png, -2, -3): the stars should be seen moving between them.
    for (let i = 1; i <= 3; i++) {
      const url = i === 1 ? look.url : ((await pjs(`document.querySelector('.rec-brand canvas').toDataURL('image/png')`)) as string)
      await writeFile(process.env.WORKSHOP_SHOT_BRAND.replace(/\.png$/, `-${i}.png`), Buffer.from(url.split(',')[1], 'base64'))
      await sleep(1000)
    }
  }
  await pjs(`document.querySelector('.rec-go').click(); true`)
  if (await waitFor(() => recorder.getState().phase === 'recording', 8000)) {
    await sleep(1500)
    cmdShiftO(win.webContents)
    const ok = await waitFor(() => recorder.getState().phase === 'saved', 60_000)
    const ffprobe = findInPath(shellEnv().PATH, 'ffprobe')
    if (ok && ffprobe && recorder.lastSaved.endsWith('.mp4')) {
      let got = ''
      try {
        got = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', recorder.lastSaved], { encoding: 'utf8', timeout: 20_000 }).trim()
      } catch (e) {
        got = (e as Error).message
      }
      check('recorder: a Brand take is the clip at 1080×1920 (ffprobe)', got === 'h264,1080,1920', got)
    } else check('recorder: a Brand take is saved', ok, recorder.getState().phase)
  } else check('recorder: a Brand take starts', false, recorder.getState().phase)

  await pjs(`document.querySelectorAll('.rec-fit button')[0].click(); true`)
  const back = await waitFor(() => {
    const i = innerOf(recorder.bounds()!)
    return Math.abs(i.width - Math.round(i.height * ASPECT)) <= 1
  })
  check('recorder: 9:16 brings the reel frame back', back, JSON.stringify(recorder.bounds()))
  check('recorder: off Brand, the clip stops and leaves the frame', (await pjs(`!document.querySelector('.rec-brand')`)) === true)

  // ⌘⇧O again, with nothing filming, closes the frame.
  cmdShiftO(win.webContents)
  const closed = await waitFor(() => !recorder.isOpen())
  check('recorder: ⌘⇧O closes the frame', closed)
  check('recorder: the button shows it closed', await waitFor(async () => !((await button())?.cls.includes('is-open') ?? true)), JSON.stringify(await button()))
}
