import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Helpers } from '../src/main/helpers'

const TOKEN = 'b'.repeat(48)
const SID = 'b96eb7df-23b7-4b81-98da-59771cfeb39e'

/** A profile folder with one helper started earlier (as helpers.json keeps it), and the manager over it. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'ws-helpers-'))
  const saved = { id: 'h0a0b0c', parent: 'abc123', short: 'b96eb7df', sessionId: '', name: 'fix it', model: 'haiku', prompt: 'Fix it.\nThen report.', token: TOKEN, startedAt: 1, endedAt: null, lastText: null, stopped: false, blocked: false }
  writeFileSync(join(home, 'helpers.json'), JSON.stringify({ helpers: [saved] }))
  const registered: string[] = []
  const h = new Helpers({ env: {}, home, settingsPath: '', pluginDirs: () => [], register: (t) => registered.push(t), revoke: () => undefined, find: () => null }, () => undefined)
  return { h, registered }
}

describe('helper sessions', () => {
  it('come back from disk with their tokens registered', () => {
    const { h, registered } = setup()
    expect(registered).toEqual([TOKEN])
    expect(h.list()[0]).toMatchObject({ id: 'h0a0b0c', kind: 'helper', parent: 'abc123', description: 'fix it', task: 'Fix it.', found: false, attach: 'b96eb7df' })
    expect(h.byToken(TOKEN)).toMatchObject({ id: 'h0a0b0c', parent: 'abc123' })
    expect(h.byToken('c'.repeat(48))).toBeNull()
  })

  it('take their session id from the first hook that starts with the id --bg printed, and only that one after', () => {
    const { h } = setup()
    h.onHook(TOKEN, 'Stop', { session_id: '00000000-1111-4222-8333-444444444444', last_assistant_message: 'spoof' })
    expect(h.list()[0]).toMatchObject({ found: false, endedAt: null })
    h.onHook(TOKEN, 'UserPromptSubmit', { session_id: SID, prompt: 'Fix it.' })
    expect(h.list()[0].found).toBe(true)
    expect(h.tails()).toEqual([{ id: 'agent:h0a0b0c', path: null, sessionId: SID }])
    h.onHook(TOKEN, 'Stop', { session_id: 'b96eb7df-0000-0000-0000-000000000000', last_assistant_message: 'not mine' })
    expect(h.list()[0].endedAt).toBeNull()
    h.onHook(TOKEN, 'Notification', { session_id: SID, notification_type: 'permission_prompt' })
    expect(h.list()[0].needsYou).toBe(true)
    h.onHook(TOKEN, 'Stop', { session_id: SID, last_assistant_message: 'Done.' })
    expect(h.list()[0]).toMatchObject({ lastText: 'Done.', needsYou: false })
    expect(h.list()[0].endedAt).not.toBeNull()
  })

  it('answer only their own session, and never hand out a token', async () => {
    const { h } = setup()
    await expect(h.call({ id: 'ffffff' } as never, { op: 'result', id: 'h0a0b0c' })).rejects.toThrow(/no helper/)
    const r = (await h.call({ id: 'abc123' } as never, { op: 'list' })) as unknown[]
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(r[0]).toMatchObject({ id: 'h0a0b0c', status: 'working' })
    await expect(h.call({ id: 'abc123' } as never, { op: 'start', prompt: '' })).rejects.toThrow(/a prompt of 1 to/)
  })
})
