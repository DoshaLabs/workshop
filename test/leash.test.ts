// The leash and permission prompts: the pure pieces (shared/leash.ts), core's bookkeeping
// (main/leash.ts), and the two hook scripts hooks.ts writes, run for real against a Door.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { answeredInTerminal, describeTool, leashDeny, permissionAnswer, sameCall, waitingOnPermission, DENY_HELD } from '@shared/leash'
import { Leash } from '../src/main/leash'
import { Door } from '../src/main/door'
import { SessionSettings } from '../src/main/hooks'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const tmp = (): string => mkdtempSync(join(tmpdir(), 'ws-leash-'))

describe('describeTool', () => {
  it('shows a Bash call as its description and command', () => {
    expect(describeTool('Bash', { command: 'rm -rf node_modules', description: 'Remove node_modules' })).toEqual({ tool: 'Bash', label: 'Remove node_modules', body: 'rm -rf node_modules' })
  })
  it('shows an edit as the file and the change', () => {
    const d = describeTool('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' })
    expect(d.label).toBe('/a/b.ts')
    expect(d.body).toBe('− x\n+ y')
  })
  it('shows an unknown tool as its input in JSON, and caps what it shows', () => {
    const d = describeTool('mcp__x__y', { a: 1, long: 'z'.repeat(9000) })
    expect(d.body.startsWith('{\n  "a": 1')).toBe(true)
    expect(d.body.length).toBe(4000)
    expect(describeTool(undefined, null)).toEqual({ tool: 'a tool', label: '', body: '' })
  })
  it('puts a label on one line', () => {
    expect(describeTool('Bash', { command: 'x', description: 'two\nlines' }).label).toBe('two lines')
  })
})

describe('the answers core gives the CLI', () => {
  it('a PermissionRequest decision as 2.1.322 reads it', () => {
    expect(JSON.parse(permissionAnswer(true))).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    const deny = JSON.parse(permissionAnswer(false))
    expect(deny.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(typeof deny.hookSpecificOutput.decision.message).toBe('string')
  })
  it('a PreToolUse deny with its reason', () => {
    expect(JSON.parse(leashDeny('why'))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'why' } })
  })
})

describe('reading the fleet poll', () => {
  const waiting = { status: 'waiting', waitingFor: 'permission prompt' }
  it('waiting on a permission prompt is not answered', () => {
    expect(waitingOnPermission(waiting)).toBe(true)
    expect(answeredInTerminal(waiting, true, 60_000)).toBe(false)
  })
  it('busy or idle after it was seen waiting is answered', () => {
    expect(answeredInTerminal({ status: 'busy' }, true, 10)).toBe(true)
    expect(answeredInTerminal({ status: 'idle' }, true, 10)).toBe(true)
  })
  it('a poll that may predate the prompt counts only after the grace', () => {
    expect(answeredInTerminal({ status: 'busy' }, false, 1000)).toBe(false)
    expect(answeredInTerminal({ status: 'busy' }, false, 7000)).toBe(true)
  })
  it('no row, or an unknown status, says nothing', () => {
    expect(answeredInTerminal(undefined, true, 60_000)).toBe(false)
    expect(answeredInTerminal({ status: 'mystery' }, true, 60_000)).toBe(false)
  })
  it('the same call is the same tool and input, in any key order', () => {
    expect(sameCall({ tool_name: 'Bash', tool_input: { a: 1, b: [1, { c: 2 }] } }, { tool_name: 'Bash', tool_input: { b: [1, { c: 2 }], a: 1 } })).toBe(true)
    expect(sameCall({ tool_name: 'Bash', tool_input: { a: 1 } }, { tool_name: 'Bash', tool_input: { a: 2 } })).toBe(false)
    expect(sameCall({ tool_name: 'Bash', tool_input: { a: 1 } }, { tool_name: 'Read', tool_input: { a: 1 } })).toBe(false)
  })
})

