// The project's web page (GitHub Pages): site/ built into out/site, which is gitignored and what
// .github/workflows/pages.yml uploads. It imports the app's own Knot (src/shared/knot.ts) and
// Deep Space's sky (src/renderer/src/cosmos.ts), so the page and the app draw from one source.
//
//   npm run site            build it
//   npx vite --config vite.site.config.ts     work on it with reload

import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve('site'),
  // Served from https://doshalabs.github.io/workshop/: every URL relative, so any path works.
  base: './',
  publicDir: false,
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // The page uses the fonts in assets/fonts and the pictures in docs/assets, outside site/.
  server: { fs: { allow: [resolve('.')] } },
  build: { outDir: resolve('out/site'), emptyOutDir: true, assetsInlineLimit: 0 }
})
