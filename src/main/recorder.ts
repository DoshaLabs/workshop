// THE SCREEN RECORDER: films a 9:16 piece of the screen for Reels and Stories (1080×1920). Carried
// over from deck (its main/recorder.ts), reviewed; docs/progress/2026-11-10-recorder.md says what
// changed on the way.
//
// The FRAME is a window of its own (transparent, frameless, always on top, on every Space): a
// border you drag anywhere, a corner handle that resizes it at 9:16 and a toolbar under it. Its
// inside is click-through (the page asks for `setIgnoreMouseEvents` as the pointer crosses it), so
// whatever is under it is used as usual while it films. The page does the capture itself: the
// whole display as a desktop getUserMedia stream, cropped every frame to where the inside is NOW
// (dragging it while recording pans the shot), drawn into a 1080×1920 canvas and recorded with
// MediaRecorder. The border and toolbar are outside the crop, and the window asks macOS to keep it
// out of captures (`setContentProtection`).
//
// SOUND is the Mac's own output, through BlackHole 2ch (which the user installs; workshop does not
// ship it): `recaudio route` (native/recaudio.swift, compiled into <profile>/recorder the first
// time) makes the output "<current> + Record", so you still hear everything and BlackHole gets a
// copy the page records as an input; `recaudio restore` puts the output back. The microphone can be
// mixed in.
//
// Chunks stream to <profile>/recorder/take.<ext>; at the stop ffmpeg (if the user has it) makes what
// Instagram wants (H.264 High, yuv420p, constant 30 fps, AAC 48 kHz, faststart) in ~/Movies/workshop.
// Without ffmpeg the raw take is moved there as it is.
//
// It is CORE, never a tile's: tiles are barred from screen capture (main/tiles.ts). The frame's page
// runs on its own in-memory partition, so the permission handlers set here touch no other page,
// and every channel answers only that one page.

