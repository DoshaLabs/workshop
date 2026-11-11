#!/usr/bin/env node
// The door as an MCP server, for Codex sessions (phase 3 item 5 of docs/progress/2026-11-11-codex.md).
// Codex has no --plugin-dir, so a Codex session's app-server starts this (stdio, one per thread):
//
//   -c mcp_servers.workshop={command="node",args=["<bin>/workshop-mcp.mjs"],env_vars=["WORKSHOP_AUTH","WORKSHOP_HOME","WORKSHOP_SESSION"]}
//
// Codex clears an MCP server's environment to a few names (seen on 0.167.1), so `env_vars` passes
// the session's own: WORKSHOP_HOME (the profile, with the port core is on now) and WORKSHOP_AUTH (the
// session's 0600 header file, so core knows which session calls; the token is never on a command
// line). It is a relay and decides nothing: `tools/list` is core's (/core/tools: a tool per tile with
// door ops, its skills as the description, and `doc`), and a call goes to the door's own route
// (/tile/<id>, which checks the op, that the tile is on, and the caller) or to /core/doc.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

/** Core's address and this session's token, read again for every call (core may have restarted on another port). */
function door() {
  if (!process.env.WORKSHOP_AUTH || !process.env.WORKSHOP_HOME) throw new Error('this works only from a session running inside workshop')
  const port = readFileSync(join(process.env.WORKSHOP_HOME, 'port'), 'utf8').trim()
  const token = /Bearer ([0-9a-f]{48})/.exec(readFileSync(process.env.WORKSHOP_AUTH, 'utf8'))?.[1]
  if (!/^\d+$/.test(port) || !token) throw new Error('workshop is not running')
  return { port, token }
}

async function post(path, body) {
  const { port, token } = door()
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  return res.json()
}

let tools = []
async function list() {
  const r = await post('/core/tools', {})
  if (!r.ok) throw new Error(r.error)
  tools = Array.isArray(r.result) ? r.result : []
  return tools
}

async function call(name, a) {
  let tool = tools.find((t) => t.name === name)
  if (!tool) tool = (await list()).find((t) => t.name === name)
  if (!tool) return text(`no such tool: ${name}`, true)
  const args = a && typeof a === 'object' ? a : {}
  if (tool.tile) {
    const op = typeof args.op === 'string' ? args.op : ''
    const rest = Array.isArray(args.args) ? args.args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []
    const r = await post(`/tile/${encodeURIComponent(tool.tile)}`, { op, args: rest })
    if (!r.ok) return text(String(r.error), true)
    return text(typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2))
  }
  if (tool.name === 'doc') {
    const f = typeof args.path === 'string' ? args.path : ''
    if (!f) return text('open which file?', true)
    const p = f === '~' ? homedir() : f.startsWith('~/') ? join(homedir(), f.slice(2)) : f
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p)
    if (!existsSync(abs)) return text(`no such file: ${abs}`, true)
    const line = Number.isInteger(args.line) && args.line > 0 ? args.line : null
    const r = await post('/core/doc', { op: 'open', path: abs, line })
    return r.ok ? text(JSON.stringify(r.result)) : text(String(r.error), true)
  }
  return text(`no such tool: ${name}`, true)
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id === undefined || m.id === null) return // a notification (initialized, cancelled): nothing to say
  const reply = (result) => send({ id: m.id, result })
  try {
    switch (m.method) {
      case 'initialize':
        return reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'workshop', version: '1' } })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: (await list()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      case 'tools/call':
        return reply(await call(m.params?.name, m.params?.arguments))
      case 'resources/list':
        return reply({ resources: [] })
      case 'resources/templates/list':
        return reply({ resourceTemplates: [] })
      case 'prompts/list':
        return reply({ prompts: [] })
      default:
        return send({ id: m.id, error: { code: -32601, message: `workshop: no ${m.method}` } })
    }
  } catch (err) {
    if (m.method === 'tools/call') return reply(text(err.message, true))
    return send({ id: m.id, error: { code: -32603, message: err.message } })
  }
})