describe('Leash', () => {
  const call = { tool_name: 'Bash', tool_input: { command: 'ls' } }
  const never = (): void => undefined

  it('lets a call through at once unless paused', async () => {
    const l = new Leash(tmp(), never)
    expect(await l.hold('abc123', call, never)).toBeNull()
  })

  it('holds a paused session’s call until resume, and shows it held', async () => {
    const changed: string[] = []
    const l = new Leash(tmp(), (id) => changed.push(id))
    l.pause('abc123')
    expect(existsSync(join(l.dir, 'abc123.paused'))).toBe(true)
    let out: string | null | undefined
    void l.hold('abc123', call, never).then((b) => (out = b))
    await sleep(5)
    expect(out).toBeUndefined()
    expect(l.view('abc123')).toMatchObject({ paused: true, held: [{ tool: 'Bash', body: 'ls' }] })
    l.resume('abc123')
    await sleep(5)
    expect(out).toBeNull()
    expect(l.view('abc123')).toMatchObject({ paused: false, held: [] })
    expect(existsSync(join(l.dir, 'abc123.paused'))).toBe(false)
    expect(changed.length).toBeGreaterThan(2)
  })

  it('refuses a held call with the reason, and stays paused', async () => {
    const l = new Leash(tmp(), never)
    l.pause('abc123')
    const p = l.hold('abc123', call, never)
    l.refuseHeld('abc123')
    expect(await p).toBe(leashDeny(DENY_HELD))
    expect(l.paused('abc123')).toBe(true)
  })

  it('a hook that hangs up is no longer held', async () => {
    const l = new Leash(tmp(), never)
    l.pause('abc123')
    let hangUp: () => void = never
    void l.hold('abc123', call, (cb) => (hangUp = cb))
    expect(l.view('abc123').held.length).toBe(1)
    hangUp()
    expect(l.view('abc123').held.length).toBe(0)
  })

  it('a prompt answered from the tile; a second answer finds nothing', async () => {
    const l = new Leash(tmp(), never)
    const p = l.ask('abc123', call, never)
    expect(existsSync(join(l.dir, 'abc123.asking'))).toBe(true)
    const ask = l.view('abc123').asks[0]
    expect(ask).toMatchObject({ tool: 'Bash', body: 'ls' })
    expect(l.answer('abc123', ask.id, true)).toBe(true)
    expect(await p).toBe(permissionAnswer(true))
    expect(l.answer('abc123', ask.id, false)).toBe(false)
    expect(existsSync(join(l.dir, 'abc123.asking'))).toBe(false)
  })

  it('an answer for another session’s prompt does nothing', () => {
    const l = new Leash(tmp(), never)
    void l.ask('abc123', call, never)
    const ask = l.view('abc123').asks[0]
    expect(l.answer('def456', ask.id, true)).toBe(false)
    expect(l.view('abc123').asks.length).toBe(1)
  })

  it('a prompt the terminal answered: the tool finished, the poll moved on, or the turn ended', async () => {
    const l = new Leash(tmp(), never)
    const a = l.ask('abc123', call, never)
    const b = l.ask('abc123', { tool_name: 'Bash', tool_input: { command: 'pwd' } }, never)
    l.settleCall('abc123', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(await a).toBeNull()
    expect(l.view('abc123').asks.map((x) => x.body)).toEqual(['pwd'])
    l.onFleet('abc123', { status: 'waiting', waitingFor: 'permission prompt' })
    expect(l.view('abc123').asks.length).toBe(1)
    l.onFleet('abc123', { status: 'busy' })
    expect(await b).toBeNull()
    const c = l.ask('abc123', call, never)
    l.settle('abc123')
    expect(await c).toBeNull()
  })

  it('an offered prompt (a Codex approval): replies only on Allow or Deny, never when dropped or for the terminal', () => {
    const l = new Leash(tmp(), never)
    const replies: boolean[] = []
    const drop = l.offer('abc123', { tool: 'Bash', label: 'clean', body: 'rm -rf build' }, (allow) => replies.push(allow))
    const v = l.view('abc123').asks
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ tool: 'Bash', body: 'rm -rf build' })
    expect(v[0].terminal).toBeUndefined()
    expect(l.asking('abc123')).toBe(true)
    expect(l.answer('abc123', v[0].id, false)).toBe(true)
    expect(replies).toEqual([false])
    drop() // after the answer: nothing more
    expect(l.answer('abc123', v[0].id, true)).toBe(false)
    expect(replies).toEqual([false])
    // Dropped (the terminal answered): gone, no reply.
    const drop2 = l.offer('abc123', { tool: 'Edit', label: 'a.ts', body: '' }, (allow) => replies.push(allow))
    const id2 = l.view('abc123').asks[0].id
    drop2()
    expect(l.view('abc123').asks).toEqual([])
    expect(l.answer('abc123', id2, true)).toBe(false)
    // Terminal-only: shown, never answerable from the tile.
    l.offer('abc123', { tool: 'Permissions', label: '', body: '{}' }, (allow) => replies.push(allow), { terminal: true })
    const t = l.view('abc123').asks[0]
    expect(t.terminal).toBe(true)
    expect(l.answer('abc123', t.id, true)).toBe(false)
    l.settle('abc123')
    expect(l.view('abc123').asks).toEqual([])
    expect(replies).toEqual([false])
  })

  it('forget and prune clear what a gone session left', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'aaaaaa.paused'), '')
    writeFileSync(join(dir, 'bbbbbb.paused'), '')
    writeFileSync(join(dir, 'bbbbbb.asking'), '')
    writeFileSync(join(dir, 'notes.txt'), '')
    const l = new Leash(dir, never)
    l.prune(new Set(['bbbbbb']))
    expect(existsSync(join(dir, 'aaaaaa.paused'))).toBe(false)
    expect(existsSync(join(dir, 'bbbbbb.paused'))).toBe(true)
    expect(existsSync(join(dir, 'bbbbbb.asking'))).toBe(false)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    l.forget('bbbbbb')
    expect(l.paused('bbbbbb')).toBe(false)
  })

  it('refuses a file name that is not a session id', () => {
    const l = new Leash(tmp(), never)
    expect(() => l.pause('../x')).toThrow()
  })
})

