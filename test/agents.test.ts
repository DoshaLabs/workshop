import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentTracker } from '../src/main/agents'
import { agentKind, agentName, agentStatus, typedPrompt } from '@shared/agents'
import { applyLine, emptyTranscript } from '@shared/transcript'
import type { SessionRecord } from '@shared/sessions'

const SID = '11111111-2222-4333-8444-555555555555'
const rec = { id: 'abc123', claudeSessionId: SID } as SessionRecord

/** A projects folder laid out as Claude Code 2.1.322 writes it, and a tracker over it. */
function setup() {
  const projects = mkdtempSync(join(tmpdir(), 'ws-agents-'))
  const proj = join(projects, '-tmp-work')
  mkdirSync(proj, { recursive: true })
  const parentTranscript = join(proj, `${SID}.jsonl`)
  writeFileSync(parentTranscript, '')
  const subagents = join(proj, SID, 'subagents')
  const pasted: [string, string][] = []
  let open = true
  const tails: { id: string; path: string | null }[][] = []
  const t = new AgentTracker({ open: () => open, paste: (id, text) => pasted.push([id, text]) }, projects, (l) => tails.push(l), () => undefined)
  const look = (): void => (t as unknown as { look(): void }).look()
  const write = (id: string, meta: Record<string, unknown>, dir = subagents, age = 0): string => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `agent-${id}.jsonl`)
    writeFileSync(file, JSON.stringify({ isSidechain: true, type: 'user', message: { role: 'user', content: 'Read the note.' } }) + '\n')
    writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta))
    if (age) utimesSync(file, new Date(Date.now() - age), new Date(Date.now() - age))
    return file
  }
  const hook = (event: 'SubagentStart' | 'SubagentStop' | 'UserPromptSubmit', extra: Record<string, unknown> = {}): void =>
    t.onHook(rec, event, { session_id: SID, transcript_path: parentTranscript, ...extra })
  const one = (id: string) => t.list().find((a) => a.id === id)
  return { t, look, write, hook, one, pasted, tails, subagents, setOpen: (v: boolean) => (open = v) }
}

let made: AgentTracker[] = []
afterEach(() => {
  for (const t of made) t.stop()
  made = []
})
const tracked = () => {
  const s = setup()
  made.push(s.t)
  return s
}

describe('subagents', () => {
  it('never guesses the transcript: null until the file is seen, then the sidecar names it', () => {
    const s = tracked()
    s.hook('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' })
    expect(s.one('a1')).toMatchObject({ found: false, endedAt: null, parent: 'abc123', type: 'general-purpose' })
    expect(s.tails.at(-1)).toEqual([{ id: 'agent:a1', path: null }])
    s.look()
    expect(s.one('a1')!.found).toBe(false)
    const file = s.write('a1', { agentType: 'general-purpose', description: 'read note', requestShape: 'background', pickedEffortModel: 'claude-haiku-5-5', finished: false })
    s.look()
    expect(s.one('a1')).toMatchObject({ found: true, description: 'read note', background: true, model: 'claude-haiku-5-5' })
    expect(s.tails.at(-1)).toEqual([{ id: 'agent:a1', path: file }])
  })

  it('finds a Workflow agent two folders down, with its phase', () => {
    const s = tracked()
    s.hook('SubagentStart', { agent_id: 'w1', agent_type: 'workflow-subagent' })
    s.write('w1', { agentType: 'workflow-subagent', description: 'Build it', workflowPhase: 'Build' }, join(s.subagents, 'workflows', 'wf_run1'))
    s.look()
    expect(s.one('w1')).toMatchObject({ found: true, description: 'Build it', phase: 'Build' })
    expect(agentKind(s.one('w1')!)).toBe('workflow · Build')
  })

  it('ends on the stop hook, whose path wins, with what it said last', () => {
    const s = tracked()
    s.hook('SubagentStart', { agent_id: 'a2', agent_type: 'Explore' })
    const file = s.write('a2', { agentType: 'Explore', description: 'look around' })
    s.hook('SubagentStop', { agent_id: 'a2', agent_type: 'Explore', agent_transcript_path: file, last_assistant_message: 'Found it.' })
    expect(s.one('a2')).toMatchObject({ found: true, lastText: 'Found it.' })
    expect(s.one('a2')!.endedAt).not.toBeNull()
    expect(agentStatus(s.one('a2')!)).toBe('idle')
  })

  it('makes no tile for an internal fork (a stop, no transcript), but one for a missed start with a transcript', () => {
    const s = tracked()
    s.hook('SubagentStop', { agent_id: 'fork', agent_transcript_path: join(s.subagents, 'agent-fork.jsonl') })
    expect(s.one('fork')).toBeUndefined()
    const file = s.write('late', { description: 'missed start' })
    s.hook('SubagentStop', { agent_id: 'late', agent_transcript_path: file })
    expect(s.one('late')).toMatchObject({ found: true, description: 'missed start' })
  })

  it('is finished by its sidecar once its transcript is quiet, when no stop ever comes; a later tool call takes that back', async () => {
    const s = tracked()
    s.hook('SubagentStart', { agent_id: 'q', agent_type: 'general-purpose' })
    s.write('q', { finished: true }) // written just now: not quiet yet
    s.look()
    expect(s.one('q')!.endedAt).toBeNull()
    s.write('q', { finished: true }, s.subagents, 60_000)
    s.look()
    expect(s.one('q')!.endedAt).not.toBeNull()
    await s.t.preTool(rec, { session_id: SID, agent_id: 'q', tool_name: 'Read' }, () => undefined)
    expect(s.one('q')!.endedAt).toBeNull()
  })

  it('a finished one stays until a prompt you typed, not a background result coming back', () => {
    const s = tracked()
    s.hook('SubagentStart', { agent_id: 'f' })
    s.hook('SubagentStop', { agent_id: 'f', agent_transcript_path: s.write('f', {}) })
    s.hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>f</task-id>' })
    expect(s.one('f')).toBeDefined()
    s.hook('UserPromptSubmit', { prompt: 'next thing' })
    expect(s.one('f')).toBeUndefined()
    expect(typedPrompt('  <task-notification>')).toBe(false)
  })

  it('goes with its parent', () => {
    const s = tracked()
    s.hook('SubagentStart', { agent_id: 'p' })
    s.t.keepParents(new Set(['other']))
    expect(s.t.list()).toEqual([])
  })
})

