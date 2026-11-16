// VOICE: the top bar's Voice button (renderer/VoiceButton.tsx). The window listens to the
// microphone and cuts what it hears into utterances; each comes here as a 16 kHz WAV, is written
// down by whisper.cpp on this Mac (whisper-cli, nothing leaves the machine), and goes back as text.
// The window parses it (shared/voice.ts) and does what it can itself (focus a session, scroll its
// terminal, open the launcher); the rest comes back here as a command to run:
//
// - tiles, through their own doors as any session would (caller "voice"): Reminders (add, note,
//   log), Pomodoro (start, pause, skip, extend, status), Spotify (play <what>, which searches with
//   the user's own Spotify sign-in in that tile). A tile that is off or refuses says why, and the
//   button shows it.
// - music, through core's own music host (main/music.ts): play, pause, next, previous, volume.
// - a prompt typed into a session (sessions.paste), only to a session that is open.
//
// The model: WORKSHOP_WHISPER_MODEL, else the first of MODEL_PLACES that exists. whisper-cli from
// PATH or Homebrew. Neither is shipped: the button says what is missing.

import { ipcMain, shell, systemPreferences, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import { describeVoice, type VoiceCommand } from '@shared/voice'
import type { Door } from './door'
import type { MusicHost } from './music'
import type { SessionManager } from './sessions'
import { findInPath } from './env'

/** Where a model may already be, best first. */
const MODEL_PLACES = (): string[] => {
  const h = homedir()
  const named = [
    join(h, 'dictator/models/ggml-small.en.bin'),
    join(h, '.workshop/whisper/ggml-small.en.bin'),
    join(h, '.workshop/whisper/ggml-base.en.bin'),
    '/opt/homebrew/share/whisper-cpp/ggml-small.en.bin',
    '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin'
  ]
  // Any other ggml model in those folders (never whisper.cpp's tiny test model).
  for (const dir of [join(h, '.workshop/whisper'), '/opt/homebrew/share/whisper-cpp']) {
    try {
      for (const f of readdirSync(dir)) if (/^ggml-.+\.bin$/.test(f) && !f.startsWith('for-tests')) named.push(join(dir, f))
    } catch {
      // not there
    }
  }
  return named
}

/** Words whisper should expect: it spells them right when it has seen them. */
const PROMPT = 'Workshop voice commands: session three, next session, page up, page down, scroll up one response, Spotify, Pomodoro, remind me to, take a note, commit and push, over.'

const HEAR_TIMEOUT_MS = 20_000
const MAX_WAV = 2 * 1024 * 1024 // 60 s of 16 kHz 16-bit mono is 1.9 MB

export interface VoiceReady {
  ok: boolean
  whisper: string | null
  model: string | null
  /** What is missing, in a sentence, when not ok. */
  why?: string
}

export interface VoiceResult {
  ok: boolean
  /** What the button shows: what was done, or why not. */
  say: string
}

interface Deps {
  door: Door
  music: () => MusicHost | null
  sessions: () => SessionManager | null
  userData: string
  win: () => WebContents | null
  env: () => NodeJS.ProcessEnv
}

export class Voice {
  private token: string | null = null
  private seq = 0

  constructor(private readonly d: Deps) {}

  ready(): VoiceReady {
    const env = this.d.env()
    const whisper = findInPath(env.PATH, 'whisper-cli') ?? (existsSync('/opt/homebrew/bin/whisper-cli') ? '/opt/homebrew/bin/whisper-cli' : null)
    const given = env.WORKSHOP_WHISPER_MODEL || process.env.WORKSHOP_WHISPER_MODEL
    const model = given && existsSync(given) ? given : (MODEL_PLACES().find((p) => existsSync(p)) ?? null)
    if (!whisper) return { ok: false, whisper, model, why: 'whisper.cpp is not installed: brew install whisper-cpp' }
    if (!model) return { ok: false, whisper, model, why: 'No whisper model found: put ggml-small.en.bin in ~/.workshop/whisper/ (or set WORKSHOP_WHISPER_MODEL)' }
    return { ok: true, whisper, model }
  }

  /** The Mac's own microphone prompt; null when allowed, else what to do. */
  async mic(): Promise<string | null> {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'denied' || status === 'restricted') {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
      return 'Microphone access is off for workshop: turn it on in the System Settings pane just opened'
    }
    if (!(await systemPreferences.askForMediaAccess('microphone'))) return 'Microphone access is off for workshop (System Settings ▸ Privacy & Security ▸ Microphone)'
    return null
  }

  /** Whisper's prompt: the command words, and the open sessions' names, so it writes "slay-10", not "Slay 10". */
  private prompt(): string {
    const names = (this.d.sessions()?.getState().sessions ?? []).filter((x) => x.open).map((x) => x.name.slice(0, 40)).slice(0, 12)
    return names.length ? `${PROMPT} Sessions: ${names.join(', ')}.` : PROMPT
  }

  /** One utterance (a WAV) → whisper's text. */
  async hear(wav: Uint8Array): Promise<string> {
    const r = this.ready()
    if (!r.ok) throw new Error(r.why)
    if (!(wav instanceof Uint8Array) || wav.length < 44 || wav.length > MAX_WAV) throw new Error('voice: not a WAV this size')
    if (String.fromCharCode(...wav.slice(0, 4)) !== 'RIFF') throw new Error('voice: not a WAV')
    const dir = join(this.d.userData, 'voice')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `utt-${process.pid}-${++this.seq}.wav`)
    writeFileSync(file, wav)
    try {
      return await new Promise<string>((resolve, reject) => {
        execFile(
          r.whisper!,
          ['-m', r.model!, '-f', file, '-l', 'en', '-nt', '-np', '--prompt', this.prompt()],
          { timeout: HEAR_TIMEOUT_MS, maxBuffer: 256 * 1024, env: this.d.env() },
          (err, stdout) => (err ? reject(new Error(`whisper: ${err.message.split('\n')[0]}`)) : resolve(stdout.trim()))
        )
      })
    } finally {
      rmSync(file, { force: true })
    }
  }

  /** A command the window cannot do itself. `ctx`: the focused session (for a prompt or a reminder's project). */
  async act(c: VoiceCommand, ctx: { sessionId?: string | null; cwd?: string | null }): Promise<VoiceResult> {
    try {
      const say = await this.run(c, ctx)
      return { ok: true, say: say ?? describeVoice(c) }
    } catch (err) {
      return { ok: false, say: (err as Error).message }
    }
  }

  private async run(c: VoiceCommand, ctx: { sessionId?: string | null; cwd?: string | null }): Promise<string | void> {
    const project = ctx.cwd && ctx.cwd.startsWith('/') ? ['--project', ctx.cwd] : []
    switch (c.kind) {
      case 'reminder':
        await this.tile('reminders', 'add', [c.text, ...project])
        return
      case 'note':
        await this.tile('reminders', 'note', [c.text, ...project])
        return
      case 'log':
        await this.tile('reminders', 'log', [c.text, ...project])
        return
      case 'pomodoro': {
        const args = c.op === 'start' && c.text ? [c.text] : c.op === 'extend' ? [String(c.minutes ?? 5)] : []
        const st = (await this.tile('pomodoro', c.op, args)) as { phase?: string; remaining?: string; running?: boolean; intent?: string | null } | null
        if (!st) return
        const phase = st.phase === 'focus' ? 'Focus' : st.phase ? st.phase.replace(/([A-Z])/g, ' $1').replace(/^./, (x) => x.toUpperCase()) : 'Pomodoro'
        return `${phase}: ${st.remaining ?? ''} left${st.running ? '' : ' (paused)'}${st.intent ? ` · ${st.intent}` : ''}`
      }
      case 'music-search': {
        const r = (await this.tile('spotify', 'play', [c.query])) as { name?: string; by?: string } | null
        return r?.name ? `Playing ${r.name}${r.by ? ` · ${r.by}` : ''}` : undefined
      }
      case 'music': {
        const m = this.music()
        await m.control(c.how)
        return
      }
      case 'music-volume': {
        const m = this.music()
        const now = (await m.get()).volume ?? 50
        const to = Math.max(0, Math.min(100, Math.round(c.to ?? now + (c.by ?? 0))))
        await m.control('volume', to)
        return `Volume ${to}`
      }
      case 'prompt': {
        const ses = this.d.sessions()
        const id = ctx.sessionId
        if (!ses || !id || !ses.find(id)?.open) throw new Error('No open session to type into')
        if (!c.text.trim()) throw new Error('Nothing to type')
        // Speech that was not a command waits in the prompt, a space after it so the next joins on.
        if (c.draft) ses.input(id, `\x1b[200~${c.text.trim()} \x1b[201~`)
        else ses.paste(id, c.text.trim())
        return
      }
      default:
        throw new Error(`voice: "${c.kind}" is the window's to do`)
    }
  }

  private music(): MusicHost {
    const m = this.d.music()
    if (!m) throw new Error('Music is not available')
    return m
  }

  /** A tile's door, as a session would call it, under the caller name "voice". */
  private tile(id: string, op: string, args: string[]): Promise<unknown> {
    this.token ??= this.d.door.issue('voice')
    const body = JSON.stringify({ op, args })
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: this.d.door.port, path: `/tile/${id}`, method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (x: Buffer) => chunks.push(x))
          res.on('end', () => {
            try {
              const r = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok: boolean; result?: unknown; error?: string }
              if (r.ok) resolve(r.result)
              else reject(new Error(r.error ?? 'the tile refused'))
            } catch {
              reject(new Error(`the ${id} tile answered with something that is not JSON`))
            }
          })
        }
      )
      req.on('error', (e) => reject(new Error(`door: ${e.message}`)))
      req.setTimeout(20_000, () => req.destroy(new Error('timed out')))
      req.end(body)
    })
  }
}

/** The window's channels. Only core's own window may call them. */
export function startVoice(v: Voice, isCoreWindow: (e: IpcMainInvokeEvent) => boolean): void {
  const guard =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (e: IpcMainInvokeEvent, ...a: A): R => {
      if (!isCoreWindow(e)) throw new Error('voice: core window only')
      return fn(...a)
    }
  ipcMain.handle(CH.voiceReady, guard(() => v.ready()))
  ipcMain.handle(CH.voiceMic, guard(() => v.mic()))
  ipcMain.handle(CH.voiceHear, guard((wav: Uint8Array) => v.hear(wav)))
  ipcMain.handle(CH.voiceAct, guard((c: VoiceCommand, ctx: { sessionId?: string | null; cwd?: string | null }) => v.act(c, ctx ?? {})))
}
