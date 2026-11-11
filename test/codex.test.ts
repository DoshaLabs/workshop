// A Codex session read from its app-server (shared/codex.ts): items as the ChatBlocks a session
// tile draws, the thread's status, context use, and which loaded thread is the session's. Item
// shapes are codex-cli 0.167.1's (seen live, docs/progress/2026-11-11-codex.md).
import { describe, expect, it } from 'vitest'
import { applyCodexItem, codexCommand, codexContext, codexStatus, pickThread } from '@shared/codex'
import { TRANSCRIPT_KEEP, emptyTranscript } from '@shared/transcript'

const user = (id: string, text: string) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text, text_elements: [] }] })
const agent = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null, questions: null })
const exec = (id: string, status: string, exitCode: number | null = null) => ({ type: 'commandExecution', id, command: "/bin/zsh -lc 'touch hello.txt'", cwd: '/w', status, exitCode, aggregatedOutput: null, commandActions: [], processId: null, source: 'agent', pluginId: null, scriptPath: null, durationMs: null })

describe('applyCodexItem', () => {
  it('a prompt, a command and the reply, as a Claude Code transcript would show them', () => {
    const t = emptyTranscript('abc123')
    expect(applyCodexItem(t, user('u1', 'make hello.txt'), false)).toBe(false) // a prompt shows once complete
    expect(applyCodexItem(t, user('u1', 'make hello.txt'), true)).toBe(true)
    expect(applyCodexItem(t, exec('c1', 'inProgress'), false)).toBe(true)
    expect(t.blocks[1]).toMatchObject({ kind: 'tool', id: 'c1', name: 'Bash', label: 'touch hello.txt', done: false, error: false })
    expect(applyCodexItem(t, exec('c1', 'completed', 0), true)).toBe(true)
    expect(t.blocks[1]).toMatchObject({ done: true, error: false })
    expect(applyCodexItem(t, agent('a1', 'Made **hello.txt**.'), true)).toBe(true)
    expect(t.blocks.map((b) => b.kind)).toEqual(['user', 'tool', 'text'])
    expect(t.blocks[2]).toMatchObject({ text: 'Made **hello.txt**.' })
  })
  it('a command that failed, was declined, or exited non-zero is an error', () => {
    for (const [status, code] of [['failed', null], ['declined', null], ['completed', 1]] as const) {
      const t = emptyTranscript('x')
      applyCodexItem(t, exec('c', status, code), true)
      expect(t.blocks[0]).toMatchObject({ error: true, done: true })
    }
  })
  it('a file change names its file, and how many more', () => {
    const t = emptyTranscript('x')
    applyCodexItem(t, { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/w/src/a.ts', kind: 'update', diff: '' }, { path: '/w/b.ts', kind: 'add', diff: '' }] }, true)
    expect(t.blocks[0]).toMatchObject({ kind: 'tool', name: 'Edit', label: 'a.ts +1', path: '/w/src/a.ts', done: true })
  })
  it('reasoning, plans, compaction and unknown items are not the conversation', () => {
    const t = emptyTranscript('x')
    for (const it of [{ type: 'reasoning', id: 'r', summary: ['x'], content: [] }, { type: 'plan', id: 'p', text: 'x' }, { type: 'contextCompaction', id: 'c' }, { type: 'brandNew', id: 'n' }, null, 'junk', { type: 'agentMessage' }]) {
      expect(applyCodexItem(t, it, true)).toBe(false)
    }
    expect(t.blocks).toHaveLength(0)
  })
  it('the same message from history and then live is shown once', () => {
    const t = emptyTranscript('x')
    applyCodexItem(t, agent('a1', 'done'), true)
    expect(applyCodexItem(t, agent('a1', 'done'), true)).toBe(false)
    expect(t.blocks).toHaveLength(1)
  })
  it('keeps the tail', () => {
    const t = emptyTranscript('x')
    for (let i = 0; i < TRANSCRIPT_KEEP + 10; i++) applyCodexItem(t, agent(`a${i}`, `line ${i}`), true)
    expect(t.blocks).toHaveLength(TRANSCRIPT_KEEP)
    expect(t.blocks.at(-1)).toMatchObject({ text: `line ${TRANSCRIPT_KEEP + 9}` })
  })
})

describe('codexCommand', () => {
  it('drops the shell Codex wraps every command in', () => {
    expect(codexCommand("/bin/zsh -lc 'touch hello.txt'")).toBe('touch hello.txt')
    expect(codexCommand('/bin/bash -c "npm test"')).toBe('npm test')
    expect(codexCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'")
    expect(codexCommand('git status')).toBe('git status')
  })
})

describe('codexStatus', () => {
  it('idle, working, and waiting on you', () => {
    expect(codexStatus({ type: 'idle' })).toEqual({ status: 'idle', needsYou: false })
    expect(codexStatus({ type: 'active', activeFlags: [] })).toEqual({ status: 'busy', needsYou: false })
    expect(codexStatus({ type: 'active', activeFlags: ['waitingOnApproval'] })).toEqual({ status: 'blocked', needsYou: true })
    expect(codexStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toEqual({ status: 'blocked', needsYou: true })
    expect(codexStatus({ type: 'systemError' })).toEqual({ status: 'dead', needsYou: true })
    expect(codexStatus({ type: 'what' })).toBeNull()
  })
})

describe('codexContext', () => {
  it('the last turn against the window, as seen live (13,931 of 258,400)', () => {
    expect(codexContext({ total: {}, last: { totalTokens: 13931 }, modelContextWindow: 258400 })).toBe(5)
    expect(codexContext({ last: { totalTokens: 10 }, modelContextWindow: null })).toBeNull()
    expect(codexContext({ last: { totalTokens: 999 }, modelContextWindow: 100 })).toBe(100)
  })
})

describe('pickThread', () => {
  const T = (o: Record<string, unknown>) => ({ id: 'x', cwd: '/w', ephemeral: false, parentThreadId: null, createdAt: 1, ...o })
  it('the session’s own: in its folder, not a subagent’s, not ephemeral, the newest', () => {
    const got = pickThread([T({ id: 'side', ephemeral: true, createdAt: 9 }), T({ id: 'child', parentThreadId: 'main', createdAt: 8 }), T({ id: 'elsewhere', cwd: '/other', createdAt: 7 }), T({ id: 'old', createdAt: 2 }), T({ id: 'main', createdAt: 5 })], '/w')
    expect(got?.id).toBe('main')
  })
  it('none when nothing fits yet', () => {
    expect(pickThread([T({ ephemeral: true })], '/w')).toBeNull()
    expect(pickThread([], '/w')).toBeNull()
  })
})
