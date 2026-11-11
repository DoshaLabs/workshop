// A very long transcript's first read: a session that has run for days, opened in a fresh window.
// The files are generated here (tens of megabytes is no fixture to commit), shaped like the CLI's:
// prompts, prose, tool calls whose results carry whole files, sidechain lines, request copies, and
// the title, which the CLI writes again every so often.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptWatcher } from '../src/main/transcript'
import { TRANSCRIPT_KEEP, applyLine, emptyTranscript, type Transcript } from '../src/shared/transcript'

const SID = '22222222-3333-4444-5555-666666666666'
const EARLY = '33333333-3333-4444-5555-666666666666'
const TURNS = 6000

/** `titleEvery`: turns between title lines (the CLI's habit); 0 writes it once, at the start. */
function transcript(turns: number, titleEvery: number): string {
  const out: string[] = []
  const at = (i: number): string => new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString()
  const file = 'const x = 1;\n'.repeat(400) // about 5 KB of file contents in a tool result
  out.push(JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: at(0), message: { role: 'user', content: 'Start the long job' } }))
  out.push(JSON.stringify({ type: 'ai-title', aiTitle: 'The long job' }))
  for (let i = 1; i <= turns; i++) {
    const ts = at(i)
    out.push(JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: ts, message: { role: 'user', content: `Prompt number ${i}` } }))
    out.push(JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: `Working on **${i}**.` }] } }))
    out.push(JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: `/code/app/src/f${i}.ts` } }] } }))
    out.push(JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: file }] } }))
    out.push(JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'a subagent' }] } }))
    out.push(JSON.stringify({ type: 'api-request-blob', timestamp: ts, messages: [{ role: 'user', content: file }] }))
    out.push(JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: `Done with ${i}.` }] } }))
    if (titleEvery && i % titleEvery === 0) out.push(JSON.stringify({ type: 'ai-title', aiTitle: 'The long job' }))
  }
  return out.join('\n') + '\n'
}

const time = (f: () => void): number => {
  const t0 = performance.now()
  f()
  return performance.now() - t0
}

