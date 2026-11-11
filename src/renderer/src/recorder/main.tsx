// THE SCREEN RECORDER'S FRAME (main/recorder.ts has the whole story): a 9:16 window you drag anywhere,
// its inside click-through, and the capture itself: the display under it cropped every frame to
// where the inside is NOW, into a 1080×1920 canvas, with the Mac's sound (through BlackHole) and
// optionally the microphone mixed in, recorded in one-second chunks that stream to main.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { COUNTDOWN, FPS, clock, cropOf, innerOf, outSize, type RecFit, type RecHello, type RecPhase, type RecPrefs, type RecSource } from '@shared/recorder'
import './recorder.css'

declare global {
  interface Window {
    rec: {
      hello(): Promise<RecHello>
      setPrefs(p: RecPrefs): Promise<void>
      passThrough(through: boolean): void
      move(x: number, y: number): void
      resize(height: number): void
      close(): void
      phase(phase: string): void
      source(): Promise<RecSource>
      audioOn(): Promise<string>
      audioOff(): Promise<void>
      begin(ext: string): Promise<void>
      chunk(bytes: Uint8Array): Promise<void>
      end(ext: string): Promise<string>
      reveal(path: string): void
      play(path: string): void
      onCloseAsked(cb: () => void): () => void
      onTheme(cb: (vars: Record<string, string>) => void): () => void
    }
  }
}

function applyVars(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v)
}

/** The recordable type this Chromium encodes best: H.264 in MP4 first (the hardware encoder), else WebM. */
function pickType(): { mime: string; ext: string } {
  for (const [mime, ext] of [
    ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
    ['video/mp4;codecs=avc1,opus', 'mp4'],
    ['video/webm;codecs=h264,opus', 'webm'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm', 'webm']
  ] as const)
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext }
  return { mime: '', ext: 'webm' }
}

/** Where the filmed rectangle is on the screen now (points), from the window's own position and the fit. */
const innerNow = (fit: RecFit) => innerOf({ x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight }, fit)

/**
 * A smoke run films this instead of the screen: moving bars the size of the display, so the crop,
 * the canvas, MediaRecorder and the file all run without the Screen Recording permission.
 */
function testPattern(src: RecSource): MediaStream {
  const c = document.createElement('canvas')
  c.width = Math.round(src.bounds.width)
  c.height = Math.round(src.bounds.height)
  const g = c.getContext('2d')!
  let t = 0
  const paint = () => {
    t++
    for (let i = 0; i < 8; i++) {
      g.fillStyle = `hsl(${(i * 45 + t * 4) % 360} 70% 50%)`
      g.fillRect((i * c.width) / 8, 0, c.width / 8, c.height)
    }
  }
  paint()
  const timer = window.setInterval(paint, 1000 / FPS)
  const s = c.captureStream(FPS)
  ;(s as MediaStream & { stopPattern?: () => void }).stopPattern = () => clearInterval(timer)
  return s
}

interface Take {
  stop(): void
  cancel(): void
}

