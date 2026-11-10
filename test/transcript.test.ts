import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLine, emptyTranscript, toolLabel, trimTranscript, type Transcript } from '@shared/transcript'
import { TranscriptWatcher } from '../src/main/transcript'

const FIXTURE = join(__dirname, 'fixtures', 'transcript', 'basic.jsonl')
const SID = '11111111-2222-4333-8444-555555555555'

function parse(text: string): Transcript {
  const t = emptyTranscript('abc123')
  for (const line of text.split('\n')) applyLine(t, line)
  return t
}

describe('applyLine', () => {
  const t = parse(readFileSync(FIXTURE, 'utf8'))
  const summary = t.blocks.map((b) => (b.kind === 'tool' ? `tool:${b.name}:${b.label}:${b.done ? (b.error ? 'err' : 'ok') : 'run'}` : `${b.kind}:${b.text}`))

  it('reads prompts, prose and a line per tool call, in order', () => {
    expect(summary).toEqual([
      'user:Add a **dark mode** toggle',
      'text:I will look at the settings first.',
      'tool:Read:settings.ts:ok',
      'tool:Bash:Run the tests:err',
      'text:Done. The toggle is in `src/settings.ts`:\n\n- light\n- dark\n\nTests pass.',
      'user:/compact keep the plan',
      'user:! git status'
    ])
  })
  it('skips meta lines, subagent lines, request copies, injected notifications, shell output and torn lines', () => {
    expect(JSON.stringify(t.blocks)).not.toContain('NOT SHOWN')
    expect(JSON.stringify(t.blocks)).not.toContain('Caveat')
  })
  it('takes Claude\'s title', () => {
    expect(t.title).toBe('Dark mode toggle')
  })
  it('keeps the path a tool names', () => {
    const read = t.blocks.find((b) => b.kind === 'tool' && b.name === 'Read')
    expect(read && read.kind === 'tool' && read.path).toBe('/tmp/demo/src/settings.ts')
  })
  it('says whether a line changed anything', () => {
    const x = emptyTranscript('x')
    expect(applyLine(x, '')).toBe(false)
    expect(applyLine(x, 'not json')).toBe(false)
    expect(applyLine(x, 'null')).toBe(false)
    expect(applyLine(x, JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBe(true)
    expect(applyLine(x, JSON.stringify({ type: 'ai-title', aiTitle: 'T' }))).toBe(true)
    expect(applyLine(x, JSON.stringify({ type: 'ai-title', aiTitle: 'T' }))).toBe(false)
  })
  it('starts a new prose block after a long pause', () => {
    const x = emptyTranscript('x')
    const say = (text: string, at: string) => applyLine(x, JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } }))
    say('one', '2026-11-10T10:00:00Z')
    say('two', '2026-11-10T10:05:00Z')
    expect(x.blocks.length).toBe(2)
  })
  it('keeps the tail only', () => {
    const x = emptyTranscript('x')
    for (let i = 0; i < 100; i++) applyLine(x, JSON.stringify({ type: 'user', message: { content: `p${i}` } }))
    expect(trimTranscript(x, 80)).toBe(true)
    expect(x.blocks.length).toBe(80)
    expect(x.blocks[0]).toMatchObject({ text: 'p20' })
  })
  it('labels tools by what they touched', () => {
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('TODO')
    expect(toolLabel('Bash', { command: 'ls -la\nrm' })).toBe('ls -la')
    expect(toolLabel('mcp__x__y', { q: 'first\nsecond' })).toBe('first')
    expect(toolLabel('Nothing', {})).toBe('')
  })
})

describe('TranscriptWatcher', () => {
  let projects: string
  beforeEach(() => {
    vi.useFakeTimers()
    projects = mkdtempSync(join(tmpdir(), 'ws-projects-'))
  })
  afterEach(() => vi.useRealTimers())

  it('finds the file by session id in any project folder, tails it, and holds back a torn line', () => {
    const seen: Transcript[] = []
    const w = new TranscriptWatcher(projects, (t) => seen.push(structuredClone(t)))
    w.sync([{ id: 'abc123', claudeSessionId: SID }])
    expect(w.pathOf('abc123')).toBeNull()

    // The CLI's folder name is its own encoding of the cwd; the watcher never builds it.
    const dir = join(projects, '-some-encoded-WORKTREE-folder')
    mkdirSync(dir)
    const file = join(dir, `${SID}.jsonl`)
    const prompt = JSON.stringify({ type: 'user', message: { content: 'naïve café ☕' } })
    // The first read ends in the middle of a line, and in the middle of a character.
    const bytes = Buffer.from(prompt + '\n' + prompt, 'utf8')
    const cut = Buffer.byteLength(prompt) + 1 + Buffer.from(prompt).indexOf(Buffer.from('☕')) + 1
    writeFileSync(file, bytes.subarray(0, cut))
    vi.advanceTimersByTime(2100)
    expect(w.pathOf('abc123')).toBe(file)
    expect(w.get('abc123')?.found).toBe(true)
    expect(w.get('abc123')?.blocks.length).toBe(1)

    appendFileSync(file, Buffer.concat([bytes.subarray(cut), Buffer.from('\n')]))
    vi.advanceTimersByTime(400)
    const t = w.get('abc123')!
    expect(t.blocks.map((b) => (b.kind === 'user' ? b.text : ''))).toEqual(['naïve café ☕', 'naïve café ☕'])
    expect(seen.at(-1)?.blocks.length).toBe(2)

    // Nothing new: nothing emitted.
    const n = seen.length
    vi.advanceTimersByTime(1200)
    expect(seen.length).toBe(n)

    // A session no longer open is no longer watched.
    w.sync([])
    expect(w.get('abc123')).toBeNull()
    w.stop()
  })
})