// ---- the hook scripts, run as the CLI runs them, against a real Door ----------------------------

describe('the hook scripts', () => {
  let door: Door | null = null
  afterEach(() => door?.stop())

  const SID = 'aaaaaaaa-0000-0000-0000-000000000001'
  const setup = async () => {
    const home = tmp()
    process.env.CLAUDE_CONFIG_DIR = home // no user settings of anyone's
    const settings = new SessionSettings(home, join(home, 'workshop-tile.mjs'))
    const leash = new Leash(settings.leashDir, () => undefined)
    let requests = 0
    const token = randomBytes(24).toString('hex')
    door = new Door({
      manifest: () => undefined,
      live: () => false,
      answers: () => false,
      deliver: () => undefined,
      ask: async (name, t, payload, gone) => {
        requests++
        const p = payload as { session_id?: string; tool_name?: unknown; tool_input?: unknown }
        if (t !== token || p.session_id !== SID) return null
        return name === 'pretool' ? leash.hold('abc123', p, gone) : leash.ask('abc123', p, gone)
      }
    })
    door.register(token, () => 'one', 'abc123')
    settings.setPort(await door.start())
    const auth = join(home, 'auth.header')
    writeFileSync(auth, `Authorization: Bearer ${token}\n`, { mode: 0o600 })
    const conf = JSON.parse(readFileSync(settings.path, 'utf8'))
    const command = (event: string): string => conf.hooks[event][0].hooks[0].command
    const run = (event: string, input: object) => {
      const k = spawn('/bin/sh', ['-c', command(event)], { env: { ...process.env, WORKSHOP_SESSION: 'abc123', WORKSHOP_AUTH: auth } })
      let out = ''
      k.stdout.on('data', (c) => (out += c))
      const done = new Promise<string>((res) => k.on('exit', () => res(out)))
      k.stdin.end(JSON.stringify({ session_id: SID, hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'ls' }, ...input }))
      return { k, done }
    }
    return { settings, leash, run, requests: () => requests, conf }
  }

  it('an unpaused session’s tool call costs no request', async () => {
    const s = await setup()
    const t0 = Date.now()
    expect(await s.run('PreToolUse', {}).done).toBe('')
    expect(s.requests()).toBe(0)
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  it('the hooks are the ones that wait, and wait longer than the hold', async () => {
    const s = await setup()
    expect(s.conf.hooks.PreToolUse[0].hooks[0].timeout).toBeGreaterThan(3600)
    expect(s.conf.hooks.PermissionRequest[0].hooks[0].timeout).toBeGreaterThan(3600)
    expect(s.conf.hooks.Stop[0].hooks[0].command).toContain('-m 2')
  })

  it('a paused call waits until resume, then goes on with nothing said', async () => {
    const s = await setup()
    s.leash.pause('abc123')
    const { done } = s.run('PreToolUse', {})
    let out: string | undefined
    void done.then((o) => (out = o))
    for (let i = 0; i < 50 && !s.leash.view('abc123').held.length; i++) await sleep(50)
    expect(s.leash.view('abc123').held.length).toBe(1)
    await sleep(300)
    expect(out).toBeUndefined()
    s.leash.resume('abc123')
    expect(await done).toBe('')
  })

  it('a refused call prints the deny', async () => {
    const s = await setup()
    s.leash.pause('abc123')
    const { done } = s.run('PreToolUse', {})
    for (let i = 0; i < 50 && !s.leash.view('abc123').held.length; i++) await sleep(50)
    s.leash.refuseHeld('abc123')
    expect(JSON.parse(await done).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('a held call outlives core going away, and the next core holds it again', async () => {
    const s = await setup()
    s.leash.pause('abc123')
    const { done } = s.run('PreToolUse', {})
    let out: string | undefined
    void done.then((o) => (out = o))
    for (let i = 0; i < 50 && !s.leash.view('abc123').held.length; i++) await sleep(50)
    const port = door!.port
    door!.stop()
    await sleep(1500)
    expect(out).toBeUndefined()
    // The same core comes back on the same port (a restart): the script finds it and is held again.
    await door!.start(port)
    for (let i = 0; i < 60 && !s.leash.view('abc123').held.length; i++) await sleep(50)
    expect(s.leash.view('abc123').held.length).toBe(1)
    s.leash.resume('abc123')
    expect(await done).toBe('')
  })

  it('Esc (TERM to the hook) hangs up its request: core no longer holds it', async () => {
    const s = await setup()
    s.leash.pause('abc123')
    const { k, done } = s.run('PreToolUse', {})
    for (let i = 0; i < 50 && !s.leash.view('abc123').held.length; i++) await sleep(50)
    k.kill('SIGTERM')
    await done
    for (let i = 0; i < 40 && s.leash.view('abc123').held.length; i++) await sleep(50)
    expect(s.leash.view('abc123').held.length).toBe(0)
  })

  it('a permission prompt answered from the tile prints the decision', async () => {
    const s = await setup()
    const { done } = s.run('PermissionRequest', {})
    for (let i = 0; i < 50 && !s.leash.view('abc123').asks.length; i++) await sleep(50)
    const ask = s.leash.view('abc123').asks[0]
    expect(s.leash.answer('abc123', ask.id, true)).toBe(true)
    expect(JSON.parse(await done)).toEqual(JSON.parse(permissionAnswer(true)))
  })

  it('a prompt the terminal answered ends the hook with nothing said', async () => {
    const s = await setup()
    const { done } = s.run('PermissionRequest', {})
    for (let i = 0; i < 50 && !s.leash.view('abc123').asks.length; i++) await sleep(50)
    s.leash.settle('abc123')
    expect(await done).toBe('')
  })

  it('a No in the terminal (TERM) hangs up: the prompt leaves the tile', async () => {
    const s = await setup()
    const { k, done } = s.run('PermissionRequest', {})
    for (let i = 0; i < 50 && !s.leash.view('abc123').asks.length; i++) await sleep(50)
    k.kill('SIGTERM')
    await done
    for (let i = 0; i < 40 && s.leash.view('abc123').asks.length; i++) await sleep(50)
    expect(s.leash.view('abc123').asks.length).toBe(0)
  })

  it('PostToolUse posts only while a prompt is open', async () => {
    const s = await setup()
    const post = s.conf.hooks.PostToolUse.find((g: { matcher?: string }) => !g.matcher).hooks[0].command as string
    expect(post).toContain(`"$WORKSHOP_SESSION".asking`)
    expect(post).toContain('/hook/ran')
  })
})