import { BrowserWindow, Notification, app, desktopCapturer, ipcMain, screen, session, shell, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { CH } from '@shared/ipc'
import { REC, centerWindow, cleanPrefs, firstFrame, int, isPhase, resized, takeName, type Rect, type RecFit, type RecHello, type RecPrefs, type RecSource, type RecState } from '@shared/recorder'
import { isRecorderKey } from '@shared/shortcuts'
import { findInPath } from './env'

const run = promisify(execFile)

/** The frame page's partition: in memory, its own, so nothing granted here reaches core's window or a tile. */
export const REC_PARTITION = 'workshop-recorder'

export interface RecorderDeps {
  userData: string
  /** native/recaudio.swift. */
  audioSource: string
  env: () => NodeJS.ProcessEnv
  page: { url?: string; file: string }
  preload: string
  /** Core's window: the frame opens over its display, and the top bar hears the state. */
  core: () => BrowserWindow | null
  /** The center column on the screen (points), for the `center` fit; null if it cannot be seen. */
  centerRect: () => Promise<Rect | null>
  hello: () => { vars: Record<string, string>; prefs: RecPrefs }
  savePrefs: (p: RecPrefs) => Promise<void>
  /** Where takes land. */
  outDir: string
  /**
   * A smoke run: the frame stays hidden, films a test pattern instead of the screen, records no
   * sound, never touches the Mac's audio output, and shows no notification.
   */
  smoke: boolean
}

export class Recorder {
  private win: BrowserWindow | null = null
  private readonly dir: string
  private audioJob: Promise<string> | null = null
  private audioBin: string | null = null
  private restoreTo: string | null = null
  private take: { stream: WriteStream; path: string } | null = null
  private state: RecState = { open: false, phase: 'idle', since: 0 }
  /** The last file saved (smoke reads it). */
  lastSaved = ''
  /** Stops following core's window (the `center` fit), while the frame is open. */
  private unfollow: (() => void) | null = null

  constructor(private readonly deps: RecorderDeps) {
    this.dir = join(deps.userData, 'recorder')
    this.armSession()
    this.register()
  }

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  getState(): RecState {
    return { ...this.state }
  }

  /** The frame window's bounds, for smoke. */
  bounds(): Electron.Rectangle | null {
    return this.isOpen() ? this.win!.getBounds() : null
  }

  /** The frame's page, for smoke. */
  page(): Electron.WebContents | null {
    return this.isOpen() ? this.win!.webContents : null
  }

  private setState(s: Partial<RecState>): void {
    const next = { ...this.state, ...s }
    if (next.phase === 'recording' && this.state.phase !== 'recording') next.since = Date.now()
    if (next.phase !== 'recording') next.since = 0
    this.state = next
    this.deps.core()?.webContents.send(CH.recState, this.getState())
  }

  /** The top bar's button and ⌘⇧O: open the frame; while it is up, stop the take or close it. */
  toggle(): void {
    if (this.isOpen()) this.win!.webContents.send(REC.closeAsked)
    else this.open()
  }

  open(): void {
    if (this.isOpen()) return void (this.deps.smoke ? undefined : this.win!.show())
    const core = this.deps.core()
    const area = (core && !core.isDestroyed() ? screen.getDisplayMatching(core.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea
    const win = new BrowserWindow({
      ...firstFrame(area),
      show: !this.deps.smoke,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false, // the corner handle resizes, keeping 9:16
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: 'Recorder',
      webPreferences: {
        preload: this.deps.preload,
        partition: REC_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false // it films while another window has the focus
      }
    })
    win.setAlwaysOnTop(true, 'floating')
    // skipTransformProcessType: without it Electron calls app.dock.hide() so the frame can float
    // over other apps' full-screen Spaces, which makes all of workshop a background app (no Dock
    // icon, no menu bar, out of ⌘Tab, its window buried) until the frame closes.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.setContentProtection(true)
    win.setIgnoreMouseEvents(true, { forward: true })
    // ⌘⇧O with the frame focused (after a click on its bar) stops the take or closes it, as anywhere else.
    win.webContents.on('before-input-event', (ev, input) => {
      if (!isRecorderKey(input)) return
      ev.preventDefault()
      this.toggle()
    })
    // The frame never leaves its page and opens nothing.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const devOrigin = this.deps.page.url ? new URL(this.deps.page.url).origin : null
    win.webContents.on('will-navigate', (e, url) => {
      if (devOrigin && URL.canParse(url) && new URL(url).origin === devOrigin) return
      e.preventDefault()
    })
    win.on('closed', () => {
      this.unfollow?.()
      this.unfollow = null
      this.win = null
      this.endTake()
      void this.restoreAudio()
      this.setState({ open: false, phase: 'idle' })
    })
    if (this.deps.page.url) void win.loadURL(this.deps.page.url)
    else void win.loadFile(this.deps.page.file)
    this.win = win
    this.setState({ open: true, phase: 'idle' })
    // The center fit follows core's window: moved, resized, a column dragged wider by the layout.
    if (core && !core.isDestroyed()) {
      const follow = () => void this.place()
      for (const ev of ['move', 'resize', 'enter-full-screen', 'leave-full-screen'] as const) core.on(ev as 'move', follow)
      this.unfollow = () => {
        for (const ev of ['move', 'resize', 'enter-full-screen', 'leave-full-screen'] as const) core.off(ev as 'move', follow)
      }
    }
    void this.place()
  }

  private fit(): RecFit {
    return this.deps.hello().prefs.fit ?? 'reel'
  }

  /**
   * The `center` fit: the frame over the center column exactly, its bar above it. Nothing to do for
   * a reel (the user placed it). A center that cannot be measured (core minimized) leaves it be.
   */
  private async place(): Promise<void> {
    if (!this.isOpen() || this.fit() !== 'center') return
    const r = await this.deps.centerRect()
    if (r && this.isOpen() && this.fit() === 'center') this.win!.setBounds(centerWindow(r))
  }

  close(): void {
    if (this.isOpen()) this.win!.close()
  }

  /**
   * The frame's partition grants media (the desktop stream, BlackHole, the microphone) to the
   * frame's own page and to nothing else, and loads nothing from the network. Tiles' partitions
   * are armed in main/tiles.ts and core's window keeps Electron's defaults; neither is touched here.
   */
  private armSession(): void {
    const ses = session.fromPartition(REC_PARTITION)
    const isFrame = (wc: Electron.WebContents | null | undefined): boolean => !!wc && this.isOpen() && wc === this.win!.webContents
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' && isFrame(wc)))
    ses.setPermissionCheckHandler((wc, perm) => perm === 'media' && isFrame(wc))
    ses.setDevicePermissionHandler(() => false)
    // The frame asks for the screen by a source id main hands it, never through the picker.
    ses.setDisplayMediaRequestHandler((_req, cb) => cb({}))
    const devOrigin = this.deps.page.url ? new URL(this.deps.page.url).origin : null
    ses.webRequest.onBeforeRequest((d, cb) => {
      const ok = /^(file|data|blob|devtools|chrome-extension):/.test(d.url) || (!!devOrigin && URL.canParse(d.url) && [devOrigin, devOrigin.replace(/^http/, 'ws')].includes(new URL(d.url).origin))
      cb({ cancel: !ok })
    })
    ses.on('will-download', (e) => e.preventDefault())
  }

  // ---- sound -------------------------------------------------------------------------

  private compileAudio(): Promise<string> {
    if (this.audioJob) return this.audioJob
    this.audioJob = (async () => {
      const src = readFileSync(this.deps.audioSource, 'utf8')
      const bin = join(this.dir, `recaudio-${createHash('sha1').update(src).digest('hex').slice(0, 12)}`)
      this.audioBin = bin
      if (existsSync(bin)) return bin
      mkdirSync(this.dir, { recursive: true })
      const copy = join(this.dir, 'recaudio.swift')
      writeFileSync(copy, src)
      try {
        await run('/usr/bin/swiftc', ['-O', copy, '-o', bin], { timeout: 180_000 })
      } catch (err) {
        throw new Error(`the recorder's sound helper did not compile (xcode-select --install): ${(err as Error).message}`)
      }
      return bin
    })().catch((err) => {
      this.audioJob = null
      throw err
    })
    return this.audioJob
  }

  private async audio(args: string[]): Promise<{ previous?: string; device?: string; error?: string }> {
    const bin = await this.compileAudio()
    try {
      const { stdout } = await run(bin, args, { timeout: 15_000 })
      return JSON.parse(stdout)
    } catch (err) {
      try {
        return JSON.parse((err as { stdout?: string }).stdout ?? '')
      } catch {
        return { error: (err as Error).message }
      }
    }
  }

  /** The Mac's output copied into BlackHole for the take. Resolves an error, or '' when it is routed. */
  private async routeAudio(): Promise<string> {
    const r = await this.audio(['route']).catch((e: Error) => ({ error: e.message }) as { error: string; previous?: string; device?: string })
    if (r.error) return r.error
    // Put back only what we changed: an output that was already a "+ Record" device stays.
    if (r.previous && r.previous !== r.device && !this.restoreTo) this.restoreTo = r.previous
    return ''
  }

  private async restoreAudio(): Promise<void> {
    const to = this.restoreTo
    this.restoreTo = null
    if (to) await this.audio(['restore', to]).catch(() => {})
  }

  // ---- the take ----------------------------------------------------------------------

  private endTake(): void {
    if (!this.take) return
    this.take.stream.end()
    rmSync(this.take.path, { force: true })
    this.take = null
  }

  private outDir(): string {
    mkdirSync(this.deps.outDir, { recursive: true })
    return this.deps.outDir
  }

  /** A path the page may ask to reveal or play: a file in the takes folder, nothing else. */
  private ours(p: unknown): string | null {
    const full = resolve(String(p ?? ''))
    return full.startsWith(resolve(this.deps.outDir) + sep) && existsSync(full) ? full : null
  }

  private async finish(ext: string): Promise<string> {
    const take = this.take
    if (!take) throw new Error('nothing was recording')
    this.take = null
    await new Promise<void>((done) => take.stream.end(done))
    const dir = this.outDir()
    const now = new Date()
    const ffmpeg = findInPath(this.deps.env().PATH, 'ffmpeg')
    if (!ffmpeg) {
      const raw = join(dir, takeName(now, ext, (n) => existsSync(join(dir, n))))
      renameSync(take.path, raw)
      return raw
    }
    const out = join(dir, takeName(now, 'mp4', (n) => existsSync(join(dir, n))))
    await run(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', take.path,
        // A reel is Instagram's 1080 × 1920; the center column keeps its own size (the page made it even).
        '-vf', `${this.fit() === 'center' ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2' : 'scale=1080:1920'}:flags=lanczos,fps=30,format=yuv420p`,
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2', '-preset', 'medium', '-crf', '17', '-maxrate', '25M', '-bufsize', '50M',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', out],
      { timeout: 30 * 60_000, env: this.deps.env() }
    )
    rmSync(take.path, { force: true })
    return out
  }

  private register(): void {
    const mine = (e: IpcMainInvokeEvent | IpcMainEvent): boolean => this.isOpen() && e.sender === this.win!.webContents && e.senderFrame === this.win!.webContents.mainFrame
    const coreOnly = (e: IpcMainInvokeEvent): void => {
      if (e.sender !== this.deps.core()?.webContents) throw new Error('core only')
    }
    // Core's window: the top bar's button.
    ipcMain.handle(CH.recToggle, (e) => (coreOnly(e), this.toggle()))
    ipcMain.handle(CH.recStateGet, (e) => (coreOnly(e), this.getState()))

    // The frame's page.
    ipcMain.handle(REC.hello, (e): RecHello => {
      if (!mine(e)) throw new Error('not the recorder')
      return this.deps.hello()
    })
    ipcMain.handle(REC.setPrefs, async (e, p: unknown) => {
      if (!mine(e)) throw new Error('not the recorder')
      const was = this.fit()
      const next = cleanPrefs(p, this.deps.hello().prefs)
      // The fit is not changed under a take: the page disables the switch, and main holds to it too.
      if (this.state.phase !== 'idle' && this.state.phase !== 'saved' && this.state.phase !== 'error') next.fit = was
      await this.deps.savePrefs(next)
      if (next.fit === was) return
      // Back to a reel: the 9:16 frame where it first opens. To the center: over the column.
      if (next.fit === 'reel') {
        const core = this.deps.core()
        const area = (core && !core.isDestroyed() ? screen.getDisplayMatching(core.getBounds()) : screen.getDisplayMatching(this.win!.getBounds())).workArea
        this.win!.setBounds(firstFrame(area))
      } else await this.place()
    })
    ipcMain.on(REC.phase, (e, phase: unknown) => {
      if (mine(e) && isPhase(phase)) this.setState({ phase })
    })
    // The pointer crossed into or out of the frame's inside.
    ipcMain.on(REC.passThrough, (e, through: unknown) => {
      if (mine(e)) this.win!.setIgnoreMouseEvents(!!through, { forward: true })
    })
    // The border or the bar dragged: the window's new top-left corner.
    ipcMain.on(REC.move, (e, x: unknown, y: unknown) => {
      // The center fit is where the column is, not where it is dragged.
      if (mine(e) && this.fit() === 'reel' && Number.isFinite(x) && Number.isFinite(y)) this.win!.setPosition(int(x as number), int(y as number))
    })
    // The corner handle: the filmed rectangle's new height, the top-left corner staying put.
    ipcMain.on(REC.resize, (e, height: unknown) => {
      if (!mine(e) || this.fit() !== 'reel') return
      const b = this.win!.getBounds()
      this.win!.setBounds(resized(b, Number(height), screen.getDisplayMatching(b).workArea))
    })
    ipcMain.on(REC.close, (e) => {
      if (mine(e)) this.close()
    })
    // What to film: the display under the frame's middle, as a desktop capture source.
    ipcMain.handle(REC.source, async (e): Promise<RecSource> => {
      if (!mine(e)) throw new Error('not the recorder')
      const b = this.win!.getBounds()
      const display = screen.getDisplayNearestPoint({ x: int(b.x + b.width / 2), y: int(b.y + b.height / 2) })
      if (this.deps.smoke) return { id: 'stub', bounds: display.bounds, scale: display.scaleFactor, stub: true }
      // Without the Screen Recording permission the page's capture fails as a bare "Permission denied".
      const status = systemPreferences.getMediaAccessStatus('screen')
      if (status === 'denied' || status === 'restricted') {
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
        throw new Error('screen recording is off for workshop: turn it on in the System Settings pane just opened, then quit and reopen workshop')
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
      if (!src) throw new Error('no screen to capture (System Settings ▸ Privacy & Security ▸ Screen Recording)')
      return { id: src.id, bounds: display.bounds, scale: display.scaleFactor }
    })
    // Sound: the output routed through BlackHole (and the microphone permission recording any input needs).
    ipcMain.handle(REC.audioOn, async (e) => {
      if (!mine(e)) return 'not the recorder'
      if (this.deps.smoke) return 'a smoke run records no sound'
      // macOS asks only once: after a "no", askForMediaAccess answers false without a prompt, so
      // open the Microphone pane of System Settings where it can be turned on.
      const status = systemPreferences.getMediaAccessStatus('microphone')
      if (status === 'denied' || status === 'restricted') {
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
        return 'microphone access is off for workshop: turn it on in the System Settings pane just opened, then try again'
      }
      if (!(await systemPreferences.askForMediaAccess('microphone'))) return 'microphone access is off for workshop (System Settings ▸ Privacy & Security ▸ Microphone)'
      return this.routeAudio()
    })
    ipcMain.handle(REC.audioOff, async (e) => {
      if (mine(e)) await this.restoreAudio()
    })
    ipcMain.handle(REC.begin, (e, ext: unknown) => {
      if (!mine(e)) throw new Error('not the recorder')
      this.endTake()
      mkdirSync(this.dir, { recursive: true })
      const path = join(this.dir, `take.${typeof ext === 'string' && /^[a-z0-9]{2,4}$/.test(ext) ? ext : 'webm'}`)
      this.take = { stream: createWriteStream(path), path }
    })
    ipcMain.handle(REC.chunk, (e, bytes: unknown) => {
      if (!mine(e) || !this.take || !(bytes instanceof Uint8Array)) return
      const take = this.take
      return new Promise<void>((done) => (take.stream.write(Buffer.from(bytes)) ? done() : take.stream.once('drain', done)))
    })
    ipcMain.handle(REC.end, async (e, ext: unknown) => {
      if (!mine(e)) throw new Error('not the recorder')
      await this.restoreAudio()
      const path = await this.finish(typeof ext === 'string' ? ext : 'webm')
      this.lastSaved = path
      if (!this.deps.smoke && Notification.isSupported()) {
        const n = new Notification({ title: 'Recording saved', body: path.replace(homedir(), '~'), silent: true })
        n.on('click', () => shell.showItemInFolder(path))
        n.show()
      }
      return path
    })
    ipcMain.on(REC.reveal, (e, p: unknown) => {
      const ok = mine(e) && this.ours(p)
      if (ok && !this.deps.smoke) shell.showItemInFolder(ok)
    })
    ipcMain.on(REC.play, (e, p: unknown) => {
      const ok = mine(e) && this.ours(p)
      if (ok && !this.deps.smoke) void shell.openPath(ok)
    })
    // Quitting mid-take: the output goes back before the process does.
    app.on('will-quit', () => {
      const to = this.restoreTo
      if (!to || !this.audioBin) return
      this.restoreTo = null
      try {
        execFileSync(this.audioBin, ['restore', to], { timeout: 5000 })
      } catch {
        // the output stays "+ Record": still audible, nothing lost
      }
    })
  }
}
