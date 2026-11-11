// Tails each open session's transcript so its tile can show the conversation itself instead of
// the CLI's screen (CLAUDE.md §7), and each subagent's (the wolfpack, main/agents.ts), whose file
// the tracker hands over once it has SEEN it. Carried from deck's main/transcript.ts.
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
import { TRANSCRIPT_KEEP, applyLine, emptyTranscript, trimTranscript, type Transcript } from '@shared/transcript'

const POLL_MS = 400
/** How often a session whose file has not appeared is looked for (a readdir of every project). */
const LOOK_MS = 2000
const CHUNK = 1 << 16
/** A transcript longer than this is read from its end on first sight (firstRead). */
const TAIL_BYTES = 4 << 20
const TITLE_CHUNK = 1 << 20

interface Tail {
  id: string
  /** The CLI's session id, whose file is looked for by name; '' for a subagent (its path is handed over). */
  sessionId: string
  /** One of the wolfpack's (syncAgents), not an open session's. */
  agent: boolean
  /** A subagent's own file: every line is marked `isSidechain`. */
  sidechain: boolean
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
  sync(sessions: { id: string; cliSessionId: string }[]): void {
    const keep = new Set(sessions.map((s) => s.id))
    for (const [id, t] of this.tails) if (!t.agent && !keep.has(id)) this.tails.delete(id)
    for (const s of sessions) {
      const had = this.tails.get(s.id)
      if (had && had.sessionId === s.cliSessionId) continue
      this.tails.set(s.id, fresh(s.id, s.cliSessionId, false, null))
    }
    this.timers()
  }

  /**
   * Keep exactly these members of the wolfpack under watch (`agent:<id>`): a subagent by the
   * transcript the tracker has SEEN (null until it has; a path that moved, because the stop hook
   * named another file, starts the tail over), a helper session by its CLI session id, looked for
   * by name like any session's.
   */
  syncAgents(agents: { id: string; path: string | null; sessionId?: string }[]): void {
    const keep = new Set(agents.map((a) => a.id))
    for (const [id, t] of this.tails) if (t.agent && !keep.has(id)) this.tails.delete(id)
    for (const a of agents) {
      const had = this.tails.get(a.id)
      if (a.sessionId) {
        if (!had || had.sessionId !== a.sessionId) this.tails.set(a.id, fresh(a.id, a.sessionId, true, null))
        continue
      }
      if (had && (had.path === a.path || a.path === null)) continue
      this.tails.set(a.id, fresh(a.id, '', true, a.path))
    }
    this.timers()
  }

  private timers(): void {
    if (this.tails.size > 0 && !this.timer) this.timer = setInterval(() => this.poll(), POLL_MS)
    if (this.tails.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.poll()
  }

  /**
   * Conversations this watcher does not tail itself: a Codex session's, which core reads from the
   * session's app-server (main/codex-link.ts). Kept here so `get` answers the window and the tile
   * bridge alike, for either CLI. `put` keeps it and tells everyone; `drop` forgets it.
   */
  private external = new Map<string, Transcript>()

  put(t: Transcript): void {
    this.external.set(t.id, t)
    this.emit(t)
  }

  drop(id: string): void {
    this.external.delete(id)
  }

  get(id: string): Transcript | null {
    return this.tails.get(id)?.transcript ?? this.external.get(id) ?? null
  }

  /** The transcript file of a watched session, null until the CLI has written it. */
  pathOf(id: string): string | null {
    return this.tails.get(id)?.path ?? null
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.tails.clear()
    this.external.clear()
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
      if (!t.sessionId) return // a subagent's: handed over by the tracker once it has seen the file
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
      if (t.offset === 0 && size > TAIL_BYTES) this.firstRead(t, fd, size)
      else consume(t, fd, size)
    } finally {
      closeSync(fd)
    }
    if (trimTranscript(t.transcript)) t.dirty = true
  }

