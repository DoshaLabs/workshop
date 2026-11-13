import { describe, expect, it } from 'vitest'
import { foldActivity, mergeActivity, newFold, recordIds, toolInput, trimActivity, type ActivityEvent, type ActivityFold } from '@shared/activity'

// Lines as Claude Code 2.1.323 writes them (read off real transcripts, and one Haiku turn whose
// PreToolUse hook refused its Bash call).
const T = (s: number): string => new Date(Date.UTC(2026, 10, 12, 22, 0, s)).toISOString()
const at = (s: number): number => Date.parse(T(s))
const user = (s: number, content: unknown, extra: object = {}): object => ({ type: 'user', timestamp: T(s), message: { role: 'user', content }, ...extra })
const assistant = (s: number, id: string, content: unknown[], model = 'claude-opus-5-5'): object => ({ type: 'assistant', timestamp: T(s), message: { id, model, content } })
const toolUse = (id: string, name: string, input: object): object => ({ type: 'tool_use', id, name, input })
const result = (id: string, content: string, isError = false): object => ({ type: 'tool_result', tool_use_id: id, content, is_error: isError })

function fold(lines: object[], sidechain = false): { f: ActivityFold; events: ActivityEvent[] } {
  const f = newFold('abc123')
  for (const l of lines) foldActivity(f, l as Record<string, unknown>, sidechain)
  return { f, events: f.activity.events }
}

