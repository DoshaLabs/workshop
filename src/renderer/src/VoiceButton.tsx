// The top bar's Voice button (main/voice.ts; the grammar is shared/voice.ts). A click or ⌘⇧L turns
// listening on: the microphone stays open, each thing you say (speech, then 0.7 s of quiet) is cut
// out, written down by whisper.cpp on this Mac, parsed into one command and done. The button shows
// what it heard and what it did. A sentence that is not a command is typed into the focused session's
// prompt as a draft, never sent until you say "over".
//
// The window does what it can itself (App.tsx's `run`: focus a session, scroll its terminal, open
// the launcher, the recorder); tiles, music and typed prompts go through main.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Utterances, encodeWav, parseVoice, resample, responseRows, scrollBytes, type ScrollHow, type VoiceCommand } from '@shared/voice'
import { middleCell, screenLines } from './terminals'

type Phase = 'off' | 'starting' | 'listening' | 'hearing' | 'working'

const TITLE = 'Voice commands (⌘⇧L): "session b2", "page up", "scroll up one response", "play Radiohead", "remind me to…", "start a pomodoro"'
const RATE = 16000
const BLOCK = 2048
const PREROLL_MS = 350
const SAY_MS = 4500

/** What running a command came to. */
export interface VoiceOutcome {
  ok: boolean
  say: string
  stop?: boolean
}

