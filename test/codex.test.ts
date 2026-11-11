// A Codex session read from its app-server (shared/codex.ts): items as the ChatBlocks a session
// tile draws, the thread's status, context use, and which loaded thread is the session's. Item
// shapes are codex-cli 0.167.1's (seen live, docs/progress/2026-11-11-codex.md).
import { describe, expect, it } from 'vitest'
import { applyCodexItem, codexActivity, codexAgentTask, codexChild, codexKillLine, codexAsk, codexCommand, codexContext, codexDecision, codexShell, codexStatus, codexWaitingOnApproval, pickThread } from '@shared/codex'
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

describe('approvals (codexAsk)', () => {
  const T = 'thread-1'
  const cmd = { kind: 'command', threadId: T, turnId: 't', itemId: 'i', startedAtMs: 1, environmentId: null, command: "/bin/zsh -lc 'rm -rf build\nls'", cwd: '/w', reason: 'clean the build' }
  it('a command: the shell unwrapped, whole, with its reason', () => {
    expect(codexAsk('item/commandExecution/requestApproval', cmd, T)).toEqual({ tool: 'Bash', label: 'clean the build', body: 'rm -rf build\nls', answerable: true })
    expect(codexShell("/bin/bash -c 'it'\\''s'")).toBe("it's")
  })
  it('a network approval names the host', () => {
    const a = codexAsk('item/commandExecution/requestApproval', { ...cmd, networkApprovalContext: { host: 'example.com', protocol: 'https' } }, T)
    expect(a?.label).toBe('network: example.com')
  })
  it('a file change shows the files and diffs from the item core saw before the request', () => {
    const item = { type: 'fileChange', id: 'i', status: 'inProgress', changes: [{ path: '/w/a.ts', kind: { type: 'update', move_path: null }, diff: '-a\n+b' }, { path: '/w/b.ts', kind: { type: 'add' }, diff: '+c' }] }
    const p = { threadId: T, turnId: 't', itemId: 'i', startedAtMs: 1, reason: null }
    expect(codexAsk('item/fileChange/requestApproval', p, T, item)).toEqual({ tool: 'Edit', label: '/w/a.ts +1', body: '-a\n+b\n+c', answerable: true })
    expect(codexAsk('item/fileChange/requestApproval', { ...p, reason: 'write' }, T)).toMatchObject({ tool: 'Edit', label: 'write', body: '' })
  })
  it('a permissions request is shown but answerable only in the terminal', () => {
    const a = codexAsk('item/permissions/requestApproval', { threadId: T, turnId: 't', itemId: 'i', environmentId: null, startedAtMs: 1, cwd: '/w', reason: 'needs network', permissions: { network: true } }, T)
    expect(a).toMatchObject({ tool: 'Permissions', label: 'needs network', answerable: false })
  })
  it('another thread\'s approval, and every other request, is not ours to show (or answer)', () => {
    expect(codexAsk('item/commandExecution/requestApproval', { ...cmd, threadId: 'other' }, T)).toBeNull()
    for (const m of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/tool/call', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'execCommandApproval', 'applyPatchApproval'])
      expect(codexAsk(m, { ...cmd }, T)).toBeNull()
    expect(codexAsk('item/commandExecution/requestApproval', null, T)).toBeNull()
  })
  it('the reply: accept once, or decline (the turn goes on)', () => {
    expect(codexDecision(true)).toEqual({ decision: 'accept' })
    expect(codexDecision(false)).toEqual({ decision: 'decline' })
  })
  it('waiting on approval is an active flag', () => {
    expect(codexWaitingOnApproval({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe(true)
    expect(codexWaitingOnApproval({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe(false)
    expect(codexWaitingOnApproval({ type: 'idle' })).toBe(false)
  })
})

describe('subagents (codexChild, codexActivity)', () => {
  const ROOT = 'root-thread'
  // A child thread as 0.167.1's thread/read gave it (seen 11 Nov 2026).
  const child = (extra: Record<string, unknown> = {}) => ({ id: 'kid', parentThreadId: ROOT, agentNickname: 'Beauvoir', agentRole: null, ephemeral: false, model: 'gpt-6-luna', source: { subAgent: { thread_spawn: { parent_thread_id: ROOT, depth: 1, agent_path: '/root/ok_agent', agent_nickname: 'Beauvoir', agent_role: null } } }, ...extra })
  it('a thread spawned by the family is a subagent', () => {
    expect(codexChild(child(), new Set([ROOT]))).toEqual({ id: 'kid', parent: ROOT, nick: 'Beauvoir', role: '', path: '/root/ok_agent', model: 'gpt-6-luna' })
    expect(codexChild(child({ parentThreadId: 'kid' , id: 'grandkid' }), new Set([ROOT, 'kid']))?.parent).toBe('kid') // nested
  })
  it('not a subagent: another family\'s, ephemeral, a review or compaction, or one already followed', () => {
    expect(codexChild(child(), new Set(['other']))).toBeNull()
    expect(codexChild(child({ ephemeral: true }), new Set([ROOT]))).toBeNull()
    expect(codexChild(child({ source: { subAgent: 'review' } }), new Set([ROOT]))).toBeNull()
    expect(codexChild(child({ source: 'vscode' }), new Set([ROOT]))).toBeNull()
    expect(codexChild(child(), new Set([ROOT, 'kid']))).toBeNull()
    expect(codexChild(null, new Set([ROOT]))).toBeNull()
  })
  it('reads a subAgentActivity item', () => {
    const it = { type: 'subAgentActivity', model: 'gpt-6-luna', reasoningEffort: 'medium', id: 'call_1', kind: 'started', agentThreadId: 'kid', agentPath: '/root/ok_agent' }
    expect(codexActivity(it)).toEqual({ thread: 'kid', kind: 'started', path: '/root/ok_agent', model: 'gpt-6-luna' })
    expect(codexActivity({ ...it, kind: 'completed', model: null })).toMatchObject({ kind: 'completed', model: '' })
    expect(codexActivity({ ...it, kind: 'teleported' })).toBeNull()
    expect(codexActivity({ type: 'agentMessage', id: 'x', text: 'hi' })).toBeNull()
  })
  it('the line a killed subagent\'s parent is told', () => {
    expect(codexKillLine({ name: 'Rawls', path: '/root/sleep_then_ok' })).toBe('[workshop] The user stopped your sub-agent “Rawls” (/root/sleep_then_ok). Close it with close_agent if it is still open. No explanation needed: carry on without it, and do not relaunch it unless asked.')
    expect(codexKillLine({ name: 'x', path: '' })).not.toContain('()')
  })
  it('a task in words, from its path', () => {
    expect(codexAgentTask('/root/ok_agent')).toBe('ok agent')
    expect(codexAgentTask('/root/a/find-the-bug')).toBe('find the bug')
    expect(codexAgentTask('')).toBe('')
  })
})
