// Codex beside Claude Code (shared/cli.ts; docs/progress/2026-11-11-codex.md): the TUI's command
// line, the launcher's modes, and a sessions.json from before Codex loading unchanged.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODEX_MODES, cleanCodexMode, cliOf, codexMcpServer, codexServerArgs, codexThreadId, codexTuiArgs } from '@shared/cli'
import { SessionManager } from '../src/main/sessions'
import type { Tmux } from '../src/main/tmux'

const SOCK = '/p/codex/abc123.sock'
const TID = '01a1cbf8-d80b-75f1-8e06-5c98aa3450ca'

describe('codexTuiArgs', () => {
  it('always attaches to the session’s own server and names the folder (the server’s folder wins otherwise)', () => {
    expect(codexTuiArgs({ cwd: '/w', sock: SOCK })).toEqual(['--remote', `unix://${SOCK}`, '-C', '/w'])
  })
  it('a model, a mode and a first prompt, the prompt after --; never --worktree (refused with --remote)', () => {
    const a = codexTuiArgs({ cwd: '/w', sock: SOCK, model: 'gpt-x', mode: 'read-only', prompt: '-rf everything' })
    expect(a).toEqual(['--remote', `unix://${SOCK}`, '-C', '/w', '-m', 'gpt-x', '-s', 'read-only', '-a', 'on-request', '--', '-rf everything'])
    expect(a).not.toContain('--worktree')
  })
  it('resumes a thread by id, without a prompt', () => {
    expect(codexTuiArgs({ cwd: '/w', sock: SOCK, resume: TID, prompt: 'x' })).toEqual(['resume', TID, '--remote', `unix://${SOCK}`, '-C', '/w'])
  })
  it('an id that is not a thread id is a new conversation, never an argument', () => {
    expect(codexTuiArgs({ cwd: '/w', sock: SOCK, resume: '--last' })[0]).toBe('--remote')
    expect(codexThreadId('--last')).toBeNull()
  })
  it('an unknown mode adds no flags', () => {
    expect(codexTuiArgs({ cwd: '/w', sock: SOCK, mode: 'yolo' })).toEqual(['--remote', `unix://${SOCK}`, '-C', '/w'])
  })
  it('the server listens on the same socket', () => {
    expect(codexServerArgs(SOCK)).toEqual(['app-server', '--listen', `unix://${SOCK}`])
  })
  it('a worktree core made is trusted for that server only, the folder in the value (a -c key splits on dots)', () => {
    expect(codexServerArgs(SOCK, ['/r/.workshop/worktrees/a.b'])).toEqual(['app-server', '--listen', `unix://${SOCK}`, '-c', 'projects={"/r/.workshop/worktrees/a.b"={trust_level="trusted"}}'])
  })
  it('the door as an MCP server: the script in the value, the session\'s env names passed through', () => {
    expect(codexMcpServer('/A p.p/bin/workshop-mcp.mjs')).toBe('mcp_servers.workshop={command="node",args=["/A p.p/bin/workshop-mcp.mjs"],env_vars=["WORKSHOP_AUTH","WORKSHOP_HOME","WORKSHOP_SESSION"]}')
    expect(codexServerArgs(SOCK, [], '/b/workshop-mcp.mjs').slice(3)).toEqual(['-c', codexMcpServer('/b/workshop-mcp.mjs')])
  })
  it('a folder with quotes, backslashes or control characters stays one TOML string', () => {
    const v = codexServerArgs(SOCK, ['/r/we"ird\\path\u007f'])[4]
    expect(v).toBe('projects={"/r/we\\"ird\\\\path\\u007f"={trust_level="trusted"}}')
  })
})

describe('the launcher’s Codex modes', () => {
  it('only the approval policies 0.167.1 takes', () => {
    for (const m of CODEX_MODES) {
      const i = m.args.indexOf('-a')
      if (i >= 0) expect(['on-request', 'never']).toContain(m.args[i + 1])
    }
  })
  it('cleans to a known id or none', () => {
    expect(cleanCodexMode('workspace')).toBe('workspace')
    expect(cleanCodexMode('acceptEdits')).toBe('')
    expect(cliOf('codex')).toBe('codex')
    expect(cliOf(undefined)).toBe('claude')
    expect(cliOf('gemini')).toBe('claude')
  })
})

describe('sessions.json from before Codex', () => {
  const load = async (records: unknown[]): Promise<{ m: SessionManager; home: string }> => {
    const home = mkdtempSync(join(tmpdir(), 'ws-cli-'))
    writeFileSync(join(home, 'sessions.json'), JSON.stringify({ records }))
    const tmux = { hasSession: async () => false } as unknown as Tmux
    const m = new SessionManager({ tmux, env: {}, home, profile: 'test', settingsPath: '', pluginDirs: () => [], register: () => {}, revoke: () => {}, events: { state: () => {}, data: () => {}, exit: () => {} } })
    await m.init()
    return { m, home }
  }
  const base = { tmuxName: 'ws-abc123', cwd: '/', worktree: false, model: '', name: 'n', createdAt: 1, open: false, token: 'a'.repeat(48) }

  it('claudeSessionId becomes cliSessionId, and the file is written back without the old name', async () => {
    const { m, home } = await load([{ ...base, id: 'abc123', claudeSessionId: '11111111-2222-4333-8444-555555555555' }])
    expect(m.find('abc123')?.cliSessionId).toBe('11111111-2222-4333-8444-555555555555')
    expect(m.find('abc123')?.cli).toBeUndefined()
    expect(readFileSync(join(home, 'sessions.json'), 'utf8')).not.toContain('claudeSessionId')
  })
  it('a Codex session keeps an empty id (not learnt yet); a Claude session without one is dropped', async () => {
    const { m } = await load([
      { ...base, id: 'c0dec0', tmuxName: 'ws-c0dec0', cli: 'codex', cliSessionId: '' },
      { ...base, id: 'bad000', tmuxName: 'ws-bad000', cliSessionId: '' }
    ])
    expect(m.find('c0dec0')?.cli).toBe('codex')
    expect(m.find('bad000')).toBeNull()
  })
  it('a hook with no session id never lands on a Codex session whose id is still empty', async () => {
    const { m } = await load([{ ...base, id: 'c0dec0', tmuxName: 'ws-c0dec0', cli: 'codex', cliSessionId: '' }])
    m.onHook('UserPromptSubmit', { session_id: '' } as never)
    expect(m.view('c0dec0')!.status).not.toBe('busy')
  })
})
