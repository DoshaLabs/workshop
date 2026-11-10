// The smoke test's backend: one op per thing the harness checks (src/main/smoke-backend.ts).
// `count` says how many calls reached it, so the harness can tell an undeclared op never did.
let calls = 0
let heard = 0

export default function ({ handle, sessions, onSessions }) {
  const op = (name, fn) => handle(name, (body) => (calls++, fn(body)))
  onSessions(() => heard++)
  op('echo', (body) => ({ body, pid: process.pid, cwd: process.cwd() }))
  op('env', () => ({ keys: Object.keys(process.env).sort(), values: Object.values(process.env), argv: process.argv.slice(1) }))
  op('slow', () => new Promise((r) => setTimeout(() => r('late'), 2000)))
  op('crash', () => {
    setTimeout(() => process.exit(3), 10)
    return 'bye'
  })
  op('sessions', () => ({ heard, list: sessions() }))
  op('pid', () => process.pid)
  // Not declared in tile.json: core must refuse it before it gets here.
  op('nope', () => 'reached')
  handle('count', () => calls)
}
