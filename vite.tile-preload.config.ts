// The tile bridge (src/preload/tile.ts) as one self-contained CommonJS file, out/preload/tile.js.
// Tiles' webviews are sandboxed, and a sandboxed preload can require only 'electron'.

import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: {
    outDir: 'out/preload',
    emptyOutDir: false,
    minify: false,
    target: 'node22',
    lib: { entry: resolve('src/preload/tile.ts'), formats: ['cjs'], fileName: () => 'tile.js' },
    rollupOptions: { external: ['electron'] }
  }
})
