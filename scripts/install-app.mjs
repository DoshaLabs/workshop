// `npm run install-app`: the first install. Builds the app (`npm run dist`) and copies
// dist/mac-*/workshop.app to /Applications. After that the installed app updates itself: its top
// bar offers "Install update" whenever this repo changes (src/main/updates.ts).
//
// It refuses while an installed workshop is running (quit it first, or use its own "Install
// update", which swaps the app once it has quit). Sessions live in tmux either way, so quitting
// loses nothing; the new app reattaches them.
//
//   npm run install-app                 build, then install to /Applications/workshop.app
//   npm run install-app -- --no-build   install what dist/ already holds
//   WORKSHOP_INSTALL_DIR=<dir>          install somewhere else (a check without touching /Applications)

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'workshop.app'
const dir = process.env.WORKSHOP_INSTALL_DIR ? resolve(process.env.WORKSHOP_INSTALL_DIR) : '/Applications'
const dest = join(dir, NAME)

/** Is a process running from inside `bundle`? */
function running(bundle) {
  const r = spawnSync('pgrep', ['-f', `${bundle}/Contents/MacOS/`], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim().length > 0
}

if (running(dest)) {
  console.error(`${dest} is running. Quit it first (sessions keep running in tmux), or use its own "Install update".`)
  process.exit(1)
}

if (!process.argv.includes('--no-build')) {
  const r = spawnSync('npm', ['run', 'dist'], { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// The newest build: dist/mac-arm64/, dist/mac/ or dist/mac-universal/.
const built = readdirSync(join(root, 'dist'))
  .map((d) => join(root, 'dist', d, NAME))
  .filter((p) => existsSync(p))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
if (!built) {
  console.error(`no ${NAME} under ${join(root, 'dist')}: did npm run dist fail?`)
  process.exit(1)
}

// Checked again: it may have been opened while the build ran.
if (running(dest)) {
  console.error(`${dest} was opened while this built. Quit it and run: npm run install-app -- --no-build`)
  process.exit(1)
}

// Copied beside the old one, then swapped, so a failed copy never leaves a broken app.
rmSync(`${dest}.new`, { recursive: true, force: true })
execFileSync('ditto', [built, `${dest}.new`], { stdio: 'inherit' })
rmSync(`${dest}.old`, { recursive: true, force: true })
if (existsSync(dest)) renameSync(dest, `${dest}.old`)
renameSync(`${dest}.new`, dest)
rmSync(`${dest}.old`, { recursive: true, force: true })
console.log(`installed ${dest} (from ${built})`)
console.log(`open it with: open ${JSON.stringify(dest)}`)