// Which capture failed: the page's own error is a bare "Permission denied" for any of them.
async function step<T>(what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f()
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`)
  }
}

async function startTake(opts: { fit: RecFit; sound: boolean; mic: boolean; onWarn(w: string): void; onSaved(path: string): void; onError(e: string): void }): Promise<Take> {
  const src = await window.rec.source()
  const screenStream = src.stub
    ? testPattern(src)
    : await step('screen capture (System Settings ▸ Privacy & Security ▸ Screen Recording)', () =>
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: src.id,
              maxWidth: Math.round(src.bounds.width * src.scale),
              maxHeight: Math.round(src.bounds.height * src.scale),
              maxFrameRate: 60
            }
          } as unknown as MediaTrackConstraints
        })
      )
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = screenStream
  await video.play()

  // A reel is 1080 × 1920; the center column is filmed at its own size in the display's pixels.
  const size = outSize(opts.fit, innerNow(opts.fit), src.scale)
  const canvas = document.createElement('canvas')
  canvas.width = size.w
  canvas.height = size.h
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.imageSmoothingQuality = 'high'
  // Drawn on a clock, not on the capture's frames: a still screen sends none, and the frame may be moving.
  const draw = () => {
    const c = cropOf(innerNow(opts.fit), src.bounds, video.videoWidth, video.videoHeight)
    if (c) ctx.drawImage(video, c.sx, c.sy, c.sw, c.sh, 0, 0, size.w, size.h)
  }
  draw()
  const timer = window.setInterval(draw, 1000 / FPS)
  const out = canvas.captureStream(FPS)

  // Sound: the Mac's output as BlackHole hears it, and the microphone if asked, mixed into one track.
  const extra: MediaStream[] = []
  let audioCtx: AudioContext | null = null
  if (opts.sound || opts.mic) {
    audioCtx = new AudioContext({ sampleRate: 48000 })
    const dest = audioCtx.createMediaStreamDestination()
    const plain = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
    if (opts.sound) {
      const err = await window.rec.audioOn()
      if (err) opts.onWarn(`no system sound: ${err}`)
      else {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
        const bh = inputs.find((d) => /blackhole/i.test(d.label))
        if (!bh) opts.onWarn('no system sound: BlackHole 2ch is not an input (brew install blackhole-2ch)')
        else {
          const s = await step('system sound via BlackHole (System Settings ▸ Privacy & Security ▸ Microphone)', () => navigator.mediaDevices.getUserMedia({ audio: { ...plain, deviceId: { exact: bh.deviceId } } }))
          extra.push(s)
          audioCtx.createMediaStreamSource(s).connect(dest)
        }
      }
    }
    if (opts.mic) {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
      const def = inputs.find((d) => d.deviceId === 'default')
      // Never BlackHole as "the microphone": that is the system sound again.
      const pick = def && !/blackhole/i.test(def.label) ? def : inputs.find((d) => d.deviceId !== 'default' && !/blackhole/i.test(d.label))
      if (!pick) opts.onWarn('no microphone found')
      else {
        const s = await step('microphone (System Settings ▸ Privacy & Security ▸ Microphone)', () => navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: pick.deviceId }, echoCancellation: true, noiseSuppression: true } }))
        extra.push(s)
        audioCtx.createMediaStreamSource(s).connect(dest)
      }
    }
    if (extra.length) for (const t of dest.stream.getAudioTracks()) out.addTrack(t)
  }

  const { mime, ext } = pickType()
  const recorder = new MediaRecorder(out, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 20_000_000, audioBitsPerSecond: 256_000 })
  await window.rec.begin(ext)
  let chain = Promise.resolve()
  let cancelled = false
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chain = chain.then(async () => window.rec.chunk(new Uint8Array(await e.data.arrayBuffer())))
  }
  const teardown = () => {
    clearInterval(timer)
    ;(screenStream as MediaStream & { stopPattern?: () => void }).stopPattern?.()
    for (const s of [screenStream, out, ...extra]) for (const t of s.getTracks()) t.stop()
    void audioCtx?.close()
    video.srcObject = null
  }
  recorder.onstop = () => {
    teardown()
    if (cancelled) return void window.rec.audioOff()
    chain.then(() => window.rec.end(ext)).then(opts.onSaved, (e: Error) => opts.onError(e.message))
  }
  recorder.start(1000)
  return {
    stop: () => recorder.state !== 'inactive' && recorder.stop(),
    cancel: () => {
      cancelled = true
      if (recorder.state !== 'inactive') recorder.stop()
    }
  }
}

/** The bar's glyphs, drawn here (no icon library: workshop ships none). 16 px, stroked in the text colour. */
const GLYPHS: Record<string, ReactNode> = {
  rec: <circle cx="8" cy="8" r="5" fill="currentColor" stroke="none" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />,
  sound: (
    <>
      <path d="M2.5 6h2.5l3.5-3v10l-3.5-3h-2.5z" />
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9" />
    </>
  ),
  mute: (
    <>
      <path d="M2.5 6h2.5l3.5-3v10l-3.5-3h-2.5z" />
      <path d="M11 6l3.5 4M14.5 6l-3.5 4" />
    </>
  ),
  mic: (
    <>
      <rect x="6" y="2" width="4" height="7.5" rx="2" />
      <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14.5" />
    </>
  ),
  micOff: (
    <>
      <rect x="6" y="2" width="4" height="7.5" rx="2" />
      <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14.5M2.5 2.5l11 11" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <path d="M2.5 2.5l11 11" />
    </>
  ),
  play: <path d="M5 3l8 5-8 5z" fill="currentColor" />,
  folder: <path d="M1.5 4.5v8h13v-6.5h-6.5l-1.5-1.5z" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  grip: <path d="M13 6l-7 7M13 9.5l-3.5 3.5M13 13h0" />
}

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg className="rec-glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {GLYPHS[name]}
    </svg>
  )
}

function Frame() {
  const [phase, setPhase] = useState<RecPhase>('idle')
  const [count, setCount] = useState(0)
  const [started, setStarted] = useState(0)
  const [now, setNow] = useState(0)
  const [prefs, setPrefsState] = useState<RecPrefs | null>(null)
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState('')
  const take = useRef<Take | null>(null)
  const countTimer = useRef(0)
  const through = useRef<boolean | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    void window.rec.hello().then((h) => {
      applyVars(h.vars)
      setPrefsState(h.prefs)
    })
    return window.rec.onTheme(applyVars)
  }, [])

  const setPref = <K extends keyof RecPrefs>(k: K, v: RecPrefs[K]) => {
    if (!prefs) return
    const next = { ...prefs, [k]: v }
    setPrefsState(next)
    void window.rec.setPrefs(next)
  }

  // The inside lets the pointer through to whatever is under it; the border and the bar do not.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const t = !!(e.target as HTMLElement | null)?.closest?.('.rec-inner')
      if (t !== through.current) {
        through.current = t
        window.rec.passThrough(t)
      }
    }
    const onLeave = () => {
      through.current = true
      window.rec.passThrough(true)
    }
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [phase])

  useEffect(() => window.rec.phase(phase), [phase])

  const begin = async () => {
    setNote('')
    setSaved('')
    try {
      take.current = await startTake({
        fit: prefs?.fit ?? 'reel',
        sound: !!prefs?.sound,
        mic: !!prefs?.mic,
        onWarn: (w) => setNote(w),
        onSaved: (p) => {
          take.current = null
          setSaved(p)
          setPhase('saved')
        },
        onError: (e) => {
          take.current = null
          setNote(e)
          setPhase('error')
        }
      })
      setStarted(Date.now())
      setNow(Date.now())
      setPhase('recording')
    } catch (e) {
      void window.rec.audioOff()
      setNote((e as Error).message)
      setPhase('error')
    }
  }

  const record = () => {
    if (phase === 'recording') {
      setPhase('saving')
      take.current?.stop()
      return
    }
    if (phase === 'countdown') {
      clearInterval(countTimer.current)
      setPhase('idle')
      return
    }
    if (phase === 'saving') return
    setPhase('countdown')
    let n = COUNTDOWN
    setCount(n)
    countTimer.current = window.setInterval(() => {
      n -= 1
      if (n > 0) return setCount(n)
      clearInterval(countTimer.current)
      setCount(0)
      void begin()
    }, 1000)
  }
  const recordRef = useRef(record)
  recordRef.current = record

  useEffect(
    () =>
      window.rec.onCloseAsked(() => {
        const p = phaseRef.current
        if (p === 'recording' || p === 'countdown') recordRef.current()
        else if (p !== 'saving') window.rec.close()
      }),
    []
  )

  const close = () => {
    if (phase === 'recording' && !confirm('Stop and throw this take away?')) return
    take.current?.cancel()
    window.rec.close()
  }

  // Moving and resizing are ours (an app-region drag would swallow the pointer events the pass-through needs).
  const drag = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const ox = e.screenX - window.screenX
    const oy = e.screenY - window.screenY
    const move = (ev: PointerEvent) => window.rec.move(Math.round(ev.screenX - ox), Math.round(ev.screenY - oy))
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const resize = (e: ReactPointerEvent) => {
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const y0 = e.screenY
    const x0 = e.screenX
    const h0 = innerNow('reel').height
    const move = (ev: PointerEvent) => {
      // Whichever way the pointer went further sets the size; the width follows at 9:16.
      const dh = Math.max(ev.screenY - y0, ((ev.screenX - x0) * 16) / 9)
      window.rec.resize(h0 + dh)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const live = phase === 'recording'
  const busy = live || phase === 'countdown' || phase === 'saving'
  const sound = !!prefs?.sound
  const mic = !!prefs?.mic
  const fit: RecFit = prefs?.fit ?? 'reel'
  const reel = fit === 'reel'
  const guides = reel && !!prefs?.guides
  return (
    <div className={`rec fit-${fit} ${live ? 'is-live' : ''}`}>
      <div className="rec-frame" onPointerDown={reel ? drag : undefined}>
        <div className="rec-inner">
          {guides && !busy && (
            <div className="rec-guides" title="Instagram's own buttons and captions cover these">
              <div className="rec-safe-top" />
              <div className="rec-safe-bottom" />
              <div className="rec-safe-right" />
            </div>
          )}
          {phase === 'countdown' && count > 0 && <div className="rec-count">{count}</div>}
        </div>
      </div>
      <div className="rec-bar" onPointerDown={reel ? drag : undefined}>
        <button className={`rec-go ${live ? 'is-live' : ''}`} onClick={record} disabled={phase === 'saving' || !prefs} title={live ? 'Stop and save (⌘⇧O)' : phase === 'countdown' ? 'Cancel' : 'Record (3, 2, 1…)'}>
          <Glyph name={live ? 'stop' : 'rec'} />
          <span>{live ? clock(now - started) : phase === 'countdown' ? count : phase === 'saving' ? 'saving…' : 'rec'}</span>
        </button>
        <button className={`rec-tog ${sound ? 'on' : ''}`} disabled={busy} onClick={() => setPref('sound', !sound)} title={sound ? "The Mac's sound is recorded (through BlackHole)" : 'No system sound'}>
          <Glyph name={sound ? 'sound' : 'mute'} />
        </button>
        <button className={`rec-tog ${mic ? 'on' : ''}`} disabled={busy} onClick={() => setPref('mic', !mic)} title={mic ? 'Your microphone is mixed in (headphones, or the speakers echo)' : 'No microphone'}>
          <Glyph name={mic ? 'mic' : 'micOff'} />
        </button>
        <span className="rec-fit" role="radiogroup" aria-label="What to film">
          <button role="radio" aria-checked={reel} className={reel ? 'on' : ''} disabled={busy || !prefs} onClick={() => setPref('fit', 'reel')} title="A 9:16 frame you drag anywhere, for Reels and Stories (1080 × 1920)">
            9:16
          </button>
          <button role="radio" aria-checked={!reel} className={!reel ? 'on' : ''} disabled={busy || !prefs} onClick={() => setPref('fit', 'center')} title="The center column: the session you're on, at its own size. Follows the window">
            Column
          </button>
        </span>
        {reel && (
          <button className={`rec-tog ${guides ? 'on' : ''}`} onClick={() => setPref('guides', !guides)} title="Instagram's safe zones (hidden while recording)">
            <Glyph name={guides ? 'eye' : 'eyeOff'} />
          </button>
        )}
        {phase === 'saved' && (
          <>
            <button className="rec-tog rec-play" onClick={() => window.rec.play(saved)} title={`Play ${saved}`}>
              <Glyph name="play" />
            </button>
            <button className="rec-tog" onClick={() => window.rec.reveal(saved)} title="Show in Finder">
              <Glyph name="folder" />
            </button>
          </>
        )}
        <span className="rec-space" />
        <button className="rec-tog rec-close" onClick={close} title="Close the recorder (⌘⇧O)">
          <Glyph name="close" />
        </button>
        {reel && (
          <span className="rec-grip" onPointerDown={resize} title="Resize (stays 9:16)">
            <Glyph name="grip" />
          </span>
        )}
      </div>
      {note && (
        <div className="rec-note" onClick={() => setNote('')} title="Click to dismiss">
          {note}
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Frame />)
