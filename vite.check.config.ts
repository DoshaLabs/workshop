// `workshop tile check` as one plain-node ES module, out/check/tile-check.mjs: the manifest
// validator, the plugin check and the folder checks core itself runs (src/main/tile-check.ts),
// with semver bundled in, so bin/workshop.mjs reuses core's rules instead of copying them and
// needs no TypeScript and no node_modules of its own to run.

import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: {
    outDir: 'out/check',
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    ssr: true,
    lib: { entry: resolve('src/main/tile-check.ts'), formats: ['es'], fileName: () => 'tile-check.mjs' },
    rollupOptions: { external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)] }
  },
  ssr: { noExternal: true }
})