  /**
   * The first sight of a long transcript (real ones pass 250 MB). A tile shows the last
   * TRANSCRIPT_KEEP blocks, so only the file's end is read, the window doubling until it holds
   * that many or is the whole file; reading it all held the main process for seconds. The title is
   * usually written near the start, so when the end has none, the rest is searched for it as
   * bytes (titleBefore) and only the lines that name it are parsed.
   */
  private firstRead(t: Tail, fd: number, size: number): void {
    for (let span = TAIL_BYTES; ; span *= 2) {
      const from = Math.max(0, size - span)
      const tail: Tail = { ...t, offset: from, rest: '', decoder: new StringDecoder('utf8'), transcript: { ...emptyTranscript(t.id), found: true } }
      consume(tail, fd, size, from > 0)
      if (from > 0 && tail.transcript.blocks.length < TRANSCRIPT_KEEP) continue
      if (from > 0 && tail.transcript.title === null) tail.transcript.title = titleBefore(fd, from)
      Object.assign(t, { offset: tail.offset, rest: tail.rest, decoder: tail.decoder, transcript: tail.transcript, dirty: true })
      return
    }
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

function fresh(id: string, sessionId: string, agent: boolean, path: string | null): Tail {
  return { id, sessionId, agent, sidechain: agent && !sessionId, path, lookedAt: 0, offset: 0, rest: '', decoder: new StringDecoder('utf8'), transcript: emptyTranscript(id), dirty: false }
}

/**
 * Reads from `t.offset` to `end`, folding in every whole line. `partialStart`: the read begins in
 * the middle of a line, whose end is dropped unread.
 */
function consume(t: Tail, fd: number, end: number, partialStart = false): void {
  const buf = Buffer.alloc(CHUNK)
  let skip = partialStart
  while (t.offset < end) {
    const n = readSync(fd, buf, 0, Math.min(CHUNK, end - t.offset), t.offset)
    if (n <= 0) break
    t.offset += n
    t.rest += t.decoder.write(buf.subarray(0, n))
    const lines = t.rest.split('\n')
    // The last piece may be a line the CLI is still writing: kept for the next read.
    t.rest = lines.pop() ?? ''
    if (skip && lines.length) {
      lines.shift()
      skip = false
    }
    for (const line of lines) if (applyLine(t.transcript, line, t.sidechain)) t.dirty = true
    // Trimmed as it goes, not once at the end, so a tool result's search for its call stays short.
    trimTranscript(t.transcript)
  }
}

/**
 * The latest title in the first `end` bytes. Searched for as bytes, backwards from `end`, so the
 * search usually stops within a few lines (the CLI writes the title again as it goes), and only
 * lines that contain the word are parsed.
 */
function titleBefore(fd: number, end: number): string | null {
  const needle = Buffer.from('"ai-title"')
  const buf = Buffer.alloc(TITLE_CHUNK + needle.length)
  for (let pos = end; pos > 0; ) {
    const start = Math.max(0, pos - TITLE_CHUNK)
    // Overlapping the chunk after by a needle's length, so one cut in two is still found.
    const n = readSync(fd, buf, 0, Math.min(end, pos + needle.length - 1) - start, start)
    const data = buf.subarray(0, n)
    for (let i = data.lastIndexOf(needle); i >= 0; i = i > 0 ? data.lastIndexOf(needle, i - 1) : -1) {
      // The bytes may be inside some other line (a file Claude read): only a real title line has one.
      const scratch = emptyTranscript('')
      applyLine(scratch, lineAround(fd, start + i, end))
      if (scratch.title) return scratch.title
    }
    pos = start
  }
  return null
}

/** The whole line holding byte `at`, read from the file a piece at a time in each direction. */
function lineAround(fd: number, at: number, end: number): string {
  const buf = Buffer.alloc(CHUNK)
  let from = at
  while (from > 0) {
    const start = Math.max(0, from - CHUNK)
    const n = readSync(fd, buf, 0, from - start, start)
    const nl = buf.subarray(0, n).lastIndexOf(10)
    if (nl >= 0) {
      from = start + nl + 1
      break
    }
    from = start
  }
  let to = at
  while (to < end) {
    const n = readSync(fd, buf, 0, Math.min(CHUNK, end - to), to)
    if (n <= 0) break
    const nl = buf.subarray(0, n).indexOf(10)
    if (nl >= 0) {
      to += nl
      break
    }
    to += n
  }
  const line = Buffer.alloc(to - from)
  readSync(fd, line, 0, to - from, from)
  return line.toString('utf8')
}
