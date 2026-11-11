// A restart forgets whether a session's turn ended; the poll reads a background shell as busy, so
// an idle session showed "working" until its next prompt (Colin, 11 Nov 2026). The transcript
// settles what core missed.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../src/main/sessions'
import type { Tmux } from '../src/main/tmux'

const SID = '11111111-2222-4333-8444-555555555555'

async function restarted(): Promise<SessionManager> {
  const home = mkdtempSync(join(tmpdir(), 'ws-turn-'))
  const rec = { id: 'abc123', tmuxName: 'ws-abc123', cliSessionId: SID, cwd: home, worktree: false, model: '', permissionMode: '', name: 'cura-b4', createdAt: 1, activeAt: 1, open: false, token: 'a'.repeat(48) }
  writeFileSync(join(home, 'sessions.json'), JSON.stringify({ records: [rec] }))
  const tmux = { hasSession: async () => true } as unknown as Tmux
  const m = new SessionManager({ tmux, env: {}, home, profile: 'test', settingsPath: '', pluginDirs: () => [], register: () => {}, revoke: () => {}, events: { state: () => {}, data: () => {}, exit: () => {} } })
  await m.init()
  return m
}
const status = (m: SessionManager): string => m.view('abc123')!.status

describe('a turn core missed', () => {
  it('the transcript closing it makes a "busy" poll idle, then and after', async () => {
    const m = await restarted()
    m.onFleet([{ sessionId: SID, status: 'busy' }])
    expect(status(m)).toBe('busy')
    m.onTurn('abc123', 'closed')
    expect(status(m)).toBe('idle')
    m.onFleet([{ sessionId: SID, status: 'busy' }])
    expect(status(m)).toBe('idle')
  })
  it('an open turn leaves the poll believed', async () => {
    const m = await restarted()
    m.onTurn('abc123', 'open')
    m.onFleet([{ sessionId: SID, status: 'busy' }])
    expect(status(m)).toBe('busy')
  })
  it('the hooks, when core heard them, win over a transcript read late', async () => {
    const m = await restarted()
    m.onHook('UserPromptSubmit', { session_id: SID } as never)
    m.onTurn('abc123', 'closed')
    m.onFleet([{ sessionId: SID, status: 'busy' }])
    expect(status(m)).toBe('busy')
  })
})
