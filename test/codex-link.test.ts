// Core's link to a Codex session's app-server (main/codex-link.ts), against the stand-in codex
// (test/fixtures/fake-codex/codex): approvals kept, answered only on purpose and dropped when the
// terminal answers; Stop interrupts the running turn, even one core joined after it started.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexLink, type CodexLinkEvents } from '../src/main/codex-link'
import type { CodexAsk } from '@shared/codex'
import type { AgentView } from '@shared/agents'

const FAKE = join(__dirname, 'fixtures', 'fake-codex', 'codex')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(25)
  }
}

const procs: ChildProcess[] = []
const links: CodexLink[] = []
afterEach(() => {
  for (const l of links.splice(0)) l.stop()
  for (const p of procs.splice(0)) p.kill('SIGTERM')
})

/** A session: the stand-in's server and its TUI (typed into through stdin), in a folder of their own. */
async function session(): Promise<{ sock: string; cwd: string; type: (line: string) => void }> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ws-cl-')))
  const sock = join(cwd, 's.sock')
  const server = spawn(process.execPath, [FAKE, 'app-server', '--listen', `unix://${sock}`], { cwd, stdio: 'ignore' })
  procs.push(server)
  await until('the socket', () => existsSync(sock))
  const tui = spawn(process.execPath, [FAKE, '--remote', `unix://${sock}`, '-C', cwd], { cwd, stdio: ['pipe', 'ignore', 'ignore'] })
  procs.push(tui)
  await until('the TUI', () => existsSync(`${sock}.tui.json`))
  return { sock, cwd, type: (line) => tui.stdin!.write(`${line}\n`) }
}

function link(sock: string, cwd: string) {
  const asks = new Map<string, CodexAsk>()
  const gone: string[] = []
  let agents: AgentView[] = []
  const done: { item: { id?: string; type?: string; command?: string }; at: number | null | undefined }[] = []
  let thread = ''
  let status = ''
  const on: CodexLinkEvents = {
    thread: (t) => (thread = t),
    status: (s) => (status = s),
    turnDone: () => undefined,
    title: () => undefined,
    transcript: () => undefined,
    context: () => undefined,
    ask: (k, a) => asks.set(k, a),
    askGone: (k) => {
      asks.delete(k)
      gone.push(k)
    },
    itemDone: (item, at) => done.push({ item: item as { id?: string }, at }),
    agents: (list) => (agents = list)
  }
  const l = new CodexLink('abc123', sock, cwd, '', on)
  links.push(l)
  l.start()
  return { l, asks, gone, done, agents: () => agents, thread: () => thread, status: () => status }
}

const answers = (sock: string): { id: number; result?: { decision?: string } }[] => (existsSync(`${sock}.answers.json`) ? JSON.parse(readFileSync(`${sock}.answers.json`, 'utf8')) : [])
const interrupts = (sock: string): { turnId?: string }[] => (existsSync(`${sock}.interrupts.json`) ? JSON.parse(readFileSync(`${sock}.interrupts.json`, 'utf8')) : [])

describe('CodexLink: approvals', () => {
  it('keeps an approval, sends nothing by itself, and drops it when the terminal answers', async () => {
    const s = await session()
    const c = link(s.sock, s.cwd)
    await until('joined', () => !!c.thread())
    s.type('ask')
    await until('the ask', () => c.asks.size === 1)
    expect([...c.asks.values()][0]).toMatchObject({ tool: 'Bash', body: 'rm -rf build', answerable: true })
    await sleep(300)
    expect(answers(s.sock)).toEqual([])
    s.type('yes')
    await until('dropped', () => c.asks.size === 0)
    expect(c.gone).toHaveLength(1)
    expect(answers(s.sock)).toEqual([])
    expect(c.l.answer(c.gone[0], true)).toBe(false) // gone: nothing to answer
  })
  it('answers one only when told, once', async () => {
    const s = await session()
    const c = link(s.sock, s.cwd)
    await until('joined', () => !!c.thread())
    s.type('ask')
    await until('the ask', () => c.asks.size === 1)
    const key = [...c.asks.keys()][0]
    expect(c.l.answer(key, false)).toBe(true)
    expect(c.l.answer(key, true)).toBe(false)
    await until('the answer', () => answers(s.sock).length === 1)
    await sleep(200)
    expect(answers(s.sock)).toEqual([{ jsonrpc: '2.0', id: Number(key), result: { decision: 'decline' } }])
  })
  it('never answers a permissions request or a question', async () => {
    const s = await session()
    const c = link(s.sock, s.cwd)
    await until('joined', () => !!c.thread())
    s.type('askperm')
    await until('the ask', () => c.asks.size === 1)
    const [key, a] = [...c.asks][0]
    expect(a).toMatchObject({ tool: 'Permissions', answerable: false })
    expect(c.l.answer(key, true)).toBe(false)
    await sleep(300)
    expect(answers(s.sock)).toEqual([])
  })
})

