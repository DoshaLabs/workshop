// Tails each open session's transcript so its tile can show the conversation itself instead of
// the CLI's screen (CLAUDE.md §7). Carried from deck's main/transcript.ts, sessions only (the
// subagent tails come with the wolfpack).
//
// Claude Code appends one JSON line per event to
//   <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded cwd>/<session id>.jsonl
// The session id is the UUID core hands `--session-id`, so the file is FOUND by name across every
// project folder, never built from the cwd: the encoding is the CLI's business, and a worktree
// session writes under the worktree's folder. The file appears at the first prompt, so the watcher
// keeps looking until it does.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { applyLine, emptyTranscript, trimTranscript, type Transcript } from '@shared/transcript'

const POLL_MS = 400
/** How often a session whose file has not appeared is looked for (a readdir of every project). */
const LOOK_MS = 2000
const CHUNK = 1 << 16

interface Tail {
  id: string
  sessionId: string
  path: string | null
  lookedAt: number
  offset: number
  rest: string
  /** Holds back a character split across two reads. */
  decoder: StringDecoder
  transcript: Transcript
  dirty: boolean
}

export class TranscriptWatcher {
  private tails = new Map<string, Tail>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly projectsDir: string,
    private readonly emit: (t: Transcript) => void
  ) {}

  /** Keep exactly these sessions (core id → the CLI's session id) under watch. */
  sync(sessions: { id: string; claudeSessionId: string }[]): void {
    const keep = new Set(sessions.map((s) => s.id))
    for (const id of this.tails.keys()) if (!keep.has(id)) this.tails.delete(id)
    for (const s of sessions) {
      const had = this.tails.get(s.id)
      if (had && had.sessionId === s.claudeSessionId) continue
      this.tails.set(s.id, { id: s.id, sessionId: s.claudeSessionId, path: null, lookedAt: 0, offset: 0, rest: '', decoder: new StringDecoder('utf8'), transcript: emptyTranscript(s.id), dirty: false })
    }
    if (this.tails.size > 0 && !this.timer) this.timer = setInterval(() => this.poll(), POLL_MS)
    if (this.tails.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.poll()
  }

  get(id: string): Transcript | null {
    return this.tails.get(id)?.transcript ?? null
  }

  /** The transcript file of a watched session, null until the CLI has written it. */
  pathOf(id: string): string | null {
    return this.tails.get(id)?.path ?? null
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.tails.clear()
  }

  private poll(): void {
    for (const t of this.tails.values()) {
      try {
        this.read(t)
      } catch (err) {
        console.warn('[transcript] read failed:', err)
      }
      if (t.dirty) {
        t.dirty = false
        this.emit(t.transcript)
      }
    }
  }

  private read(t: Tail): void {
    if (!t.path) {
      if (Date.now() - t.lookedAt < LOOK_MS) return
      t.lookedAt = Date.now()
      t.path = this.locate(t.sessionId)
      if (!t.path) return
    }
    if (!existsSync(t.path)) return
    const size = statSync(t.path).size
    if (!t.transcript.found) {
      t.transcript.found = true
      t.dirty = true
    }
    if (size < t.offset) {
      // Rewritten under us: start over.
      t.offset = 0
      t.rest = ''
      t.decoder = new StringDecoder('utf8')
      t.transcript.blocks = []
      t.dirty = true
    }
    if (size === t.offset) return
    const fd = openSync(t.path, 'r')
    try {
      const buf = Buffer.alloc(CHUNK)
      while (t.offset < size) {
        const n = readSync(fd, buf, 0, CHUNK, t.offset)
        if (n <= 0) break
        t.offset += n
        t.rest += t.decoder.write(buf.subarray(0, n))
        const lines = t.rest.split('\n')
        // The last piece may be a line the CLI is still writing: kept for the next read.
        t.rest = lines.pop() ?? ''
        for (const line of lines) if (applyLine(t.transcript, line)) t.dirty = true
      }
    } finally {
      closeSync(fd)
    }
    if (trimTranscript(t.transcript)) t.dirty = true
  }

  private locate(sessionId: string): string | null {
    let dirs: string[]
    try {
      dirs = readdirSync(this.projectsDir)
    } catch {
      return null
    }
    for (const d of dirs) {
      const p = join(this.projectsDir, d, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
    return null
  }
}
