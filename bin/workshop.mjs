#!/usr/bin/env node
// The workshop command.
//
// `workshop tile dev <folder>`: load a tile you are writing into workshop. If workshop is already
// running, the folder is handed to it (the app is single-instance) and this exits; if not, workshop
// starts with it. A folder serving its own files reloads on every change; an `entry` pointing at a
// dev server (http://localhost:5173/) reloads through the server's own hot reload.
//
// `workshop tile check <folder> [--json] [--dev]`: everything core checks before it loads a tile
// (the manifest, the page and icon inside the folder, the plugin, no backend), without the app.
// Exit 0 if the tile would load, 1 if not, 2 on a usage error. The rules are core's own, built
// once into out/check/tile-check.mjs (vite.check.config.ts), never copied here.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const [cmd, sub, folder] = argv.filter((a) => !a.startsWith('--'))

const USAGE = 'usage: workshop tile dev <folder>\n       workshop tile check <folder> [--json] [--dev]'

if (cmd !== 'tile' || !['dev', 'check'].includes(sub) || !folder) {
  console.error(USAGE)
  process.exit(2)
}
const dir = resolve(folder)

if (sub === 'check') {
  const built = join(app, 'out', 'check', 'tile-check.mjs')
  if (!existsSync(built)) {
    console.error(`workshop is not built yet: run npm run build in ${app}`)
    process.exit(2)
  }
  const { checkTileFolder, formatCheck } = await import(pathToFileURL(built).href)
  const r = await checkTileFolder(dir, { dev: flags.has('--dev') })
  if (flags.has('--json')) console.log(JSON.stringify({ ok: r.ok, folder: r.folder, id: r.manifest?.id ?? null, version: r.manifest?.version ?? null, permissions: r.manifest?.permissions ?? null, errors: r.errors, warnings: r.warnings, review: r.review ?? null }, null, 2))
  else console.log(formatCheck(r))
  process.exit(r.ok ? 0 : 1)
}

if (!existsSync(join(dir, 'tile.json'))) {
  console.error(`${dir} has no tile.json`)
  process.exit(1)
}
if (!existsSync(join(app, 'out', 'main', 'index.js'))) {
  console.error(`workshop is not built yet: run npm run build in ${app}`)
  process.exit(1)
}

const electron = createRequire(join(app, 'package.json'))('electron')
const child = spawn(electron, [app, `--dev-tile=${dir}`], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