describe('activity', () => {
  it('reads a turn: your prompt, model steps from the line before them, a tool call and its end, the answer', () => {
    const { events } = fold([
      user(0, 'look at the map'),
      assistant(2, 'msg_1', [{ type: 'thinking', thinking: '' }]),
      assistant(3, 'msg_1', [toolUse('t1', 'Read', { file_path: '/Users/me/p/src/map.ts' })]),
      user(4, [result('t1', 'export …')]),
      assistant(6, 'msg_2', [{ type: 'text', text: 'Done.' }]),
      { type: 'system', subtype: 'turn_duration', durationMs: 6000, timestamp: T(7) }
    ])
    expect(events).toEqual([
      { kind: 'prompt', at: at(0) },
      { kind: 'step', id: 'msg_1', model: 'claude-opus-5-5', at: at(0), end: at(3) },
      { kind: 'tool', id: 't1', name: 'Read', input: { file_path: '/Users/me/p/src/map.ts' }, at: at(3), end: at(4), status: 'ok' },
      { kind: 'step', id: 'msg_2', model: 'claude-opus-5-5', at: at(4), end: at(6) },
      { kind: 'end', at: at(7), aborted: false }
    ])
  })

  it('keeps only the fields that say what a call touched, never what it wrote', () => {
    expect(toolInput({ file_path: '/a/b.ts', content: 'SECRET', old_string: 'x', new_string: 'y' })).toEqual({ file_path: '/a/b.ts' })
    expect(toolInput({ command: 'curl https://x.dev', description: 'Fetch', run_in_background: true })).toEqual({ command: 'curl https://x.dev', description: 'Fetch' })
    expect(toolInput({ prompt: 'a long brief', description: 'Explore the repo', subagent_type: 'Explore' })).toEqual({ description: 'Explore the repo' })
    expect(toolInput({ id: 42 })).toEqual({ id: 42 })
    expect(toolInput({ id: 'not a short id because it has spaces' })).toEqual({})
    expect(toolInput({ command: 'x'.repeat(9000) }).command).toHaveLength(4000)
  })

  it('tells a hook refusal from an error, and says which tool the hook stopped', () => {
    const { events } = fold([
      user(0, 'run echo hello'),
      assistant(1, 'msg_1', [toolUse('t1', 'Bash', { command: 'echo hello', description: 'Print hello' })]),
      user(2, [result('t1', 'PreToolUse:Bash hook error: no shell today', true)]),
      assistant(3, 'msg_2', [toolUse('t2', 'Bash', { command: 'false' })]),
      user(4, [result('t2', 'Exit code 1', true)]),
      assistant(5, 'msg_3', [toolUse('t3', 'Write', { file_path: '/x' })]),
      user(6, [result('t3', "The user doesn't want to proceed with this tool use.", true)])
    ])
    const tools = events.filter((e) => e.kind === 'tool')
    expect(tools.map((e) => e.kind === 'tool' && e.status)).toEqual(['block', 'err', 'block'])
    expect(events).toContainEqual({ kind: 'hook', what: 'block', event: 'PreToolUse', tool: 'Bash', at: at(2) })
  })

  it('holds a background call open until its task reports, and reads only the id and status of the report', () => {
    const { events } = fold([
      user(0, 'start the dev server'),
      assistant(1, 'msg_1', [toolUse('t1', 'Bash', { command: 'npm run dev', run_in_background: true })]),
      { ...user(2, [result('t1', 'Command running in background with ID: bgq8e2jb6.')]), toolUseResult: { stdout: '', backgroundTaskId: 'bgq8e2jb6' } },
      { type: 'system', subtype: 'turn_duration', timestamp: T(3) },
      user(9, '<task-notification>\n<task-id>bgq8e2jb6</task-id>\n<status>failed</status>\n<summary>Background command "npm run dev" failed: secret output</summary>\n</task-notification>', { origin: { kind: 'task-notification' } })
    ])
    const tool = events.find((e) => e.kind === 'tool')
    expect(tool).toMatchObject({ status: 'err', task: 'bgq8e2jb6', end: at(9) })
    expect(events.at(-1)).toEqual({ kind: 'task', task: 'bgq8e2jb6', status: 'err', at: at(9) })
    expect(events.filter((e) => e.kind === 'prompt')).toHaveLength(1) // the report is not yours
    expect(JSON.stringify(events)).not.toContain('secret output')
  })

  it('reads hooks: context (with its record numbers only), a permission answered, a compaction, an interrupted turn', () => {
    const { events } = fold([
      { type: 'attachment', timestamp: T(0), attachment: { type: 'hook_additional_context', hookName: 'UserPromptSubmit', content: ['[#12] buy milk', '[todo #7] call Sam'] } },
      user(1, 'go'),
      assistant(2, 'msg_1', [toolUse('t1', 'Bash', { command: 'rm -rf build' })]),
      { type: 'attachment', timestamp: T(3), attachment: { type: 'hook_permission_decision', decision: 'allow', toolUseID: 't1', hookEvent: 'PermissionRequest' } },
      { type: 'system', subtype: 'compact_boundary', timestamp: T(50), compactMetadata: { trigger: 'auto', durationMs: 40000 } },
      user(51, [{ type: 'text', text: '[Request interrupted by user]' }])
    ])
    expect(events[0]).toEqual({ kind: 'hook', what: 'context', event: 'UserPromptSubmit', at: at(0), records: ['12', '7'] })
    expect(JSON.stringify(events)).not.toContain('milk')
    expect(events).toContainEqual({ kind: 'hook', what: 'allow', event: 'PermissionRequest', tool: 'Bash', at: at(3) })
    expect(events).toContainEqual({ kind: 'compact', at: at(10), end: at(50) })
    expect(events.at(-1)).toEqual({ kind: 'end', at: at(51), aborted: true })
  })

  it('in a subagent\'s own file, its brief is not a prompt and it has no turns of the session\'s', () => {
    const { events } = fold(
      [
        { ...user(0, 'Find every caller of drawMap'), isSidechain: true },
        { ...assistant(1, 'msg_1', [toolUse('t1', 'Grep', { pattern: 'drawMap' })], 'claude-haiku-5-5'), isSidechain: true },
        { ...user(2, [result('t1', 'map.ts')]), isSidechain: true }
      ],
      true
    )
    expect(events.map((e) => e.kind)).toEqual(['step', 'tool'])
  })

  it('skips what is not the session\'s: a peer\'s message, a shell escape, a synthetic model, a torn line', () => {
    const { events } = fold([
      user(0, 'hello from another session', { origin: { kind: 'peer' } }),
      user(1, '<bash-input>ls</bash-input>'),
      assistant(2, 'msg_x', [{ type: 'text', text: 'No response requested.' }], '<synthetic>'),
      { type: 'user', timestamp: 'not a time', message: { content: 'x' } }
    ])
    expect(events).toEqual([])
  })

  it('trims the oldest, keeping a background task still going however old', () => {
    const f = newFold('abc123')
    f.activity.events.push({ kind: 'tool', id: 'old', name: 'Bash', input: {}, at: 1, status: 'run', task: 'bg1' })
    for (let i = 0; i < 400; i++) f.activity.events.push({ kind: 'prompt', at: 10 + i })
    trimActivity(f.activity, 300)
    expect(f.activity.events).toHaveLength(301)
    expect(f.activity.events[0]).toMatchObject({ id: 'old' })
  })

  it('weaves the wolfpack in, marked with each agent, without their prompts or turns', () => {
    const own = fold([user(0, 'go'), assistant(1, 'm1', [toolUse('a', 'Agent', { description: 'Explore' })])]).f.activity
    const sub = fold([assistant(2, 'm2', [toolUse('b', 'Grep', {})], 'claude-haiku-5-5'), user(3, [result('b', 'x')])], true).f.activity
    sub.events.unshift({ kind: 'prompt', at: at(1) })
    const merged = mergeActivity(own, [{ id: 'a77', running: true, activity: sub }])
    expect(merged.agents).toEqual([{ id: 'a77', running: true }])
    expect(merged.events.map((e) => [e.kind, 'agent' in e ? e.agent : undefined])).toEqual([
      ['prompt', undefined],
      ['step', undefined],
      ['tool', undefined],
      ['step', 'a77'],
      ['tool', 'a77']
    ])
  })

  it('takes record numbers as digits only', () => {
    expect(recordIds('[#123] x [now #9] y [#123] [#abc]')).toEqual(['123', '9'])
  })
})
