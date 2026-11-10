#!/usr/bin/env node
// The door's CLI: `node workshop-tile.mjs <tile-id> <op> [args…]`.
// Prints the tile's answer (a string as is, anything else as JSON) and exits 1 on a refusal.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [id, op, ...args] = process.argv.slice(2)
if (!id || !op) {
  console.error('usage: workshop-tile <tile-id> <op> [args…]')
  process.exit(2)
}

// Inside a session: WORKSHOP_HOME (the profile) has the port core is on now, and WORKSHOP_AUTH is
// this session's own header file, so core knows which session is calling. Outside one: door.json.
let port
let token
try {
  if (process.env.WORKSHOP_AUTH && process.env.WORKSHOP_HOME) {
    port = readFileSync(join(process.env.WORKSHOP_HOME, 'port'), 'utf8').trim()
    token = /Bearer ([0-9a-f]{48})/.exec(readFileSync(process.env.WORKSHOP_AUTH, 'utf8'))?.[1]
  } else {
    const file = process.env.WORKSHOP_DOOR || join(homedir(), 'Library', 'Application Support', 'workshop', 'door.json')
    ;({ port, token } = JSON.parse(readFileSync(file, 'utf8')))
  }
} catch {
  console.error('workshop is not running')
  process.exit(1)
}

try {
  const res = await fetch(`http://127.0.0.1:${port}/tile/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ op, args })
  })
  const reply = await res.json()
  if (!reply.ok) {
    console.error(reply.error)
    process.exit(1)
  }
  console.log(typeof reply.result === 'string' ? reply.result : JSON.stringify(reply.result, null, 2))
} catch (err) {
  console.error(`could not reach workshop: ${err.message}`)
  process.exit(1)
}
