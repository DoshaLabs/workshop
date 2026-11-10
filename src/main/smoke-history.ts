// The smoke run's part for the Git tile's History tab. A temp repository with a worktree and a
// fake-claude session in it. The session commits through a Bash call (`bash …` in the fixture),
// so its PostToolUse hook fires and core records the commit; the smoke itself commits once in the
// worktree (no record: a guess) and once in the main tree, where no session is (untagged). From
// the tile's own page: the exact tag, the "probably" tag, no tag, a commit appearing at once when
// core records it (before the poll would), a click unfolding the diff, and "Today, by session".
//
// WORKSHOP_SHOT_HISTORY=<dir>: pictures of the tab as a pane, all and by session, dark and light.

import type { BrowserWindow, WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreSessions } from './core-sessions'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Ctx {
  win: BrowserWindow
  liveByTile: Map<string, { wc: WebContents }>
  core: CoreSessions
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

export async function historySmoke(check: Check, { win, liveByTile, core }: Ctx): Promise<void> {
  const page = (): WebContents => liveByTile.get('git')!.wc
  const inPage = (code: string): Promise<any> => page().executeJavaScript(code)
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (id: string): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''

  // Every git call here is in the temp repository, with its own identity and no signing.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'ws-history-')))
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'smoke')
  git(repo, 'config', 'user.email', 'smoke@example.com')
  git(repo, 'config', 'commit.gpgsign', 'false')
  const commit = async (cwd: string, file: string, msg: string): Promise<string> => {
    await writeFile(join(cwd, file), `${msg}\n`)
    git(cwd, 'add', '--', file)
    git(cwd, 'commit', '-q', '-m', msg)
    return git(cwd, 'rev-parse', 'HEAD')
  }
  await commit(repo, 'base.txt', 'before any session')
  const wt = join(repo, '.claude', 'worktrees', 'feat')
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat')

  const id = String((await js(`window.core.newSession({ cwd: ${JSON.stringify(wt)}, name: 'hist-feat' })`)).id)
  await waitFor('the history session to start', async () => (await screen(id)).includes('FAKE CLAUDE READY'))
  // The reflog and commit times are whole seconds: what follows is clearly after the session began.
  await sleep(1200)

  // The session commits through its Bash tool: PostToolUse → core reads the reflog → a record.
  const type = (line: string): Promise<unknown> => js(`window.core.ptyInput(${JSON.stringify(id)}, ${JSON.stringify(`${line}\r`)}); true`)
  await type('bash echo one > made.txt && git add made.txt && git commit -m "made in the session"')
  await waitFor('the session\'s commit', async () => (await screen(id)).includes('DONE bash echo one'), 15_000).catch(() => undefined)
  const made = git(wt, 'rev-parse', 'HEAD')
  await waitFor('core to record it', () => core.commits.store.has(made), 10_000).catch(() => undefined)
  const rec = core.commits.store.all().find((r) => r.sha === made)
  check('history: a commit a session makes through Bash is recorded as that session\'s (PostToolUse)', !!rec && rec.session === id && rec.name === 'hist-feat', JSON.stringify(rec))
  check('history: the record keeps no command', !!rec && Object.keys(rec).sort().join() === 'at,name,session,sha')

  // Two commits no session is known to have made: one on feat (the session's branch: a guess), one on main (nobody's).
  const guessed = await commit(wt, 'guess.txt', 'made beside the session')
  const nobody = await commit(repo, 'main.txt', 'made on main')

  check('history: a commit made beside the session is not recorded as its own', !core.commits.store.has(guessed) && !core.commits.store.has(nobody))

  await inPage(`document.querySelector('[data-tab="history"]').click(); true`)
  await inPage(`document.querySelector('[data-hfilter="all"]')?.click(); true`)
  const rowOf = (sha: string): string => `document.querySelector('.hproject[data-root=${JSON.stringify(repo)}] .commit[data-sha="${sha}"]')`
  const rowText = (sha: string): Promise<string> => inPage(`${rowOf(sha)}?.innerText ?? ''`)
  await waitFor('the history to show', async () => (await rowText(nobody)) !== '', 20_000).catch(() => undefined)
  const exactRow = (await inPage(`${rowOf(made)}?.querySelector('.by.exact')?.textContent ?? ''`)) as string
  check('history: the session\'s commit is tagged with it, exactly', exactRow === 'hist-feat', `${exactRow} | ${await rowText(made)}`)
  const guessRow = (await inPage(`${rowOf(guessed)}?.querySelector('.by')?.className + ' ' + ${rowOf(guessed)}?.querySelector('.by')?.textContent`)) as string
  check('history: a commit on the session\'s branch with no record says "probably", and looks different', guessRow === 'by probable probably hist-feat', guessRow)
  check('history: a commit on main, where no session is, has no tag', (await inPage(`${rowOf(nobody)} ? !${rowOf(nobody)}.querySelector('.by') : false`)) === true, await rowText(nobody))
  const mainRow = await rowText(nobody)
  check('history: a row has its subject, short sha, branch and when', /made on main/.test(mainRow) && mainRow.includes(nobody.slice(0, 7)) && /\bmain\b/.test(mainRow) && /just now|min ago/.test(mainRow), mainRow)
  check('history: no row names the CLI', !/claude/i.test(((await inPage(`document.querySelector('.hproject[data-root=${JSON.stringify(repo)}]')?.innerText ?? ''`)) as string).replace(/\.claude\/worktrees/g, '')))

  // The reflog keeps whole seconds, so a commit made in the very second a session's call starts
  // would be taken for the session's (the one limit of the exact record): the next call starts a
  // second after the commit made beside it.
  await sleep(1100)
  // A second commit by the session shows at once: core's record reaches the page as an event, well before the 8 s poll.
  await type('bash echo two > made2.txt && git add made2.txt && git commit -m "second from the session"')
  await waitFor('the second commit', async () => (await screen(id)).includes('DONE bash echo two'), 15_000).catch(() => undefined)
  const made2 = git(wt, 'rev-parse', 'HEAD')
  await waitFor('core to record it', () => core.commits.store.has(made2), 5000).catch(() => undefined)
  check('history: the session\'s second commit is recorded, and the one made beside it before is still not', core.commits.store.has(made2) && !core.commits.store.has(guessed))
  const t0 = Date.now()
  await waitFor('it to show', async () => (await inPage(`${rowOf(made2)}?.querySelector('.by.exact')?.textContent ?? ''`)) === 'hist-feat', 3000).catch(() => undefined)
  const took = Date.now() - t0
  check('history: a recorded commit appears at once, tagged', took < 3000, `${took} ms`)

  // A click unfolds the commit's diff.
  await inPage(`${rowOf(made)}.querySelector('button.line').click(); true`)
  await waitFor('the diff', async () => (await inPage(`${rowOf(made)}?.querySelector('.dfile') ? 1 : 0`)) === 1, 10_000).catch(() => undefined)
  const diff = (await inPage(`${rowOf(made)}?.querySelector('.diffs')?.innerText ?? ''`)) as string
  check('history: clicking a commit unfolds its diff', /made\.txt/.test(diff) && /one/.test(diff), diff.slice(0, 200))

  // Today, by session: the session's group holds its commits and the guess; main's goes under "No session".
  await inPage(`document.querySelector('[data-hfilter="today"]').click(); true`)
  await sleep(200)
  const group = (key: string): string => `document.querySelector('.hgroup[data-group=${JSON.stringify(key)}]')`
  const mine = (await inPage(`[...(${group(`s ${id}`)}?.querySelectorAll('.commit') ?? [])].map((c) => c.dataset.sha)`)) as string[]
  const head = (await inPage(`${group(`s ${id}`)}?.querySelector('.project-head')?.innerText ?? ''`)) as string
  check('history: "Today, by session" groups the session\'s commits under it, the guess with them', mine.includes(made) && mine.includes(made2) && mine.includes(guessed) && /hist-feat/.test(head) && /3 commits, 1 a guess/.test(head), `${head} ${JSON.stringify(mine)}`)
  const none = (await inPage(`[...(${group(`none ${repo}`)}?.querySelectorAll('.commit') ?? [])].map((c) => c.dataset.sha)`)) as string[]
  check('history: "Today, by session" puts an untagged commit under "No session"', none.includes(nobody) && !mine.includes(nobody), JSON.stringify(none))
  const label = (await inPage(`document.querySelector('[data-hfilter="today"]').textContent`)) as string
  const barText = (await inPage(`document.getElementById('bar').innerText`)) as string
  check('history: the bar draws no stray words', !/null|undefined/.test(barText), barText)
  check('history: the filter is "Today, by session"', label === 'Today, by session', label)

  if (process.env.WORKSHOP_SHOT_HISTORY) {
    const dir = process.env.WORKSHOP_SHOT_HISTORY
    await mkdir(dir, { recursive: true })
    // A capture of a page Chromium is not drawing never settles: each is given 3 s.
    const within = <T>(p: Promise<T>): Promise<T | null> => Promise.race([p.catch(() => null), sleep(3000).then(() => null)])
    const shoot = async (name: string): Promise<void> => {
      await sleep(600)
      const own = await within(page().capturePage())
      if (own) await writeFile(join(dir, `${name}.png`), own.toPNG())
    }
    await inPage('workshop.openPane()')
    await shoot('today-dark')
    await inPage(`document.querySelector('[data-hfilter="all"]').click(); document.querySelector('.hproject[data-root=${JSON.stringify(repo)}]')?.scrollIntoView(); true`)
    await shoot('all-dark')
    const was = (await js(`window.core.listTiles().then((r) => r.theme)`)) as { theme: string; appearance: string }
    await js(`window.core.setSettings({ theme: 'cream', appearance: 'light' })`)
    await shoot('all-light')
    await js(`window.core.setSettings({ theme: ${JSON.stringify(was.theme)}, appearance: ${JSON.stringify(was.appearance)} })`)
    await inPage('workshop.closePane()').catch(() => undefined)
  }

  // Leave the tile as the next parts expect it.
  await inPage(`document.querySelector('[data-hfilter="all"]').click(); document.querySelector('[data-tab="changes"]').click(); true`)
}
