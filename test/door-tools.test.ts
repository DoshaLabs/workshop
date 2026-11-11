// The door as MCP tools for Codex sessions: the tools core lists (shared/door-tools.ts), and the
// relay a session's app-server starts (bin/workshop-mcp.mjs), run against a stand-in core.
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { DESCRIPTION_MAX, DOC_TOOL, doorTools, parseSkill, tileTool, toolName, type DoorTile } from '@shared/door-tools'

const reminders: DoorTile = {
  id: 'reminders',
  name: 'Reminders',
  hint: 'To-dos, notes and a log, by project',
  ops: ['add', 'list', 'done'],
  skills: [{ name: 'reminders', description: 'Write reminders to the tile.', body: 'Run `node "$WORKSHOP_TILE" reminders add "<text>"`.' }]
}

describe('door tools', () => {
  it('a tile with door ops is one tool: its ops, its skill\'s words, how the CLI maps to it', () => {
    const t = tileTool(reminders)!
    expect(t.name).toBe('reminders')
    expect(t.tile).toBe('reminders')
    expect(t.description).toContain("The workshop's Reminders tile: To-dos, notes and a log, by project.")
    expect(t.description).toContain('"add", "list", "done"')
    expect(t.description).toContain('node "$WORKSHOP_TILE" reminders <op>')
    expect(t.description).toContain('Write reminders to the tile.')
    expect(t.description).toContain('reminders add "<text>"')
    expect(t.inputSchema).toMatchObject({ type: 'object', required: ['op'], properties: { op: { enum: ['add', 'list', 'done'] }, args: { type: 'array' } } })
  })
  it('no ops, no tool; a long skill is cut', () => {
    expect(tileTool({ ...reminders, ops: [] })).toBeNull()
    expect(tileTool({ ...reminders, skills: [{ name: 's', description: '', body: 'x'.repeat(20_000) }] })!.description.length).toBe(DESCRIPTION_MAX)
  })
  it('every tile by id, then doc; a tile cannot take doc\'s name or another\'s', () => {
    const list = doorTools([{ ...reminders, id: 'zeta', name: 'Z' }, reminders, { ...reminders, id: 'doc', name: 'Doc' }])
    expect(list.map((t) => t.name)).toEqual(['reminders', 'zeta', 'doc'])
    expect(list[2]).toBe(DOC_TOOL)
  })
  it('names are MCP\'s', () => {
    expect(toolName('git')).toBe('git')
    expect(toolName('a.b c')).toBe('a_b_c')
  })
  it('reads a SKILL.md', () => {
    expect(parseSkill('---\nname: wikipedia\ndescription: "Put an article up."\n---\n\n# Use\nbody', 'x')).toEqual({ name: 'wikipedia', description: 'Put an article up.', body: '# Use\nbody' })
    expect(parseSkill('no frontmatter', 'x')).toEqual({ name: 'x', description: '', body: 'no frontmatter' })
  })
})

describe('bin/workshop-mcp.mjs (the relay)', () => {
  const TOKEN = 'ab'.repeat(24)
  const stops: (() => void)[] = []
  afterEach(() => {
    for (const s of stops.splice(0)) s()
  })

  async function setup() {
    const seen: { url: string; auth: string; body: unknown }[] = []
    const body = (req: IncomingMessage): Promise<string> => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)) })
    const server = createServer(async (req, res) => {
      const b = JSON.parse((await body(req)) || '{}')
      seen.push({ url: req.url ?? '', auth: String(req.headers.authorization), body: b })
      const ok = (result: unknown) => res.end(JSON.stringify({ ok: true, result }))
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.end(JSON.stringify({ ok: false, error: 'who are you' }))
      if (req.url === '/core/tools') return ok(doorTools([reminders]))
      if (req.url === '/tile/reminders') return b.op === 'list' ? ok([{ text: 'milk' }]) : res.end(JSON.stringify({ ok: false, error: 'turn on the Reminders tile' }))
      if (req.url === '/core/doc') return ok({ path: b.path, kind: 'markdown', editable: true })
      res.end(JSON.stringify({ ok: false, error: 'no' }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ws-mcp-')))
    writeFileSync(join(home, 'port'), String(port))
    writeFileSync(join(home, 'auth'), `Authorization: Bearer ${TOKEN}\n`)
    writeFileSync(join(home, 'notes.md'), '# n\n')
    const p = spawn(process.execPath, [join(__dirname, '..', 'bin', 'workshop-mcp.mjs')], { cwd: home, env: { PATH: process.env.PATH ?? '', WORKSHOP_HOME: home, WORKSHOP_AUTH: join(home, 'auth') }, stdio: ['pipe', 'pipe', 'inherit'] })
    stops.push(() => p.kill(), () => server.close())
    const waiting = new Map<number, (m: { result?: any; error?: any }) => void>()
    createInterface({ input: p.stdout! }).on('line', (l) => {
      const m = JSON.parse(l)
      waiting.get(m.id)?.(m)
    })
    let n = 1
    const rpc = (method: string, params: unknown = {}): Promise<{ result?: any; error?: any }> =>
      new Promise((r) => {
        const id = n++
        waiting.set(id, r)
        p.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    return { rpc, seen, home }
  }

  it('speaks MCP: initialize, tools from core, a tile call through the door\'s route as the session', async () => {
    const { rpc, seen, home } = await setup()
    expect((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0' } })).result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
    const tools = (await rpc('tools/list')).result.tools
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['reminders', 'doc'])
    expect(tools[0]).not.toHaveProperty('tile') // what MCP's tools/list carries, nothing of core's routing
    expect((await rpc('tools/call', { name: 'reminders', arguments: { op: 'list', args: [] } })).result).toEqual({ content: [{ type: 'text', text: JSON.stringify([{ text: 'milk' }], null, 2) }] })
    expect(seen.find((x) => x.url === '/tile/reminders')).toMatchObject({ auth: `Bearer ${TOKEN}`, body: { op: 'list', args: [] } })
    // A refusal is the tool's error, in the door's words.
    expect((await rpc('tools/call', { name: 'reminders', arguments: { op: 'add', args: ['x', 3] } })).result).toEqual({ content: [{ type: 'text', text: 'turn on the Reminders tile' }], isError: true })
    expect(seen.filter((x) => x.url === '/tile/reminders')[1].body).toEqual({ op: 'add', args: ['x', '3'] })
    // doc: relative to the session's folder.
    const d = (await rpc('tools/call', { name: 'doc', arguments: { path: 'notes.md', line: 2 } })).result
    expect(d.isError).toBeUndefined()
    expect(seen.find((x) => x.url === '/core/doc')?.body).toEqual({ op: 'open', path: join(home, 'notes.md'), line: 2 })
    expect((await rpc('tools/call', { name: 'doc', arguments: { path: 'nope.md' } })).result.isError).toBe(true)
    expect((await rpc('tools/call', { name: 'nothing', arguments: {} })).result.isError).toBe(true)
    expect((await rpc('resources/list')).result).toEqual({ resources: [] })
    expect((await rpc('bogus')).error.code).toBe(-32601)
  })
})
