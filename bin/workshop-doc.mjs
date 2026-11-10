#!/usr/bin/env node
// The preview pane's CLI: `node workshop-doc.mjs open <path> [--line N]`. A session puts a file in
// front of the user in workshop's center column (markdown rendered, task boxes that tick on disk,
// an edit toggle) instead of handing it to whatever app macOS picks. After deck's doc.mjs.
//
// It runs inside a session only: WORKSHOP_HOME (the profile) has the port core is on now, and
// WORKSHOP_AUTH names this session's own header file, so the token never appears on a command
// line. It POSTs to /core/doc. Prints JSON: { ok: true, result: { path, kind, editable } }, or the
// error on stderr with exit 1. A relative path is relative to where it is run (the session's cwd).

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const HELP = `workshop-doc: open a file in workshop's preview pane (read it, tick its boxes, edit it)
  open <path> [--line N]      relative to here; ~/ and absolute work too; path:N works as well`

const argv = process.argv.slice(2)
const args = []
let line
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--help' || a === '-h') {
    console.log(HELP)
    process.exit(0)
  } else if (a === '--line') line = argv[++i]
  else if (a.startsWith('--line=')) line = a.slice(7)
  else args.push(a)
}
const [cmd, ...rest] = args
const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}
if (!cmd || cmd === 'help') {
  console.log(HELP)
  process.exit(cmd ? 0 : 2)
}
if (cmd !== 'open') fail(`unknown command "${cmd}"\n${HELP}`)

let f = rest.join(' ')
if (!f) fail('open which file? e.g. `open notes/checklist.md`')
// `path:42` the way paths are written everywhere else, unless a file is really called that.
const tail = /^(.*):(\d+)$/.exec(f)
if (tail && !existsSync(f)) [f, line] = [tail[1], line ?? tail[2]]
if (line !== undefined && !/^[1-9]\d*$/.test(String(line))) fail(`--line wants a line number, not "${line}"`)
const p = f === '~' ? homedir() : f.startsWith('~/') ? join(homedir(), f.slice(2)) : f
const abs = isAbsolute(p) ? p : resolve(process.cwd(), p)
if (!existsSync(abs)) fail(`no such file: ${abs}`)

let port
let token
try {
  if (!process.env.WORKSHOP_AUTH || !process.env.WORKSHOP_HOME) throw new Error('outside')
  port = readFileSync(join(process.env.WORKSHOP_HOME, 'port'), 'utf8').trim()
  token = /Bearer ([0-9a-f]{48})/.exec(readFileSync(process.env.WORKSHOP_AUTH, 'utf8'))?.[1]
} catch {
  fail('this works only from a Claude session running inside workshop')
}

try {
  const res = await fetch(`http://127.0.0.1:${port}/core/doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ op: 'open', path: abs, line: line === undefined ? null : Number(line) })
  })
  const reply = await res.json()
  if (!reply.ok) fail(reply.error)
  console.log(JSON.stringify(reply.result, null, 2))
} catch (err) {
  fail(`could not reach workshop: ${err.message}`)
}
