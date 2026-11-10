#!/usr/bin/env node
// `workshop tile dev <folder>`: load a tile you are writing into workshop. If workshop is already
// running, the folder is handed to it (the app is single-instance) and this exits; if not, workshop
// starts with it. A folder serving its own files reloads on every change; an `entry` pointing at a
// dev server (http://localhost:5173/) reloads through the server's own hot reload.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [cmd, sub, folder] = process.argv.slice(2)

if (cmd !== 'tile' || sub !== 'dev' || !folder) {
  console.error('usage: workshop tile dev <folder>')
  process.exit(2)
}
const dir = resolve(folder)
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