describe('kill and pause', () => {
  it('kill takes the tile at once, tells the parent, and refuses its later calls and hooks', async () => {
    const s = tracked()
    s.hook('SubagentStart', { agent_id: 'k', agent_type: 'general-purpose' })
    s.t.kill('k')
    expect(s.one('k')).toBeUndefined()
    expect(s.pasted).toHaveLength(1)
    expect(s.pasted[0][0]).toBe('abc123')
    expect(s.pasted[0][1]).toMatch(/^\[workshop\] The user stopped your subagent “general-purpose” \(id k\)/)
    const d = await s.t.preTool(rec, { session_id: SID, agent_id: 'k', tool_name: 'Read' }, () => undefined)
    expect(d?.hookSpecificOutput.permissionDecision).toBe('deny')
    s.hook('SubagentStop', { agent_id: 'k', agent_transcript_path: s.write('k', {}) })
    expect(s.one('k')).toBeUndefined()
  })

  it('kill of a finished one only clears it; the parent is not told', () => {
    const s = tracked()
    s.hook('SubagentStart', { agent_id: 'd' })
    s.hook('SubagentStop', { agent_id: 'd', agent_transcript_path: s.write('d', {}) })
    s.t.kill('d')
    expect(s.one('d')).toBeUndefined()
    expect(s.pasted).toEqual([])
  })

  it('pause needs the leash; with it, the next call waits until resume, and a kill refuses the held call', async () => {
    const s = tracked()
    s.hook('SubagentStart', { agent_id: 'h' })
    s.write('h', {})
    s.look()
    expect(() => s.t.pause('h')).toThrow(/leash/)
    s.t.setLeash(true)
    s.t.pause('h')
    expect(agentStatus(s.one('h')!)).toBe('blocked')
    let answered: unknown = 'waiting'
    const held = s.t.preTool(rec, { session_id: SID, agent_id: 'h', tool_name: 'Bash' }, () => undefined).then((d) => (answered = d))
    await Promise.resolve()
    expect(answered).toBe('waiting')
    expect(s.one('h')!.held).toBe(true)
    s.t.resume('h')
    await held
    expect(answered).toBeNull()
    expect(s.one('h')!.held).toBe(false)
    s.t.pause('h')
    const second = s.t.preTool(rec, { session_id: SID, agent_id: 'h', tool_name: 'Bash' }, () => undefined)
    s.t.kill('h')
    expect((await second)?.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('a held call is let go when the CLI gives up on the hook', async () => {
    const s = tracked()
    s.t.setLeash(true)
    s.hook('SubagentStart', { agent_id: 'g' })
    s.t.pause('g')
    let gone: () => void = () => undefined
    const held = s.t.preTool(rec, { session_id: SID, agent_id: 'g' }, (cb) => (gone = cb))
    gone()
    expect(await held).toBeNull()
  })

  it('a session\'s own call (no agent_id) is never the tracker\'s', async () => {
    const s = tracked()
    expect(await s.t.preTool(rec, { session_id: SID, tool_name: 'Bash' }, () => undefined)).toBeNull()
  })
})

describe('a subagent\'s transcript', () => {
  it('is all sidechain lines, which only a subagent tail shows', () => {
    const line = JSON.stringify({ isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
    const session = emptyTranscript('s')
    expect(applyLine(session, line)).toBe(false)
    const agent = emptyTranscript('agent:a')
    expect(applyLine(agent, line, true)).toBe(true)
    expect(agent.blocks[0]).toMatchObject({ kind: 'text', text: 'hi' })
  })

  it('names a nameless agent by its brief', () => {
    expect(agentName({ description: '', task: '', type: 'Explore' })).toBe('Explore')
    expect(agentName({ description: 'read note', task: 'x', type: 'Explore' })).toBe('read note')
  })
})
