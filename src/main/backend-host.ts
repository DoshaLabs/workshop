// The first thing a trusted tile's backend process runs (main/backend.ts forks it with
// utilityProcess). It connects the wire (backend-protocol.ts) to process.parentPort, then loads
// the tile's backend.mjs and calls its default export with the kit, so a backend reads like
//
//   export default function ({ handle, sessions, onSessions, commits, onCommits, emit }) {
//     handle('status', async (body) => ({ ... }))
//   }
//
// and needs no package and no copy of the protocol. Its console goes to the tile's log file.

import { pathToFileURL } from 'node:url'
import { createKit, type FromBackend } from './backend-protocol'

const entry = process.argv[2]
const port = process.parentPort
const post = (m: FromBackend): void => port.postMessage(m)
const { kit, receive, ready } = createKit(post)

port.on('message', (e) => void receive(e.data))

function fatal(err: unknown): void {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`[backend] ${text}`)
  post({ type: 'fatal', error: err instanceof Error ? err.message : String(err) })
  // Let the message go out before the process does.
  setTimeout(() => process.exit(1), 50)
}

process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)

void (async () => {
  if (!entry) throw new Error('no backend program given')
  const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown }
  if (typeof mod.default !== 'function') throw new Error(`${entry}: export a default function ({ handle, sessions, onSessions }) => …`)
  await mod.default(kit)
  ready()
})().catch(fatal)
