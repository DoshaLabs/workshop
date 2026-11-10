// The smoke run's part for the Git tile's Worktrees tab. A temp repository with three worktrees
// (feat: one commit, clean; busy: one commit, its session mid-turn; old: merged, no session) and
// sessions in the main tree, feat and busy. From the tile's own page: a row per worktree with its
// session, branch, ahead / behind and clean or dirty, the stale filter, the overlap warning, the
// two-click arm (one click does nothing), a merge refused while a session is busy, a clean merge,
// remove of the merged one, and `sessions.launch`: the launcher filled in from a real click,
// nothing started, refused from a script's click, and absent from a tile without the permission.

import type { BrowserWindow, WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Backends } from './backend'
import type { CoreSessions } from './core-sessions'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Ctx {
  win: BrowserWindow
  liveByTile: Map<string, { wc: WebContents }>
  core: CoreSessions
  backends?: Backends
  launches?: { cwd: string; worktree?: boolean; branch?: string; nonce: number }[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export async function worktreesSmoke(check: Check, { win, liveByTile, core, launches = [] }: Ctx): Promise<void> {
  const page = (): WebContents => liveByTile.get('git')!.wc
  const inPage = (code: string): Promise<any> => page().executeJavaScript(code)
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (id: string): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''

  // Every git call here is in the temp repository, with its own identity and no signing.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'ws-worktrees-')))
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'smoke')
  git(repo, 'config', 'user.email', 'smoke@example.com')
  git(repo, 'config', 'commit.gpgsign', 'false')
  const commit = async (cwd: string, file: string, body: string): Promise<void> => {
    await writeFile(join(cwd, file), body)
    git(cwd, 'add', '--', file)
    git(cwd, 'commit', '-q', '-m', file)
  }
  await commit(repo, 'shared.txt', 'one\ntwo\nthree\nfour\nfive\n')
  const wt = (n: string): string => join(repo, '.claude', 'worktrees', n)
  for (const n of ['feat', 'busy', 'old']) git(repo, 'worktree', 'add', '-q', wt(n), '-b', n)
  // feat and busy both change shared.txt (different lines, so feat still merges cleanly).
  await commit(wt('feat'), 'shared.txt', 'ONE\ntwo\nthree\nfour\nfive\n')
  await commit(wt('busy'), 'shared.txt', 'one\ntwo\nthree\nfour\nFIVE\n')

  const start = async (cwd: string, name: string): Promise<string> => String((await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: ${JSON.stringify(name)} })`)).id)
  const main = await start(repo, 'wt-main')
  const feat = await start(wt('feat'), 'wt-feat')
  const busy = await start(wt('busy'), 'wt-busy')
  const ids = [main, feat, busy]
  for (const id of ids) await waitFor('a worktrees session to start', async () => (await screen(id)).includes('FAKE CLAUDE READY'))
  // One turn each, so none is "starting" (a write waits that out too).
  for (const id of ids) await js(`window.core.ptyInput(${JSON.stringify(id)}, 'hello\\r'); true`)
  for (const id of ids) await waitFor('a first turn', async () => (await screen(id)).includes('DONE hello'), 15_000)
  // The busy one starts a turn and does not finish it: a prompt hook with no stop after it.
  const rec = core.sessions.find(busy)!
  core.sessions.onHook('UserPromptSubmit', { session_id: rec.claudeSessionId, hook_event_name: 'UserPromptSubmit' } as never)
  await waitFor('wt-busy to be busy', () => core.sessions.getState().sessions.find((s) => s.id === busy)?.status === 'busy', 5000)

  await inPage(`document.querySelector('[data-tab="worktrees"]').click(); true`)
  const row = (path: string): string => `document.querySelector('.wt[data-path=${JSON.stringify(path)}]')`
  const rowText = (path: string): Promise<string> => inPage(`${row(path)}?.innerText ?? ''`)
  await waitFor('the worktrees to show', async () => (await inPage(`document.querySelectorAll('.wt-project[data-root=${JSON.stringify(repo)}] .wt').length`)) === 4, 20_000).catch(() => undefined)
  const featRow = await rowText(wt('feat'))
  check('worktrees: a row per worktree of the project', (await inPage(`document.querySelectorAll('.wt-project[data-root=${JSON.stringify(repo)}] .wt').length`)) === 4)
  check('worktrees: a row has its session, branch, ahead of main, clean, and a short path', /wt-feat/.test(featRow) && /feat/.test(featRow) && /↑1 on main/.test(featRow) && /clean/.test(featRow) && /\.claude\/worktrees\/feat/.test(featRow), featRow)
  const mainRow = await rowText(repo)
  check('worktrees: the main worktree names its session and says it is the main one', /wt-main/.test(mainRow) && /main worktree/.test(mainRow), mainRow)
  const oldRow = await rowText(wt('old'))
  check('worktrees: a merged worktree with no session is marked stale', /no session/.test(oldRow) && /merged, no session/.test(oldRow), oldRow)
  const overlap = (await inPage(`[...document.querySelectorAll('.wt-project[data-root=${JSON.stringify(repo)}] .overlap')].map((o) => o.innerText).join(' | ')`)) as string
  check('worktrees: two worktrees touching one file are warned about', /feat/.test(overlap) && /busy/.test(overlap) && /shared\.txt/.test(overlap), overlap)

  await inPage(`document.querySelector('[data-filter="stale"]').click(); true`)
  await sleep(200)
  const staleRows = (await inPage(`[...document.querySelectorAll('.wt-project[data-root=${JSON.stringify(repo)}] .wt')].map((w) => w.dataset.path)`)) as string[]
  check('worktrees: the stale filter shows only the stale one', staleRows.length === 1 && staleRows[0] === wt('old'), JSON.stringify(staleRows))
  await inPage(`document.querySelector('[data-filter="all"]').click(); true`)
  await sleep(200)

  const btn = (path: string, act: string): string => `${row(path)}?.querySelector('[data-act=${JSON.stringify(act)}]')`
  const mainHead = (): string => git(repo, 'rev-parse', 'main')
  const before = mainHead()

  // One click arms; nothing happens, and three seconds later it is plain again.
  await inPage(`${btn(wt('feat'), 'merge')}.click(); true`)
  await sleep(150)
  const armedNow = (await inPage(`${btn(wt('feat'), 'merge')}.classList.contains('armed') + ' ' + ${btn(wt('feat'), 'merge')}.textContent`)) as string
  check('worktrees: the first click arms the button red', armedNow.startsWith('true') && /click again/i.test(armedNow), armedNow)
  await sleep(3400)
  check('worktrees: a single click does nothing, and the arm wears off after three seconds', mainHead() === before && (await inPage(`${btn(wt('feat'), 'merge')}.classList.contains('armed')`)) === false)

  // Two clicks on busy's merge: refused, because its session is mid-turn.
  await inPage(`${btn(wt('busy'), 'merge')}.click(); true`)
  await sleep(100)
  await inPage(`${btn(wt('busy'), 'merge')}.click(); true`)
  await waitFor('the refusal', async () => /is busy/.test(await inPage(`${row(wt('busy'))}?.querySelector('.result')?.innerText ?? ''`)), 15_000).catch(() => undefined)
  const refused = (await inPage(`${row(wt('busy'))}?.querySelector('.result')?.innerText ?? ''`)) as string
  check('worktrees: a merge is refused while a session in that worktree is busy', /wt-busy is busy/.test(refused) && mainHead() === before, refused)

  // Two clicks on feat's merge: it goes through.
  const featHead = git(wt('feat'), 'rev-parse', 'HEAD')
  await inPage(`${btn(wt('feat'), 'merge')}.click(); true`)
  await sleep(100)
  await inPage(`${btn(wt('feat'), 'merge')}.click(); true`)
  await waitFor('the merge', () => mainHead() !== before, 15_000).catch(() => undefined)
  await waitFor('its result', async () => /merged/.test(await inPage(`${row(wt('feat'))}?.querySelector('.result')?.innerText ?? ''`)), 10_000).catch(() => undefined)
  const merged = (await inPage(`${row(wt('feat'))}?.querySelector('.result')?.innerText ?? ''`)) as string
  check('worktrees: a clean merge goes through on the second click', mainHead() === featHead && /merged feat into main/.test(merged), `${merged} ${mainHead()} ${featHead}`)
  check('worktrees: the merge leaves main clean, with nothing under way', git(repo, 'status', '--porcelain', '--untracked-files=no') === '' && !existsSync(join(repo, '.git', 'MERGE_HEAD')))

  // old is merged and has no session: two clicks remove it and its branch.
  await waitFor('old to offer Remove', async () => (await inPage(`!!${btn(wt('old'), 'remove')}`)) === true, 10_000).catch(() => undefined)
  await inPage(`${btn(wt('old'), 'remove')}.click(); true`)
  await sleep(100)
  await inPage(`${btn(wt('old'), 'remove')}.click(); true`)
  await waitFor('the remove', () => !existsSync(wt('old')), 15_000).catch(() => undefined)
  check('worktrees: remove takes a merged worktree and its branch, on the second click', !existsSync(wt('old')) && git(repo, 'branch', '--list', 'old') === '')

  // sessions.launch: the Git tile has it ("launch"); Reminders ("read") does not have the method at all.
  check('launch: absent from a tile without "sessions": "launch"', (await liveByTile.get('reminders')?.wc.executeJavaScript(`typeof workshop.sessions.launch`)) === 'undefined')
  check('launch: there for the Git tile', (await inPage(`typeof workshop.sessions.launch`)) === 'function')
  // A click a script makes is not the user's: refused.
  const scripted = (await inPage(`workshop.sessions.launch({ folder: ${JSON.stringify(wt('feat'))} }).then(() => 'opened', (e) => e.message)`)) as string
  check('launch: refused without a real click in the page', /click or key/.test(scripted), scripted)

  // A real click on "Open a session" in feat's row, with the tile as a pane so the button is on screen.
  await inPage('workshop.openPane()')
  await waitFor('the pane', async () => (await inPage('workshop.view')) === 'pane', 5000).catch(() => undefined)
  const sessionsBefore = core.sessions.getState().sessions.length
  const realClick = async (sel: string): Promise<boolean> => {
    const at = (await inPage(`(() => { const b = ${sel}; if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)) as { x: number; y: number } | null
    if (!at) return false
    await sleep(200)
    page().sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
    page().sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
    return true
  }
  const had = launches.length
  await realClick(btn(wt('feat'), 'open'))
  await waitFor('the launcher', async () => launches.length > had && (await js(`document.querySelector('.launch-where')?.title ?? ''`)) === wt('feat'), 5000).catch(() => undefined)
  const form = (await js(`({ folder: document.querySelector('.launch-where')?.title, worktree: document.querySelector('.launch-switch input')?.checked, focused: document.activeElement === document.querySelector('.launch-go') })`)) as { folder: string; worktree: boolean; focused: boolean }
  check('launch: a real click opens the launcher filled in with that worktree, Start focused', form.folder === wt('feat') && form.worktree === false && form.focused, JSON.stringify(form))
  await sleep(500)
  check('launch: nothing is started', core.sessions.getState().sessions.length === sessionsBefore)

  // "New chat in a worktree": the project's folder, with a new worktree ticked.
  await inPage('workshop.openPane()').catch(() => undefined)
  await waitFor('the pane again', async () => (await inPage('workshop.view')) === 'pane', 5000).catch(() => undefined)
  const had2 = launches.length
  await realClick(`document.querySelector('.wt-project[data-root=${JSON.stringify(repo)}] [data-act="newchat"]')`)
  await waitFor('the launcher again', () => launches.length > had2, 5000).catch(() => undefined)
  await sleep(200)
  const form2 = (await js(`({ folder: document.querySelector('.launch-where')?.title, worktree: document.querySelector('.launch-switch input')?.checked })`)) as { folder: string; worktree: boolean }
  check('launch: "new chat in a worktree" fills in the project with a new worktree ticked, and starts nothing', form2.folder === repo && form2.worktree === true && core.sessions.getState().sessions.length === sessionsBefore, JSON.stringify(form2))

  // Back to a session in the center, the Changes tab, and the sessions gone.
  await inPage('workshop.closePane()').catch(() => undefined)
  await inPage(`document.querySelector('[data-tab="changes"]').click(); true`)
  for (const id of ids) await core.sessions.kill(id)
  await waitFor('the worktrees sessions to go', () => !core.sessions.getState().sessions.some((s) => ids.includes(s.id)), 10_000).catch(() => undefined)
  await sleep(1000)
}