describe('CodexLink: Stop', () => {
  it('interrupts the turn it saw start', async () => {
    const s = await session()
    const c = link(s.sock, s.cwd)
    await until('joined', () => !!c.thread())
    expect(await c.l.interrupt()).toBe(false) // no turn runs
    s.type('slow')
    await until('busy', () => c.status() === 'busy')
    expect(await c.l.interrupt()).toBe(true)
    await until('idle', () => c.status() === 'idle')
    expect(interrupts(s.sock)).toHaveLength(1)
  })
  it('joined after the turn started, finds it among the thread\'s turns', async () => {
    const s = await session()
    const first = link(s.sock, s.cwd)
    await until('joined', () => !!first.thread())
    s.type('slow')
    await until('busy', () => first.status() === 'busy')
    const late = link(s.sock, s.cwd)
    await until('the late link joins', () => late.status() === 'busy')
    expect(await late.l.interrupt()).toBe(true)
    await until('idle', () => late.status() === 'idle')
    expect(interrupts(s.sock)[0].turnId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('CodexLink: finished commands (for commits)', () => {
  it('hands each finished command over once, live or read back at its turn\'s end if the server never sent it', async () => {
    const s = await session()
    const c = link(s.sock, s.cwd)
    await until('joined', () => !!c.thread())
    s.type('commit')
    await until('the live command', () => c.done.some((d) => d.item.type === 'commandExecution'))
    await sleep(300) // the turn's read-back has run: nothing handed over twice
    expect(c.done.filter((d) => d.item.type === 'commandExecution')).toHaveLength(1)
    s.type('quietcommit')
    await until('the quiet one, read back', () => c.done.filter((d) => d.item.type === 'commandExecution').length === 2)
    const quiet = c.done.filter((d) => d.item.type === 'commandExecution')[1]
    expect(typeof quiet.at).toBe('number')
    expect(c.l.transcript.blocks.filter((b) => b.kind === 'tool')).toHaveLength(2) // its tool line too
  })
})

describe('CodexLink: the wolfpack (subagents as child threads)', () => {
  it('finds a subagent from its parent\'s activity, reads what it said (it answered before core could subscribe), and sees it end', async () => {
    const s = await session()
    const c = link(s.sock, s.cwd)
    await until('joined', () => !!c.thread())
    s.type('spawn')
    await until('the subagent', () => c.agents().length === 1 && c.agents()[0].endedAt !== null && c.agents()[0].found)
    const a = c.agents()[0]
    expect(a).toMatchObject({ kind: 'subagent', cli: 'codex', parent: 'abc123', description: 'Beauvoir', task: 'ok agent', model: 'gpt-fake', lastText: 'OK', paused: false })
    expect(c.l.transcript.blocks.some((b) => b.kind === 'text' && b.text === 'OK')).toBe(false) // its words are not the session's
  })
  it('kill: the tile goes, its turn is interrupted, and it is not followed again', async () => {
    const s = await session()
    const c = link(s.sock, s.cwd)
    await until('joined', () => !!c.thread())
    s.type('spawnslow')
    await until('the running subagent', () => c.agents().length === 1 && c.agents()[0].endedAt === null && c.agents()[0].found)
    const id = c.agents()[0].id
    expect(await c.l.pack.kill(id)).toEqual({ name: 'Beauvoir', path: '/root/ok_agent', running: true })
    expect(c.agents()).toEqual([]) // the tile goes at once
    await until('the session idle', () => c.status() === 'idle')
    expect(interrupts(s.sock).map((x) => (x as { threadId?: string }).threadId)).toEqual([id])
    expect(await c.l.pack.kill(id)).toBeNull() // gone
    await sleep(300)
    expect(c.agents()).toEqual([]) // its later events do not bring it back
  })
  it('a subagent\'s approval is the session\'s to show and answer on a click', async () => {
    const s = await session()
    const c = link(s.sock, s.cwd)
    await until('joined', () => !!c.thread())
    s.type('spawnask')
    await until('the ask', () => c.asks.size === 1)
    const [key, ask] = [...c.asks][0]
    expect(ask).toMatchObject({ tool: 'Bash', body: 'rm -rf dist', label: 'child cleans' })
    expect(c.l.answer(key, true)).toBe(true)
    await until('the answer', () => answers(s.sock).length === 1)
    expect(answers(s.sock)[0].result?.decision).toBe('accept')
  })
  it('a new link joining a session whose subagent still runs takes it up; a finished one is left out', async () => {
    const s = await session()
    const first = link(s.sock, s.cwd)
    await until('joined', () => !!first.thread())
    s.type('spawn')
    await until('the first subagent done', () => first.agents().length === 1 && first.agents()[0].endedAt !== null)
    s.type('spawnslow')
    await until('the second running', () => first.agents().length === 2)
    const late = link(s.sock, s.cwd)
    await until('the late link takes the running one', () => late.agents().length === 1)
    expect(late.agents()[0].endedAt).toBeNull()
    expect(late.agents()[0].id).toBe(first.agents()[1].id)
  })
})