export function VoiceButton({ run }: { run: (c: VoiceCommand) => Promise<VoiceOutcome> }) {
  const [phase, setPhase] = useState<Phase>('off')
  const [said, setSaid] = useState<{ text: string; ok: boolean; heard: string } | null>(null)
  const [level, setLevel] = useState(0)
  const stopRef = useRef<(() => void) | null>(null)
  const runRef = useRef(run)
  runRef.current = run
  const queue = useRef<Promise<void>>(Promise.resolve())
  const sayTimer = useRef(0)

  const show = useCallback((text: string, ok: boolean, heard: string) => {
    setSaid({ text, ok, heard })
    clearTimeout(sayTimer.current)
    sayTimer.current = window.setTimeout(() => setSaid(null), SAY_MS)
  }, [])

  const stop = useCallback(() => {
    stopRef.current?.()
    stopRef.current = null
    setPhase('off')
    setLevel(0)
  }, [])

  /** One utterance: whisper, parse, act. Run one at a time, in the order spoken. */
  const handle = useCallback(
    (wav: Uint8Array) => {
      queue.current = queue.current.then(async () => {
        setPhase((p) => (p === 'off' ? p : 'working'))
        try {
          const heard = await window.core.voice.hear(wav)
          const c = parseVoice(heard)
          if (c.kind === 'unknown' && !c.text) {
            // nothing said
          } else if (c.kind === 'stop-listening') {
            stop()
            show('Stopped listening', true, heard)
            return
          } else {
            const r = await runRef.current(c)
            if (r.stop) {
              stop()
              show(r.say, true, heard)
              return
            }
            show(r.say, r.ok, heard)
          }
        } catch (err) {
          show((err as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), false, '')
        }
        setPhase((p) => (p === 'off' ? p : 'listening'))
      })
    },
    [show, stop]
  )

  const start = useCallback(async () => {
    setPhase('starting')
    const ready = await window.core.voice.ready()
    if (!ready.ok) {
      setPhase('off')
      return show(ready.why ?? 'Voice is not set up', false, '')
    }
    const denied = await window.core.voice.mic()
    if (denied) {
      setPhase('off')
      return show(denied, false, '')
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (err) {
      setPhase('off')
      return show(`Microphone: ${(err as Error).message}`, false, '')
    }
    const ctx = new AudioContext()
    const src = ctx.createMediaStreamSource(stream)
    // ScriptProcessor is old but needs no worklet file (the window's CSP); one block is ~43 ms.
    const proc = ctx.createScriptProcessor(BLOCK, 1, 1)
    const cut = new Utterances()
    const blockMs = (BLOCK / ctx.sampleRate) * 1000
    const pre: Float32Array[] = []
    const preMax = Math.ceil(PREROLL_MS / blockMs)
    let taking: Float32Array[] | null = null
    let shown = 0
    proc.onaudioprocess = (ev) => {
      const x = new Float32Array(ev.inputBuffer.getChannelData(0))
      let sum = 0
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i]
      const rms = Math.sqrt(sum / x.length)
      const now = performance.now()
      if (now - shown > 80) {
        shown = now
        setLevel(Math.min(1, rms * 8))
      }
      const what = cut.feed(rms, blockMs)
      if (what === 'start') {
        taking = [...pre, x]
        setPhase((p) => (p === 'listening' ? 'hearing' : p))
      } else if (taking) taking.push(x)
      pre.push(x)
      if (pre.length > preMax) pre.shift()
      if ((what === 'end' || what === 'drop') && taking) {
        const parts = taking
        taking = null
        setPhase((p) => (p === 'hearing' ? 'listening' : p))
        if (what === 'drop') return
        const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
        let at = 0
        for (const p of parts) {
          all.set(p, at)
          at += p.length
        }
        handle(encodeWav(resample(all, ctx.sampleRate, RATE), RATE))
      }
    }
    src.connect(proc)
    // A ScriptProcessor only runs while connected to the output; it writes silence there.
    proc.connect(ctx.destination)
    stopRef.current = () => {
      proc.onaudioprocess = null
      proc.disconnect()
      src.disconnect()
      for (const t of stream.getTracks()) t.stop()
      void ctx.close()
    }
    setPhase('listening')
  }, [handle, show])

  const toggle = useCallback(() => {
    if (stopRef.current || phase === 'starting') stop()
    else void start()
  }, [phase, start, stop])

  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => window.core.voice.onToggle(() => toggleRef.current()), [])
  useEffect(() => () => stopRef.current?.(), [])

  const on = phase !== 'off'
  const label = said ? said.text : phase === 'starting' ? 'Starting…' : phase === 'hearing' ? 'Hearing…' : phase === 'working' ? 'Working…' : on ? 'Listening' : 'Voice'
  const title = said?.heard ? `Heard: “${said.heard}”` : on ? 'Listening for commands: click or ⌘⇧L to stop' : TITLE
  return (
    <button
      className={`ghost small voice-btn ${on ? 'is-on' : ''} ${said ? (said.ok ? 'said-ok' : 'said-no') : ''}`}
      data-phase={phase}
      title={title}
      aria-label={on ? `Voice commands on: ${label}` : 'Voice commands'}
      aria-pressed={on}
      onClick={toggle}
      style={{ ['--voice-level' as string]: String(level) }}
    >
      <span className="voice-btn-mic" aria-hidden>
        <svg viewBox="0 0 16 16" width="12" height="12">
          <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="currentColor" />
          <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </span>
      <span className="voice-btn-label">{label}</span>
    </button>
  )
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Scroll a session's terminal. Pages, the top and the bottom are keys Claude Code's fullscreen
 * renderer binds; a line is a wheel report. "One response" has no key, so it wheels a line at a
 * time and watches the screen until the start of another response (shared/voice.ts responseRows:
 * ⏺, or your prompt's ❯) reaches the top rows, or the screen stops moving (the end).
 */
export async function scrollSession(id: string, how: ScrollHow, times: number): Promise<string | null> {
  const { col, row } = middleCell(id)
  if (how !== 'responseUp' && how !== 'responseDown') {
    const bytes = scrollBytes(how, col, row)
    const n = how === 'top' || how === 'bottom' ? 1 : times
    for (let i = 0; i < n; i++) {
      window.core.ptyInput(id, bytes)
      if (n > 1) await sleep(25)
    }
    return null
  }
  const up = how === 'responseUp'
  const wheel = scrollBytes(up ? 'lineUp' : 'lineDown', col, row)
  const TOP = 3
  for (let k = 0; k < times; k++) {
    const first = screenLines(id)
    if (!first) return 'That session has no terminal yet'
    // The response already at the top doesn't count: we want the one before (or after) it.
    const startHead = responseRows(first).filter((r) => r <= TOP).map((r) => first[r].trim())[0] ?? null
    let last = first.join('\n')
    let still = 0
    let found = false
    for (let step = 0; step < 400 && !found; step++) {
      window.core.ptyInput(id, wheel)
      await sleep(30)
      const now = screenLines(id)
      if (!now) break
      const joined = now.join('\n')
      if (joined === last) {
        if (++still >= 6) return k === 0 ? (up ? 'Already at the top' : 'Already at the latest') : null
        continue
      }
      still = 0
      last = joined
      const heads = responseRows(now).filter((r) => r <= TOP)
      if (heads.some((r) => now[r].trim() !== startHead)) found = true
    }
  }
  return null
}
