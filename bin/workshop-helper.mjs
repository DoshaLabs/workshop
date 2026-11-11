#!/usr/bin/env node
// Helper sessions' CLI (main/helpers.ts): a session hands a piece of work to a background session
// of its own, which shows in its pack tile in workshop, and collects the answer later.
//
// It runs inside a session only: WORKSHOP_HOME (the profile) has the port core is on now, and
// WORKSHOP_AUTH names this session's own header file, so the token never appears on a command
// line. It POSTs to /core/helper. Prints JSON, or the error on stderr with exit 1.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HELP = `workshop-helper: a background session that works for this one, shown under it in workshop
  start [--model haiku|sonnet|opus] [--name <name>] <prompt…>   the prompt as the rest of the line, or - to read it from stdin
  list                                                         this session's helpers: id, name, status
  result <id>                                                  what it said last, once it has finished
  wait <id> [--timeout <seconds>]                              until it finishes (default 600), then its result
  stop <id>                                                    stop it (its conversation is kept: claude attach <id>)`

const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}
const argv = process.argv.slice(2)
const flags = {}
const rest = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--help' || a === '-h') {
    console.log(HELP)
    process.exit(0)
  }
  const m = /^--(model|name|timeout)(?:=(.*))?$/.exec(a)
  if (m) flags[m[1]] = m[2] ?? argv[++i]
  else rest.push(a)
}
const [cmd, ...words] = rest
if (!cmd || cmd === 'help') {
  console.log(HELP)
  process.exit(cmd ? 0 : 2)
}

let port
let token
try {
  if (!process.env.WORKSHOP_AUTH || !process.env.WORKSHOP_HOME) throw new Error('outside')
  port = readFileSync(join(process.env.WORKSHOP_HOME, 'port'), 'utf8').trim()
  token = /Bearer ([0-9a-f]{48})/.exec(readFileSync(process.env.WORKSHOP_AUTH, 'utf8'))?.[1]
  if (!token) throw new Error('no token')
} catch {
  fail('this works only from a Claude session running inside workshop')
}

async function call(body) {
  let reply
  try {
    const res = await fetch(`http://127.0.0.1:${port}/core/helper`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    reply = await res.json()
  } catch (err) {
    fail(`could not reach workshop: ${err.message}`)
  }
  if (!reply.ok) fail(reply.error)
  return reply.result
}

const out = (v) => console.log(JSON.stringify(v, null, 2))
const id = words[0]

if (cmd === 'start') {
  let prompt = words.join(' ')
  if (prompt === '-') prompt = readFileSync(0, 'utf8')
  if (!prompt.trim()) fail('start what? e.g. `start "Write tests for src/parse.ts"`')
  out(await call({ op: 'start', prompt, model: flags.model, name: flags.name }))
} else if (cmd === 'list') {
  out(await call({ op: 'list' }))
} else if (cmd === 'result' || cmd === 'stop') {
  if (!id) fail(`${cmd} which helper? (list shows their ids)`)
  out(await call({ op: cmd, id }))
} else if (cmd === 'wait') {
  if (!id) fail('wait for which helper? (list shows their ids)')
  const until = Date.now() + 1000 * (Number(flags.timeout) > 0 ? Number(flags.timeout) : 600)
  for (;;) {
    const r = await call({ op: 'result', id })
    if (r.status !== 'working' || Date.now() > until) {
      out(r)
      break
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
} else fail(`unknown command "${cmd}"\n${HELP}`)
