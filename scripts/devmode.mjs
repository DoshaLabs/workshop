// Dev mode (src/main/devmode.ts): the installed app runs this in the repo it was built from, with
// the user's own node, and loads core's window from what it builds. It builds the window exactly as
// electron.vite.config.ts's renderer does (core's window only, not the recorder's frame), into the
// folder it is given, and rebuilds on every save. Each finished build prints WORKSHOP_DEVMODE_BUILT,
// a failed one WORKSHOP_DEVMODE_ERROR and the reason on one line; main reloads the window on the
// first and keeps the last good page on the second.
//
//   node scripts/devmode.mjs <out dir>

import { resolve } from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

const out = process.argv[2]
if (!out || !out.startsWith('/')) {
  console.error('usage: node scripts/devmode.mjs <absolute out dir>')
  process.exit(2)
}

const watcher = await build({
  configFile: false,
  root: resolve('src/renderer'),
  base: './',
  logLevel: 'warn',
  plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: {
    outDir: out,
    emptyOutDir: true,
    watch: {},
    chunkSizeWarningLimit: 5000,
    rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
  }
})

watcher.on('event', (e) => {
  if (e.code === 'END') console.log('WORKSHOP_DEVMODE_BUILT')
  else if (e.code === 'ERROR') console.log(`WORKSHOP_DEVMODE_ERROR ${String(e.error?.message ?? e.error).replace(/\s+/g, ' ').slice(0, 400)}`)
  if (e.result?.close) void e.result.close()
})

// Main stops it with SIGTERM; a parent that died (stdin closed) stops it too.
const stop = () => void watcher.close().finally(() => process.exit(0))
process.on('SIGTERM', stop)
process.stdin.on('end', stop)
process.stdin.resume()
