// The smoke run's part for the + menu's Marketplace tab and install / update / remove (track A, D1,
// D2). A tile is made in a local git repo at runtime and listed in a local index (WORKSHOP_INDEX);
// then the menu is driven the way a person would: install (the prompt, then yes), update with a new
// permission (asked again), update without one (not asked), the refusals (a built-in id, a backend),
// and remove with its data. `workshop tile check` is run from the shell against the same repos.

import type { BrowserWindow, WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, session } from 'electron'
import { tileRepo } from './tile-repo-fixture'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Ctx {
  win: BrowserWindow
  liveByTile: Map<string, { wc: WebContents }>
  userData: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

/** `workshop tile check` as a user runs it, with this Electron as plain node. */
function tileCheck(folder: string): Promise<{ code: number; out: any }> {
  return new Promise((res) => {
    execFile(process.execPath, [join(app.getAppPath(), 'bin', 'workshop.mjs'), 'tile', 'check', folder, '--json'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err, stdout) => {
      let out: unknown = null
      try {
        out = JSON.parse(stdout)
      } catch {
        out = stdout
      }
      res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out })
    })
  })
}

export async function installs(check: Check, { win, liveByTile, userData }: Ctx): Promise<void> {
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const text = (sel: string): Promise<string> => js(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`)
  const click = (sel: string): Promise<unknown> => js(`document.querySelector(${JSON.stringify(sel)}).click(); true`)
  const has = (sel: string): Promise<boolean> => js(`!!document.querySelector(${JSON.stringify(sel)})`)

  const hello = tileRepo(join(userData, 'repos', 'hello'), { id: 'hello-repo', name: 'Hello repo', hint: 'A tile from a git repo' })
  const v1 = hello.commit({ permissions: { storage: true } })
  const clash = tileRepo(join(userData, 'repos', 'clash'), { id: 'wikipedia', name: 'Not Wikipedia' })
  const clashCommit = clash.commit()
  const full = tileRepo(join(userData, 'repos', 'full'), { id: 'full-access', name: 'Full access' })
  const fullCommit = full.commit({}, { 'backend.mjs': 'export default {}\n' })

  // The index, as the real one will look, in a local file.
  const indexFile = join(userData, 'tiles-index.json')
  const entry = (id: string, name: string, repo: string, commit: string, version: string, permissions: object) => ({ id, name, author: 'smoke', hint: `${name}, from the smoke index`, repo, commit, version, permissions, category: 'tools' })
  const writeIndex = (helloCommit: string, version: string, permissions: object): Promise<void> =>
    writeFile(indexFile, JSON.stringify([entry('hello-repo', 'Hello repo', hello.dir, helloCommit, version, permissions), entry('wikipedia', 'Not Wikipedia', clash.dir, clashCommit, '0.1.0', {}), entry('full-access', 'Full access', `file://${full.dir}`, fullCommit, '0.1.0', {}), { id: 'Broken entry' }]))
  await writeIndex(v1, '0.1.0', { storage: true })
  process.env.WORKSHOP_INDEX = indexFile

  // `workshop tile check` from the shell, on the same repos install will read.
  const good = await tileCheck(hello.dir)
  check('tile check: a good folder passes, exit 0, as JSON', good.code === 0 && good.out?.ok === true && good.out?.id === 'hello-repo', JSON.stringify(good).slice(0, 300))
  const bad = await tileCheck(full.dir)
  check('tile check: a backend outside the built-in tiles is refused, exit 1', bad.code === 1 && /trusted tier/.test(bad.out?.errors?.[0] ?? ''), JSON.stringify(bad).slice(0, 300))

  // The menu: three tabs, rows that say what each tile can do and whether it is on.
  await click('.tiles .tile-plus')
  await waitFor('the + menu', () => has('.picker .pick-tabs'))
  const tabs = (await js(`[...document.querySelectorAll('.picker [role=tab]')].map((b) => b.textContent)`)) as string[]
  check('menu: three tabs, Built in, Yours, Marketplace', JSON.stringify(tabs) === '["Built in","Yours","Marketplace"]', JSON.stringify(tabs))
  await click('.picker [data-tab="builtin"]')
  await sleep(150)
  const builtin = await text('.picker-body')
  // Trusted is the smoke's built-in tile with a backend (test/fixtures/trusted, smoke only).
  check('menu: Built in holds Wikipedia, Reminders and Git, each with its permissions in words and whether it is on', builtin.includes('Wikipedia') && builtin.includes('Reminders') && builtin.includes('Git') && builtin.includes('reach en.wikipedia.org') && (await js(`document.querySelectorAll('.picker .pick-state.is-on').length`)) === 4 && !builtin.includes('Probe'), builtin.slice(0, 300))
  const rows = (await js(`[...document.querySelectorAll('.picker .pick-row')].map((r) => [r.querySelector('.pick-name b')?.textContent, r.querySelector('.pick-full')?.textContent ?? ''])`)) as [string, string][]
  check('menu: a built-in tile with a backend says, on a line of its own, that it has full access to this Mac', rows.some(([n, t]) => n === 'Trusted' && /full access to this Mac/i.test(t)) && rows.some(([n, t]) => n === 'Git' && /full access to this Mac/i.test(t)) && rows.filter(([, t]) => t).length === 2, JSON.stringify(rows))
  await click('.picker [data-tab="yours"]')
  await sleep(150)
  const yours = await text('.picker-body')
  check('menu: Yours holds the folders under development, load a folder and make one with Claude', yours.includes('Probe') && yours.includes('Load a folder') && yours.includes('Build a new tile') && yours.includes('Stop loading'), yours.slice(0, 300))

  await click('.picker [data-tab="market"]')
  await waitFor('the index to be listed', () => has('.picker [data-install="hello-repo"]'))
  const market = await text('.picker-body')
  check('marketplace: the index is listed with each tile\'s permissions before anything is fetched', market.includes('Hello repo') && market.includes('keep its own data'), market.slice(0, 300))
  check('marketplace: a tile with a built-in tile\'s id cannot be installed from the index', !(await has('.picker [data-install="wikipedia"]')) && market.includes('built in'))
  check('marketplace: a bad index entry is skipped, and said so', market.includes('1 entry was skipped'), market.slice(-200))
  if (process.env.WORKSHOP_SHOT_MENU) {
    await sleep(400)
    await writeFile(process.env.WORKSHOP_SHOT_MENU, (await win.webContents.capturePage()).toPNG())
  }

  // A backend is refused, and the reason shown.
  await click('.picker [data-install="full-access"]')
  await waitFor('the refusal', async () => (await text('.picker .picker-problem')).length > 0)
  const refusal = await text('.picker .picker-problem')
  check('install: a tile with a backend is refused, with the reason', /trusted tier/.test(refusal) && !(await exists(join(userData, 'tiles', 'full-access'))), refusal)
  const viaRepo = (await js(`window.core.menu.prepare({ repo: ${JSON.stringify(clash.dir)}, commit: ${JSON.stringify(clashCommit)} }).then(() => 'installed', (e) => e.message)`)) as string
  check('install: an installed tile can never take a built-in tile\'s id', /ships with workshop/.test(viaRepo), viaRepo)

  // Install: the prompt in the card first, nothing on until yes.
  await click('.picker [data-install="hello-repo"]')
  await waitFor('the permission prompt', () => has('.picker .pick-prompt'))
  const prompt = await text('.picker .pick-prompt')
  check('install: core asks first, in the menu card, saying what the tile can do', prompt.includes('Install Hello repo?') && prompt.includes('keep its own data') && !liveByTile.has('hello-repo') && !(await exists(join(userData, 'tiles', 'hello-repo'))), prompt)
  if (process.env.WORKSHOP_SHOT_PROMPT) {
    await sleep(300)
    await writeFile(process.env.WORKSHOP_SHOT_PROMPT, (await win.webContents.capturePage()).toPNG())
  }
  await click('.picker [data-confirm]')
  await waitFor('the installed tile to load', () => liveByTile.has('hello-repo'))
  const page = () => liveByTile.get('hello-repo')!.wc
  await waitFor('its page', async () => String(await page().executeJavaScript(`document.getElementById('hello')?.textContent ?? ''`).catch(() => '')).includes('Hello repo from a repo'))
  check('install: the tile is in userData tiles/, without .git, and on', (await exists(join(userData, 'tiles', 'hello-repo', 'tile.json'))) && !(await exists(join(userData, 'tiles', 'hello-repo', '.git'))) && (await has('.tiles [data-face="hello-repo"]')))
  const proxy = await session.fromPartition('persist:tile-hello-repo').resolveProxy('https://en.wikipedia.org/')
  check('install: an installed tile is armed like any other (undeclared hosts go to the dead proxy)', proxy.includes('127.0.0.1:9'), proxy)
  await page().executeJavaScript(`workshop.storage.set('kept', 1)`)
  await waitFor('the menu to show it installed', async () => (await text('.picker-body')).includes('Installed'))

  // Update with a new permission: asked again, and only about what changed.
  const v2 = hello.commit({ version: '0.2.0', permissions: { storage: true, notify: true } })
  await writeIndex(v2, '0.2.0', { storage: true, notify: true })
  await click('.picker [data-tab="yours"]')
  await click('.picker [data-tab="market"]')
  await waitFor('the update button', () => has('.picker [data-update="hello-repo"]'))
  const firstPage = page().id
  await click('.picker [data-update="hello-repo"]')
  await waitFor('the update prompt', () => has('.picker .pick-prompt'))
  const asked = await text('.picker .pick-prompt')
  check('update: a new permission is asked about, and only it', asked.includes('Update Hello repo?') && asked.includes('0.1.0 → 0.2.0') && asked.includes('send you notifications') && !asked.includes('keep its own data'), asked)
  await click('.picker [data-confirm]')
  await waitFor('the new version to load', () => liveByTile.has('hello-repo') && page().id !== firstPage)
  const v2Manifest = JSON.parse(await readFile(join(userData, 'tiles', 'hello-repo', 'tile.json'), 'utf8')) as { version: string }
  check('update: the new commit is in place and its page loaded fresh', v2Manifest.version === '0.2.0')

  // Update that asks for nothing new: straight in, no prompt.
  const v3 = hello.commit({ version: '0.3.0', permissions: { storage: true } })
  await writeIndex(v3, '0.3.0', { storage: true })
  await click('.picker [data-tab="yours"]')
  await click('.picker [data-tab="market"]')
  await waitFor('the update button', () => has('.picker [data-update="hello-repo"]'))
  await click('.picker [data-update="hello-repo"]')
  await waitFor('the quiet update', async () => (await text('.picker-body')).includes('updated to 0.3.0'))
  check('update: one that asks for less goes in without asking', !(await has('.picker .pick-prompt')) && JSON.parse(await readFile(join(userData, 'tiles', 'hello-repo', 'tile.json'), 'utf8')).version === '0.3.0')
  check('update: what it stored is kept', JSON.parse(await readFile(join(userData, 'tile-data', 'hello-repo', 'store.json'), 'utf8')).kept === 1)

  // Remove, ticking "also delete what it stored".
  await click('.picker [data-remove="hello-repo"]')
  await waitFor('the remove confirm', () => has('.picker [data-remove-confirm]'))
  await click('.picker .pick-confirm input[type=checkbox]')
  await click('.picker [data-remove-confirm]')
  await waitFor('the tile to go', () => !liveByTile.has('hello-repo'))
  await sleep(200)
  check('remove: the folder and its data are gone, and the column with it', !(await exists(join(userData, 'tiles', 'hello-repo'))) && !(await exists(join(userData, 'tile-data', 'hello-repo'))) && !(await has('.tiles [data-face="hello-repo"]')))
  check('remove: it is offered from the index again', await has('.picker [data-install="hello-repo"]'))

  await click('.picker .head .ghost')
  delete process.env.WORKSHOP_INDEX
}
