// The smoke run's part for Codex sessions (phase 1 of docs/progress/2026-11-11-codex.md), with the
// stand-in `codex` (test/fixtures/fake-codex). Core finds it on PATH and the launcher offers it;
// a Codex session is one tmux session with two windows, the TUI attached (window 0) and its own
// app-server (window 1) started in the session's folder with the session's door env; the TUI
// waits for the socket and connects with --remote and -C; the tile wears a codex badge and no
// pause; park and resume reattach; after its tmux dies it starts again (a known thread resumed by
// id); a clean exit ends both windows and parks it; kill removes the socket.

import type { BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreSessions } from './core-sessions'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Ctx {
  win: BrowserWindow
  core: CoreSessions
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

const TID = '01a1cbf8-d80b-75f1-8e06-5c98aa3450ca'

export async function codexSmoke(check: Check, { win, core, userData }: Ctx): Promise<void> {
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (id: string): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const windows = (id: string): string[] => {
    try {
      return execFileSync('tmux', [...core.tmux.cliPrefix, 'list-windows', '-t', `ws-${id}`, '-F', '#{window_index}:#{window_name}:#{window_active}'], { encoding: 'utf8' }).trim().split('\n')
    } catch {
      return []
    }
  }
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ws-codex-')))

  // The launcher: Codex is offered because it is on PATH, and picking it swaps the modes.
  const clis = (await js(`window.core.clis()`)) as { claude: boolean; codex: boolean }
  check('codex: core finds both CLIs on the sessions\' PATH', clis.claude && clis.codex, JSON.stringify(clis))
  await js(`document.querySelector('.session-plus')?.click(); true`)
  await waitFor('the launcher\'s Agent choice', async () => (await js(`!!document.querySelector('[aria-label="Agent"]')`)) === true, 5000).catch(() => undefined)
  const before = (await js(`[...document.querySelectorAll('[aria-label="Permissions"] button')].map((b) => b.textContent).join('|')`)) as string
  await js(`[...document.querySelectorAll('[aria-label="Agent"] button')].find((b) => b.textContent === 'Codex')?.click(); true`)
  await sleep(150)
  const after = (await js(`[...document.querySelectorAll('[aria-label="Permissions"] button')].map((b) => b.textContent).join('|')`)) as string
  check('codex: the launcher offers Codex, with its own permission modes', before.includes('Accept edits') && after.includes('Workspace') && after.includes('Read only') && !after.includes('Accept edits'), `${before} → ${after}`)
  const wt = (await js(`(() => { const i = document.querySelector('.launch-switch input'); return i && { disabled: i.disabled } })()`)) as { disabled: boolean } | null
  check('codex: the launcher offers a worktree for Codex too', !!wt && !wt.disabled, JSON.stringify(wt))
  // Back to Claude Code, so the launcher is as the next part expects it.
  await js(`[...document.querySelectorAll('[aria-label="Agent"] button')].find((b) => b.textContent === 'Claude Code')?.click(); true`)

  // A Codex session.
  const made = await js(`window.core.newSession({ cli: 'codex', cwd: ${JSON.stringify(cwd)}, name: 'codex-one', permissionMode: 'read-only' })`)
  const id = String(made.id)
  await waitFor('the Codex TUI to connect', async () => (await screen(id)).includes('CONNECTED'))
  const sock = join(userData, 'codex', `${id}.sock`)
  const tuiArgv = async (): Promise<string[]> => (JSON.parse(await readFile(`${sock}.tui.json`, 'utf8').catch(() => '{}')) as { argv?: string[] }).argv ?? []
  const argv = await tuiArgv()
  const rec = core.sessions.find(id)
  check('codex: the session is kept as Codex, its thread id not yet known', rec?.cli === 'codex' && rec.cliSessionId === '', JSON.stringify(rec && { cli: rec.cli, sid: rec.cliSessionId }))
  check('codex: the TUI connects to the session\'s own server, in its folder, with the mode\'s flags', argv.join(' ') === `--remote unix://${sock} -C ${cwd} -s read-only -a on-request`, argv.join(' '))
  const w = windows(id)
  check('codex: one tmux session, the TUI attached and the app-server beside it', w.length === 2 && /^0:[^:]+:1$/.test(w[0]) && w[1].startsWith('1:app-server:0'), w.join(' '))
  const server = JSON.parse(await readFile(join(userData, `fake-codex-server-${id}.json`), 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string> }
  check('codex: the app-server runs in the session\'s folder (the session runs in the server\'s)', server.cwd === cwd && server.argv.join(' ') === `app-server --listen unix://${sock}`, `${server.cwd} ${server.argv.join(' ')}`)
  check('codex: the server has the session\'s door env (its tools run there), and no token in argv', server.env.WORKSHOP_SESSION === id && /auth\/[0-9a-f]{6}\.header$/.test(server.env.WORKSHOP_AUTH ?? '') && !!server.env.WORKSHOP_TILE && !server.argv.some((x) => /[0-9a-f]{48}/.test(x)), JSON.stringify(server.env))
  check('codex: a session not yet heard from is unknown, not stuck starting', core.sessions.view(id)?.status === 'unknown', core.sessions.view(id)?.status)

  // Typing reaches the TUI (the terminal is the real one).
  core.sessions.input(id, 'hello codex\r')
  await waitFor('the echo', async () => (await screen(id)).includes('> hello codex'), 5000).catch(() => undefined)
  check('codex: what you type reaches the TUI', (await screen(id)).includes('> hello codex'))

  // Its tile in the column: the codex badge, and no pause (the leash is Claude Code's hooks).
  await js(`document.querySelector('.session-plus')?.click(); true`)
  const tile = `document.querySelector('.session-tile[data-session="${id}"]')`
  await waitFor('its tile', async () => (await js(`!!${tile}`)) === true, 5000).catch(() => undefined)
  const head = (await js(`(() => { const t = ${tile}; return t && { badges: [...t.querySelectorAll('.head .badge')].map((b) => b.textContent.trim()), pause: !!t.querySelector('.head .leash-toggle') } })()`)) as { badges: string[]; pause: boolean } | null
  check('codex: its tile wears a codex badge and no pause', !!head && head.badges.includes('codex') && !head.pause, JSON.stringify(head))

  // Park, then resume: the same tmux session, reattached.
  core.sessions.park(id)
  await waitFor('parked', () => core.sessions.find(id)?.open === false, 5000).catch(() => undefined)
  await core.sessions.resume(id)
  await waitFor('reattached', () => core.sessions.view(id)?.attached === true, 5000).catch(() => undefined)
  check('codex: park and resume reattach the same session', core.sessions.view(id)?.attached === true && (await screen(id)).includes('> hello codex'))

  // Its tmux gone (a reboot): parked; resume starts both windows again, the thread by id once known.
  core.sessions.find(id)!.cliSessionId = TID
  execFileSync('tmux', [...core.tmux.cliPrefix, 'kill-session', '-t', `ws-${id}`])
  await waitFor('parked after its tmux died', () => core.sessions.find(id)?.open === false, 5000).catch(() => undefined)
  await rm(`${sock}.tui.json`, { force: true })
  await core.sessions.resume(id)
  await waitFor('the TUI again', () => existsSync(`${sock}.tui.json`), 15_000).catch(() => undefined)
  const again = await tuiArgv()
  check('codex: after its tmux died, resume restarts it on its thread', again.slice(0, 2).join(' ') === `resume ${TID}` && again.includes('--remote') && windows(id).length === 2, again.join(' '))

  // A clean exit of the TUI ends the whole session (the server too) and parks it.
  core.sessions.input(id, 'exit\r')
  await waitFor('the session to end', async () => !(await core.tmux.hasSession(`ws-${id}`)), 5000).catch(() => undefined)
  await waitFor('parked', () => core.sessions.find(id)?.open === false, 5000).catch(() => undefined)
  check('codex: a clean exit ends both windows and parks the session', !(await core.tmux.hasSession(`ws-${id}`)) && core.sessions.find(id)?.open === false)

  // A Codex session in a worktree core made (Codex refuses --worktree with --remote).
  const repoDir = await realpath(await mkdtemp(join(tmpdir(), 'ws-codex-repo-')))
  const g = (...args: string[]): string => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@example.invalid', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@example.invalid' } }).trim()
  g('init', '-q', '-b', 'main')
  g('commit', '-q', '--allow-empty', '-m', 'one')
  const wtMade = await js(`window.core.newSession({ cli: 'codex', cwd: ${JSON.stringify(repoDir)}, worktree: true, worktreeName: 'codex-wt' })`)
  const wtId = String(wtMade.id)
  const wtPath = join(repoDir, '.workshop', 'worktrees', 'codex-wt')
  const wtSock = join(userData, 'codex', `${wtId}.sock`)
  await waitFor('the worktree TUI', () => existsSync(`${wtSock}.tui.json`), 15_000).catch(() => undefined)
  const wtArgv = (JSON.parse(await readFile(`${wtSock}.tui.json`, 'utf8').catch(() => '{}')) as { argv?: string[] }).argv ?? []
  const wtServer = JSON.parse(await readFile(join(userData, `fake-codex-server-${wtId}.json`), 'utf8').catch(() => '{}')) as { cwd?: string }
  const wtRec = core.sessions.find(wtId)
  check('codex: a worktree session starts in .workshop/worktrees/<name> on worktree-<name>, made by core', wtRec?.cwd === wtPath && wtRec.worktree && wtRec.name === 'codex-wt' && g('worktree', 'list').includes(wtPath) && execFileSync('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim() === 'worktree-codex-wt', JSON.stringify(wtRec && { cwd: wtRec.cwd, name: wtRec.name }))
  check('codex: its TUI and server both run in the worktree, and Codex never sees --worktree', wtArgv.join(' ').includes(`-C ${wtPath}`) && !wtArgv.includes('--worktree') && wtServer.cwd === wtPath, `${wtArgv.join(' ')} | ${wtServer.cwd}`)
  check('codex: the main tree stays clean (.workshop/ is excluded, nothing tracked changed)', g('status', '--porcelain') === '', g('status', '--porcelain'))
  await core.sessions.kill(wtId)

  // Kill: gone, and its socket with it.
  await core.sessions.resume(id)
  await waitFor('the TUI again', async () => (await screen(id)).includes('CONNECTED'), 15_000).catch(() => undefined)
  await core.sessions.kill(id)
  check('codex: kill forgets the session and removes its socket', !core.sessions.find(id) && !existsSync(sock) && !(await core.tmux.hasSession(`ws-${id}`)))
}
