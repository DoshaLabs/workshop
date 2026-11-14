// The smoke run's part for the Git tile (tiles/git, built in, with a backend). A repository with
// a worktree, three fake-claude sessions in it (two in the main tree, one in the worktree), files
// changed by the smoke, and then from the tile's own page: one line for the two sessions that
// share a tree, one for the worktree, the counts, a click that unfolds the diff, a binary file
// named and not shown, the page unable to name a folder, no index lock left behind, and the door's
// `show` from a session opening the pane on that session's changes.
//
// WORKSHOP_SHOT_GIT=<dir>: pictures of the tile and the pane, in a dark and a light theme.

import type { BrowserWindow, WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
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

export async function gitSmoke(check: Check, { win, liveByTile, core, backends }: Ctx): Promise<void> {
  const page = (): WebContents => liveByTile.get('git')!.wc
  const inPage = (code: string): Promise<any> => page().executeJavaScript(code)
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (id: string): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''

  await waitFor('the git tile and its backend', async () => !!liveByTile.get('git') && backends?.status('git').state === 'running' && (await inPage('window.gitReady === true').catch(() => false)) === true)
  check('git: the tile loads as built in and its backend runs', true)

  const git = (cwd: string, ...args: string[]): void => void execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' })
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'ws-gittile-')))
  git(repo, 'init', '-q')
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'one')
  const side = join(repo, '.claude', 'worktrees', 'side')
  git(repo, 'worktree', 'add', '-q', side, '-b', 'side')

  const start = async (cwd: string, name: string): Promise<string> => String((await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: ${JSON.stringify(name)} })`)).id)
  const main = await start(repo, 'git-main')
  const also = await start(join(repo, 'src'), 'git-also')
  const wt = await start(side, 'git-side')
  for (const id of [main, also, wt]) await waitFor('a git session to start', async () => (await screen(id)).includes('FAKE CLAUDE READY'))

  // What a session would have done: one line changed and one added, a new note, a new binary file.
  await writeFile(join(repo, 'a.txt'), 'one\n2\nthree\nfour\n')
  await writeFile(join(repo, 'notes.md'), '# Notes\nfrom the smoke\n')
  await writeFile(join(repo, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]))
  await writeFile(join(side, 'src', 'b.ts'), 'export const b = 2\n')

  const line = (top: string): string => `document.querySelector('.line[data-top=${JSON.stringify(top)}]')`
  const lineText = (top: string): Promise<string> => inPage(`${line(top)}?.innerText ?? ''`)
  await waitFor('the changes to show in the tile', async () => /\+4/.test(await lineText(repo)) && /\+1/.test(await lineText(side)), 20_000).catch(() => undefined)
  const mainLine = await lineText(repo)
  check('git: the two sessions in one working tree share one line, naming both', /git-main/.test(mainLine) && /git-also/.test(mainLine) && (await inPage(`document.querySelectorAll('.line').length`)) === 2, mainLine)
  check('git: the line has the branch, the files touched and +n −m (untracked lines counted, binary not)', /main/.test(mainLine) && /3 files/.test(mainLine) && /\+4/.test(mainLine) && /−1/.test(mainLine), mainLine)
  const sideLine = await lineText(side)
  check('git: the worktree is its own line, in the same project', /side/.test(sideLine) && /worktree side/.test(sideLine) && /git-side/.test(sideLine) && /1 file/.test(sideLine) && /\+1/.test(sideLine) && /−1/.test(sideLine) && (await inPage(`document.querySelectorAll('.project').length`)) >= 1 && (await inPage(`${line(repo)}.closest('.project') === ${line(side)}.closest('.project')`)) === true, sideLine)
  // Three files in the main tree, one in the worktree.
  check('git: the head counts the changed files', (await js(`document.querySelector('.tiles [data-tile="git"] .head .badge')?.textContent ?? ''`)) === '4')

  // Unfold: the diff is drawn from the backend's hunks.
  await inPage(`${line(repo)}.click(); true`)
  await waitFor('the diff to unfold', async () => (await inPage(`document.querySelectorAll('.dfile').length`)) >= 3, 10_000).catch(() => undefined)
  const diff = (await inPage(`[...document.querySelectorAll('.dfile')].map((f) => ({ head: f.querySelector('.dfile-head').innerText, added: [...f.querySelectorAll('.l.a .s')].map((x) => x.textContent), removed: [...f.querySelectorAll('.l.d .s')].map((x) => x.textContent), text: f.innerText }))`)) as { head: string; added: string[]; removed: string[]; text: string }[]
  const of = (p: string): { head: string; added: string[]; removed: string[]; text: string } | undefined => diff.find((d) => d.head.includes(p))
  check('git: a click unfolds the diff, line by line', JSON.stringify(of('a.txt')?.added) === '["2","four"]' && JSON.stringify(of('a.txt')?.removed) === '["two"]', JSON.stringify(diff).slice(0, 400))
  check('git: an untracked file shows as added lines', JSON.stringify(of('notes.md')?.added) === '["# Notes","from the smoke"]', JSON.stringify(of('notes.md')))
  check('git: a binary file is named, not shown', /Binary file, not shown/.test(of('logo.bin')?.text ?? '') && (of('logo.bin')?.added.length ?? 1) === 0, JSON.stringify(of('logo.bin')))
  check('git: no diff text is put into the page as HTML', (await inPage(`document.querySelectorAll('.diffs script, .diffs img, .diffs a').length`)) === 0)

  // The page names sessions, never folders: a path in place of an id gets nothing.
  const bad = await inPage(`workshop.backend.call('diff', { session: ${JSON.stringify(repo)} }).then(() => 'answered', (e) => e.message)`)
  const none = await inPage(`workshop.backend.call('changes', { sessions: ['/etc', ${JSON.stringify(repo)}] })`)
  check('git: the page cannot point git at a folder', /no such session/.test(bad) && Array.isArray(none?.projects) && none.projects.length === 0, `${bad} ${JSON.stringify(none)}`)
  check('git: reading never leaves the index locked', !existsSync(join(repo, '.git', 'index.lock')) && !existsSync(join(repo, '.git', 'worktrees', 'side', 'index.lock')))

  // A session asks the tile to show its changes: the pane opens on that session's worktree.
  await js(`window.core.ptyInput(${JSON.stringify(wt)}, 'tile git show\\r'); true`)
  await waitFor('the show call', async () => (await screen(wt)).includes('DONE tile git show'), 15_000).catch(() => undefined)
  const shown = await screen(wt)
  await waitFor('the pane', async () => (await inPage('workshop.view')) === 'pane', 5000).catch(() => undefined)
  check('git door: show answers the session with its own changes', /"shown":\s*true/.test(shown) && /"branch":\s*"side"/.test(shown), shown.slice(-400))
  check('git door: show opens the pane with that worktree unfolded', (await inPage('workshop.view')) === 'pane' && (await inPage(`${line(side)}.getAttribute('aria-expanded')`)) === 'true')

  // The review (the redesign): a lane's session wears its column band; a file is staged from its head;
  // a note on a line goes to the session as one typed message; the whole window is the studio.
  const bands = (await inPage(`workshop.sessions.list().then((l) => l.filter((s) => [${JSON.stringify(main)}, ${JSON.stringify(also)}, ${JSON.stringify(wt)}].includes(s.id)).map((s) => s.band))`)) as (number | null)[]
  check('git: sessions carry the head colour their tile wears (bridge 1.11), none for the one in the center', bands.filter((b) => b != null).every((b) => b! >= 1 && b! <= 4) && bands.some((b) => b != null), JSON.stringify(bands))
  await inPage(`${line(repo)}.click(); true`)
  const dfile = (p: string): string => `document.querySelector('.dfile[data-file=${JSON.stringify(p)}]')`
  await waitFor('the main lane’s review', async () => (await inPage(`!!${dfile('a.txt')}?.querySelector('[data-act="stage"]')`)) === true, 10_000).catch(() => undefined)
  await inPage(`${dfile('a.txt')}.querySelector('[data-act="stage"]').click(); true`)
  const staged = (): string => execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim()
  await waitFor('a.txt to be staged', async () => staged() === 'a.txt', 10_000).catch(() => undefined)
  check('git review: Stage on a file’s head stages it, and only it', staged() === 'a.txt', staged())
  await waitFor('the head to say so', async () => /staged/.test(await inPage(`${dfile('a.txt')}?.querySelector('.dfile-head')?.innerText ?? ''`)), 10_000).catch(() => undefined)
  check('git review: the file says it is staged, and the dock offers its commit', /staged/.test(await inPage(`${dfile('a.txt')}.querySelector('.dfile-head').innerText`)) && /Commit 1 staged/.test(await inPage(`document.querySelector('[data-act="commit"]')?.textContent ?? ''`)))
  execFileSync('git', ['restore', '--staged', 'a.txt'], { cwd: repo })

  await inPage(`${dfile('notes.md')}.querySelector('.l.a .no:nth-child(2)').click(); true`)
  await waitFor('the note editor', async () => (await inPage(`!!document.querySelector('[data-key="note"]')`)) === true, 5000).catch(() => undefined)
  await inPage(`(() => { const t = document.querySelector('[data-key="note"]'); t.value = 'Say where the notes come from.'; t.dispatchEvent(new Event('input')); [...document.querySelectorAll('.rnote button')].find((b) => /Add note/.test(b.textContent)).click(); return true })()`)
  await waitFor('the note and Send', async () => (await inPage(`!!document.querySelector('[data-act="send"]')`)) === true, 5000).catch(() => undefined)
  check('git review: a click on a line number leaves a note under that line', /Say where the notes come from/.test(await inPage(`${dfile('notes.md')}?.innerText ?? ''`)))
  await inPage(`document.querySelector('[data-act="send"]').click(); true`)
  // The lane holds git-main and git-also; notes go to its first session (or the one picked).
  const laneScreens = async (): Promise<string> => (await screen(main)) + (await screen(also))
  await waitFor('the note to reach the session', async () => /review note on your uncommitted changes/.test(await laneScreens()), 10_000).catch(() => undefined)
  const toast = (await inPage(`document.getElementById('toast')?.textContent ?? ''`)) as string
  check('git review: Send notes types them into the lane’s session as one message', /review note on your uncommitted changes/.test(await laneScreens()) && (await inPage(`!!document.querySelector('[data-act="send"]')`)) === false, `toast: ${toast} | ${(await laneScreens()).replace(/\s+/g, ' ').slice(-300)}`)

  // The whole window needs real input in the page: a real click on "Whole window".
  const spot = (await inPage(`(() => { const b = document.querySelector('[data-act="whole"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)) as { x: number; y: number } | null
  if (spot) {
    page().sendInputEvent({ type: 'mouseDown', ...spot, button: 'left', clickCount: 1 })
    page().sendInputEvent({ type: 'mouseUp', ...spot, button: 'left', clickCount: 1 })
  }
  await waitFor('the whole window', async () => (await inPage('workshop.view')) === 'overlay' && (await inPage(`!!document.querySelector('.studio')`)) === true, 8000).catch(() => undefined)
  check('git studio: "Whole window" opens the review studio over the window: lanes, files, one diff', (await inPage('workshop.view')) === 'overlay' && (await inPage(`document.querySelectorAll('.studio > section').length`)) === 3)
  await waitFor('the command log', async () => /\$ git/.test(await inPage(`document.getElementById('foot').innerText`)), 8000).catch(() => undefined)
  check('git studio: its foot shows the git the tile ran', /\$ git /.test(await inPage(`document.getElementById('foot').innerText`)))
  if (process.env.WORKSHOP_SHOT_GIT) {
    await sleep(800)
    const shot = await Promise.race([win.webContents.capturePage().catch(() => null), sleep(3000).then(() => null)])
    if (shot) {
      await mkdir(process.env.WORKSHOP_SHOT_GIT, { recursive: true })
      await writeFile(join(process.env.WORKSHOP_SHOT_GIT, 'studio-window.png'), shot.toPNG())
    }
  }
  await inPage('workshop.closeOverlay()').catch(() => undefined)
  await waitFor('the pane again', async () => (await inPage('workshop.view')) !== 'overlay', 5000).catch(() => undefined)

  if (process.env.WORKSHOP_SHOT_GIT) {
    const dir = process.env.WORKSHOP_SHOT_GIT
    await mkdir(dir, { recursive: true })
    // A capture of a page Chromium is not drawing (a tile out of sight) never settles: each is given 3 s.
    const within = <T>(p: Promise<T>): Promise<T | null> => Promise.race([p.catch(() => null), sleep(3000).then(() => null)])
    const shoot = async (name: string): Promise<void> => {
      await sleep(600)
      const whole = await within(win.webContents.capturePage())
      if (whole) await writeFile(join(dir, `${name}-window.png`), whole.toPNG())
      const own = await within(page().capturePage())
      if (own) await writeFile(join(dir, `${name}-page.png`), own.toPNG())
    }
    await shoot('pane-dark')
    const was = (await js(`window.core.listTiles().then((r) => r.theme)`)) as { theme: string; appearance: string }
    await js(`window.core.setSettings({ theme: 'cream', appearance: 'light' })`)
    await shoot('pane-light')
    await inPage('workshop.closePane()')
    await shoot('tile-light')
    await js(`window.core.setSettings({ theme: ${JSON.stringify(was.theme)}, appearance: ${JSON.stringify(was.appearance)} })`)
    await shoot('tile-dark')
  }
  await inPage('workshop.closePane()').catch(() => undefined)

  for (const id of [main, also, wt]) await core.sessions.kill(id)
  // Gone from the window before the next part, which counts what the session column draws.
  await waitFor('the git sessions to go', () => !core.sessions.getState().sessions.some((s) => [main, also, wt].includes(s.id)), 10_000).catch(() => undefined)
  await sleep(1000)
}