describe('a very long transcript', () => {
  let projects: string
  let bytes = 0
  beforeAll(() => {
    projects = mkdtempSync(join(tmpdir(), 'ws-long-'))
    mkdirSync(join(projects, '-code-app'))
    const text = transcript(TURNS, 100)
    bytes = Buffer.byteLength(text)
    writeFileSync(join(projects, '-code-app', `${SID}.jsonl`), text)
    writeFileSync(join(projects, '-code-app', `${EARLY}.jsonl`), transcript(TURNS, 0))
  })
  afterAll(() => rmSync(projects, { recursive: true, force: true }))

  it('is read from its end, into the tail only, sent to the window once, and fast', () => {
    expect(bytes).toBeGreaterThan(50e6)
    // What the first read used to do: every line of the file, the blocks piling up until the end.
    const whole = readFileSync(join(projects, '-code-app', `${SID}.jsonl`), 'utf8').split('\n')
    const old = time(() => {
      const t = emptyTranscript('x')
      for (const line of whole) applyLine(t, line)
    })
    const seen: Transcript[] = []
    const w = new TranscriptWatcher(projects, (t) => seen.push(structuredClone(t)))
    const ms = time(() => w.sync([{ id: 'long01', cliSessionId: SID }]))
    w.stop()
    process.stderr.write(`[long transcript] ${(bytes / 1e6).toFixed(1)} MB, ${TURNS} turns: first read ${ms.toFixed(0)} ms (every line: ${old.toFixed(0)} ms)\n`)
    // One message to the window for the whole file, not one per chunk or per line.
    expect(seen).toHaveLength(1)
    const sent = seen[0]
    expect(sent.blocks.length).toBe(TRANSCRIPT_KEEP)
    expect(sent.title).toBe('The long job')
    const last = sent.blocks.at(-1)!
    expect(last.kind === 'text' && last.text).toBe(`Done with ${TURNS}.`)
    // The tool calls in the tail found their results.
    expect(sent.blocks.filter((b) => b.kind === 'tool').every((b) => b.kind === 'tool' && b.done)).toBe(true)
    // Measured against reading every line in the same run, so a busy machine slows both.
    expect(ms).toBeLessThan(old / 5)
  })

  it('finds a title written only at the start', () => {
    const seen: Transcript[] = []
    const w = new TranscriptWatcher(projects, (t) => seen.push(structuredClone(t)))
    const ms = time(() => w.sync([{ id: 'early1', cliSessionId: EARLY }]))
    w.stop()
    process.stderr.write(`[long transcript] title only at the start: first read ${ms.toFixed(0)} ms\n`)
    expect(seen).toHaveLength(1)
    expect(seen[0].title).toBe('The long job')
    expect(seen[0].blocks.length).toBe(TRANSCRIPT_KEEP)
  })

  it('reads further back when the end is a few huge lines, and then tails on as usual', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-long-'))
    mkdirSync(join(dir, 'p'))
    const file = join(dir, 'p', `${SID}.jsonl`)
    const at = new Date(Date.UTC(2026, 10, 1)).toISOString()
    const lines = [JSON.stringify({ type: 'ai-title', aiTitle: 'Old title' })]
    for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: at, message: { content: `small ${i}` } }))
    lines.push(JSON.stringify({ type: 'ai-title', aiTitle: 'Newer title' }))
    // Six results of a megabyte each: 4 MB from the end holds fewer than TRANSCRIPT_KEEP blocks.
    for (let i = 0; i < 6; i++) {
      lines.push(JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: `big${i}`, name: 'Read', input: { file_path: `/big/${i}` } }] } }))
      lines.push(JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: `big${i}`, content: `"ai-title" ${'y'.repeat(1 << 20)}` }] } }))
    }
    writeFileSync(file, lines.join('\n') + '\n')
    const seen: Transcript[] = []
    const w = new TranscriptWatcher(dir, (t) => seen.push(structuredClone(t)))
    w.sync([{ id: 'big01', cliSessionId: SID }])
    const t = w.get('big01')!
    expect(t.blocks).toHaveLength(TRANSCRIPT_KEEP)
    expect(t.blocks.filter((b) => b.kind === 'tool' && b.done)).toHaveLength(6)
    expect(t.blocks.filter((b) => b.kind === 'user').at(-1)).toMatchObject({ text: 'small 99' })
    // The latest title, not the first, and not the word inside a tool's output.
    expect(t.title).toBe('Newer title')
    expect(seen).toHaveLength(1)

    // Then the file grows as usual, and only the new line is read.
    writeFileSync(file, JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: at, message: { content: 'after' } }) + '\n', { flag: 'a' })
    ;(w as unknown as { poll: () => void }).poll()
    expect(w.get('big01')!.blocks.at(-1)).toMatchObject({ kind: 'user', text: 'after' })
    expect(w.get('big01')!.blocks).toHaveLength(TRANSCRIPT_KEEP)
    w.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a title found in the end is not looked for further back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-long-'))
    mkdirSync(join(dir, 'p'))
    const at = new Date(Date.UTC(2026, 10, 1)).toISOString()
    const pad = JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'z'.repeat(1 << 20) }] } })
    const lines = [JSON.stringify({ type: 'ai-title', aiTitle: 'First' }), ...Array(6).fill(pad), JSON.stringify({ type: 'ai-title', aiTitle: 'Last' })]
    for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: at, message: { content: `p ${i}` } }))
    writeFileSync(join(dir, 'p', `${SID}.jsonl`), lines.join('\n') + '\n')
    const w = new TranscriptWatcher(dir, () => {})
    w.sync([{ id: 'ttl01', cliSessionId: SID }])
    expect(w.get('ttl01')!.title).toBe('Last')
    w.stop()
    rmSync(dir, { recursive: true, force: true })
  })
})
