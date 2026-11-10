import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  // Two programs: core's main process, and backend-host, the first thing each trusted tile's
  // backend process runs (main/backend.ts forks it with utilityProcess).
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'backend-host': resolve('src/main/backend-host.ts') } } }
  },
  // Core window's preload only. The preload core injects into every tile is built on its own by
  // vite.tile-preload.config.ts: a sandboxed preload must be ONE file, and two entries here would
  // share a chunk it cannot require.
  // It must not empty out/preload: `npm run dev` builds tile.js there first, and a dev build that
  // wiped it left every tile without `window.workshop`. (A change to src/preload/tile.ts needs
  // `npm run dev` again; this watcher does not rebuild it.)
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { emptyOutDir: false }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: shared }
  }
})
