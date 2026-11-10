import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  // Core window's preload only. The preload core injects into every tile is built on its own by
  // vite.tile-preload.config.ts: a sandboxed preload must be ONE file, and two entries here would
  // share a chunk it cannot require.
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: shared }
  }
})
