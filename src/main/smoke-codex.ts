// The smoke run's part for Codex sessions (phase 1 of docs/progress/2026-11-11-codex.md), with the
// stand-in `codex` (test/fixtures/fake-codex). Core finds it on PATH and the launcher offers it;
// a Codex session is one tmux session with two windows, the TUI attached (window 0) and its own
// app-server (window 1) started in the session's folder with the session's door env; the TUI
// waits for the socket and connects with --remote and -C; the tile wears a codex badge and no
// pause; park and resume reattach; after its tmux dies it starts again (a known thread resumed by
// id); a clean exit ends both windows and parks it; kill removes the socket. Phase 3: an approval
// shows on the session as Allow / Deny, is answered only on a click, and goes when the terminal
// answers first; a permissions request and a question are never answered by core. No pause: Stop
// (two clicks) interrupts the running turn. A commit a Codex command made is the session's. Its
// subagents (child threads) show in a pack tile under it, with kill and no pause.

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
  check('codex: the session is kept as Codex', rec?.cli === 'codex', JSON.stringify(rec && { cli: rec.cli }))
  check('codex: the TUI connects to the session\'s own server, in its folder, with the mode\'s flags', argv.join(' ') === `--remote unix://${sock} -C ${cwd} -s read-only -a on-request`, argv.join(' '))
  const w = windows(id)
  check('codex: one tmux session, the TUI attached and the app-server beside it', w.length === 2 && /^0:[^:]+:1$/.test(w[0]) && w[1].startsWith('1:app-server:0'), w.join(' '))
  const server = JSON.parse(await readFile(join(userData, `fake-codex-server-${id}.json`), 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string> }
  check('codex: the app-server runs in the session\'s folder (the session runs in the server\'s)', server.cwd === cwd && server.argv.join(' ') === `app-server --listen unix://${sock}`, `${server.cwd} ${server.argv.join(' ')}`)
  check('codex: the server has the session\'s door env (its tools run there), and no token in argv', server.env.WORKSHOP_SESSION === id && /auth\/[0-9a-f]{6}\.header$/.test(server.env.WORKSHOP_AUTH ?? '') && !!server.env.WORKSHOP_TILE && !server.argv.some((x) => /[0-9a-f]{48}/.test(x)), JSON.stringify(server.env))
  check('codex: a new session is never stuck starting', core.sessions.view(id)?.status !== 'starting', core.sessions.view(id)?.status)

  // Phase 2: core is a second client of the session's app-server.
  await waitFor('core to find the thread', () => /^[0-9a-f-]{36}$/.test(core.sessions.find(id)?.cliSessionId ?? ''), 10_000).catch(() => undefined)
  const threadId = core.sessions.find(id)?.cliSessionId ?? ''
  check('codex: core finds the session\'s thread on its server (not the ephemeral side thread) and keeps its id', /^[0-9a-f-]{36}$/.test(threadId), threadId)

  // Typing reaches the TUI (the terminal is the real one), and the turn reaches core.
  core.sessions.input(id, 'hello codex\r')
  await waitFor('the echo', async () => (await screen(id)).includes('> hello codex'), 5000).catch(() => undefined)
  check('codex: what you type reaches the TUI', (await screen(id)).includes('> hello codex'))
  await waitFor('the turn in the transcript', () => (core.transcripts.get(id)?.blocks.length ?? 0) >= 3, 10_000).catch(() => undefined)
  const blocks = core.transcripts.get(id)?.blocks ?? []
  check('codex: the conversation as a session tile shows it: the prompt, the command (shell dropped), the reply', blocks.length === 3 && blocks[0].kind === 'user' && blocks[0].text === 'hello codex' && blocks[1].kind === 'tool' && blocks[1].label === 'touch hello.txt' && blocks[1].done && !blocks[1].error && blocks[2].kind === 'text' && blocks[2].text.startsWith('Made **hello.txt**'), JSON.stringify(blocks))
  await waitFor('the turn to end', () => core.sessions.view(id)?.status === 'idle' && core.sessions.view(id)?.attention === true, 5000).catch(() => undefined)
  const v = core.sessions.view(id)
  check('codex: a finished turn is idle and waits for you', v?.status === 'idle' && v.attention === true, JSON.stringify(v && { status: v.status, attention: v.attention }))
  await waitFor('the title', () => core.sessions.view(id)?.title === 'Make hello.txt', 5000).catch(() => undefined)
  check('codex: Codex\'s name for the thread is the title; the side thread\'s is ignored', core.sessions.view(id)?.title === 'Make hello.txt', String(core.sessions.view(id)?.title))
  check('codex: its context use, from token usage (25,840 of 258,400); no cost guessed', core.usage.get().sessions[id]?.context === 10 && core.usage.get().sessions[id]?.costUsd === null, JSON.stringify(core.usage.get().sessions[id]))

  // Approvals (phase 3, item 1): shown on the session as Allow / Deny, answered only on a click.
  const answers = async (): Promise<{ id: number; result?: { decision?: unknown } }[]> => JSON.parse(await readFile(`${sock}.answers.json`, 'utf8').catch(() => '[]'))
  const card = async (): Promise<{ tool: string; label: string; body: string; buttons: string[]; note: string } | null> =>
    js(`(() => { const c = document.querySelector('.leash-card.is-ask'); return c && { tool: c.querySelector('.leash-tool')?.textContent ?? '', label: c.querySelector('.leash-label')?.textContent ?? '', body: c.querySelector('.leash-body')?.textContent ?? '', buttons: [...c.querySelectorAll('[data-answer]')].map((b) => b.dataset.answer), note: c.querySelector('.leash-note')?.textContent ?? '' } })()`)
  const noCard = (): Promise<void> => waitFor('the card to go', async () => (await card()) === null, 5000).catch(() => undefined)

  // 1. Answered in the terminal: the card goes, core sent nothing.
  core.sessions.input(id, 'ask\r')
  await waitFor('needs you', () => core.sessions.view(id)?.status === 'blocked', 5000).catch(() => undefined)
  await waitFor('the card', async () => (await card()) !== null, 5000).catch(() => undefined)
  const c1 = await card()
  check('codex: an approval shows on the session as Allow / Deny, the command unwrapped', !!c1 && c1.tool === 'Bash' && c1.label === 'clean' && c1.body === 'rm -rf build' && c1.buttons.join() === 'allow,deny', JSON.stringify(c1))
  check('codex: an approval waiting marks the session as needing you', core.sessions.view(id)?.status === 'blocked' && core.sessions.view(id)?.attention === true, core.sessions.view(id)?.status)
  await sleep(1000)
  check('codex: core does not answer an approval by itself', (await answers()).length === 0, JSON.stringify(await answers()))
  core.sessions.input(id, 'yes\r')
  await noCard()
  await waitFor('idle again', () => core.sessions.view(id)?.status === 'idle', 5000).catch(() => undefined)
  check('codex: answered in the terminal, the card goes and core sent nothing', (await card()) === null && (await answers()).length === 0 && core.sessions.view(id)?.status === 'idle' && core.sessions.view(id)?.leash.asks.length === 0, `${core.sessions.view(id)?.status} ${JSON.stringify(await answers())}`)

  // 2. Deny on the tile: core declines that request (and only it), the TUI's dialog closes.
  core.sessions.input(id, 'ask\r')
  await waitFor('the card', async () => (await card()) !== null, 5000).catch(() => undefined)
  await js(`document.querySelector('.leash-card.is-ask [data-answer="deny"]')?.click(); true`)
  await waitFor('an answer', async () => (await answers()).length > 0, 5000).catch(() => undefined)
  await noCard()
  const a2 = await answers()
  check('codex: Deny on the tile declines that approval, once', a2.length === 1 && a2[0].result?.decision === 'decline', JSON.stringify(a2))
  await waitFor('idle again', () => core.sessions.view(id)?.status === 'idle', 5000).catch(() => undefined)
  check('codex: the card goes and the session goes on', (await card()) === null && core.sessions.view(id)?.status === 'idle', core.sessions.view(id)?.status)

  // 3. A file change: its path and diff from the item, Allow accepts.
  core.sessions.input(id, 'askfile\r')
  await waitFor('the card', async () => (await card()) !== null, 5000).catch(() => undefined)
  const c3 = await card()
  check('codex: a file change shows its file and diff', !!c3 && c3.tool === 'Edit' && c3.label === join(cwd, 'notes.md') && c3.body === '+# Notes', JSON.stringify(c3))
  await js(`document.querySelector('.leash-card.is-ask [data-answer="allow"]')?.click(); true`)
  await waitFor('an answer', async () => (await answers()).length > 1, 5000).catch(() => undefined)
  await noCard()
  const a3 = await answers()
  check('codex: Allow on the tile accepts it', a3.length === 2 && a3[1].result?.decision === 'accept' && (await card()) === null, JSON.stringify(a3))

  // 4. A permissions request (a grant, not a yes) and a question: shown for the terminal, never answered.
  core.sessions.input(id, 'askperm\r')
  await waitFor('the card', async () => (await card()) !== null, 5000).catch(() => undefined)
  await sleep(800)
  const c4 = await card()
  check('codex: a permissions request shows with no buttons ("answer in the terminal")', !!c4 && c4.tool === 'Permissions' && c4.label === 'needs the network' && c4.buttons.length === 0 && /terminal/i.test(c4.note), JSON.stringify(c4))
  check('codex: a question (requestUserInput) is neither shown nor answered', core.sessions.view(id)?.leash.asks.length === 1 && (await answers()).length === 2, JSON.stringify(core.sessions.view(id)?.leash.asks.map((a) => a.tool)))
  const permAsk = core.sessions.view(id)?.leash.asks[0]
  check('codex: the window cannot answer a terminal-only request', (await js(`window.core.answerPermission(${JSON.stringify(id)}, ${JSON.stringify(permAsk?.id ?? '')}, true)`)) === false && (await answers()).length === 2)
  core.sessions.input(id, 'yes\r')
  await noCard()
  check('codex: answered in the terminal, it goes', (await card()) === null && (await answers()).length === 2)

  // Stop (item 2, Colin's choice: Codex cannot hold a call from outside): ■ while a turn runs, two clicks, turn/interrupt.
  const stopBtn = (): Promise<number> => js(`document.querySelectorAll('[data-leash="stop"]').length`)
  check('codex: no Stop while no turn runs', (await stopBtn()) === 0)
  await js(`window.core.leash(${JSON.stringify(id)}, 'pause')`)
  check('codex: a Codex session cannot be paused (no leash file, nothing held)', !core.sessions.view(id)?.leash.paused && !existsSync(join(core.leash.dir, `${id}.paused`)))
  core.sessions.input(id, 'slow\r')
  await waitFor('the slow turn', () => core.sessions.view(id)?.status === 'busy', 5000).catch(() => undefined)
  await waitFor('Stop', async () => (await stopBtn()) > 0, 5000).catch(() => undefined)
  check('codex: Stop shows while a turn runs, in place of pause', (await stopBtn()) > 0 && (await js(`document.querySelectorAll('.session-tile[data-session="${id}"] .leash-toggle, .focus-pane .leash-toggle').length`)) === 0)
  await js(`document.querySelector('[data-leash="stop"]')?.click(); true`)
  await sleep(300)
  const armedTxt = (await js(`document.querySelector('[data-leash="stop"]')?.textContent`)) as string
  check('codex: the first click only arms it', armedTxt === 'stop' && !existsSync(`${sock}.interrupts.json`), armedTxt)
  await js(`document.querySelector('[data-leash="stop"]')?.click(); true`)
  await waitFor('the interrupt', () => existsSync(`${sock}.interrupts.json`), 5000).catch(() => undefined)
  const ints = JSON.parse(await readFile(`${sock}.interrupts.json`, 'utf8').catch(() => '[]')) as { threadId?: string; turnId?: string }[]
  check('codex: the second click interrupts the running turn (its id from turn/started)', ints.length === 1 && ints[0].threadId === threadId && /^[0-9a-f-]{36}$/.test(ints[0].turnId ?? ''), JSON.stringify(ints))
  await waitFor('idle after the stop', () => core.sessions.view(id)?.status === 'idle', 5000).catch(() => undefined)
  const lastTool = [...(core.transcripts.get(id)?.blocks ?? [])].reverse().find((b) => b.kind === 'tool')
  check('codex: stopped, the session is idle, its command marked failed, and Stop goes', core.sessions.view(id)?.status === 'idle' && lastTool?.kind === 'tool' && lastTool.label === 'sleep 600' && lastTool.error && (await stopBtn()) === 0, JSON.stringify(lastTool))

  // Commits (item 3): a command that commits is recorded as this session's, as a Claude session's Bash call.
  const gc = (...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  gc('init', '-q', '-b', 'main')
  core.sessions.input(id, 'commit\r')
  await waitFor('the commit', () => { try { return gc('rev-parse', 'HEAD').length === 40 } catch { return false } }, 5000).catch(() => undefined)
  const headSha = (() => { try { return gc('rev-parse', 'HEAD') } catch { return '' } })()
  await waitFor('the record', () => core.commits.store.has(headSha), 5000).catch(() => undefined)
  const recd = core.commits.store.all().find((x) => x.sha === headSha)
  check('codex: a commit a Codex command made is recorded as its session\'s', !!headSha && recd?.session === id && recd.name === 'codex-one', JSON.stringify(recd))
  core.sessions.input(id, 'quietcommit\r')
  await waitFor('the quiet commit', () => { try { return gc('log', '-1', '--format=%s') === 'quiet' } catch { return false } }, 5000).catch(() => undefined)
  const quietSha = (() => { try { return gc('rev-parse', 'HEAD') } catch { return '' } })()
  await waitFor('its record', () => core.commits.store.has(quietSha), 5000).catch(() => undefined)
  check('codex: a commit whose command the server never sent live is found when its turn is read back', quietSha !== headSha && core.commits.store.all().find((x) => x.sha === quietSha)?.session === id)

  // The wolfpack (item 4): a Codex subagent is a child thread; it shows in a pack tile under the session.
  await js(`document.querySelector('.session-plus')?.click(); true`) // the column shows the session's tile and its pack
  core.sessions.input(id, 'spawn\r')
  const pack = `document.querySelector('.pack-tile[data-pack="${id}"]')`
  await waitFor('the pack tile', async () => (await js(`!!${pack}?.querySelector('.pack-chip')`)) === true, 8000).catch(() => undefined)
  await waitFor('its words', async () => /OK/.test((await js(`${pack}?.querySelector('.chat')?.textContent ?? ''`)) as string), 5000).catch(() => undefined)
  const p1 = (await js(`(() => { const p = ${pack}; return p && { chips: [...p.querySelectorAll('.pack-chip-name')].map((x) => x.textContent), chat: p.querySelector('.chat')?.textContent ?? '', kind: p.querySelector('.pack-kind')?.textContent ?? '', pause: !!p.querySelector('.pack-pause') } })()`)) as { chips: string[]; chat: string; kind: string; pause: boolean } | null
  check('codex: a subagent shows in a pack tile under its session: its name, kind, and what it said', !!p1 && p1.chips.join() === 'Beauvoir' && /OK/.test(p1.chat) && /gpt-fake/.test(p1.kind), JSON.stringify(p1))
  const pa = core.agentsState().agents.find((a) => a.parent === id)
  check('codex: it finished when its parent heard so', !!pa && pa.endedAt !== null && pa.cli === 'codex', JSON.stringify(pa && { endedAt: pa.endedAt, cli: pa.cli }))
  core.sessions.input(id, 'spawnslow\r')
  await waitFor('the running one', () => core.agentsState().agents.filter((a) => a.parent === id && a.endedAt === null).length === 1, 8000).catch(() => undefined)
  await waitFor('its kill button', async () => (await js(`!!${pack}?.querySelector('.pack-kill')`)) === true, 5000).catch(() => undefined)
  const runId = core.agentsState().agents.find((a) => a.parent === id && a.endedAt === null)?.id ?? ''
  check('codex: a running subagent has kill and no pause (Codex cannot hold its calls)', (await js(`!!${pack}?.querySelector('.pack-kill') && !${pack}?.querySelector('.pack-pause')`)) === true)
  await js(`${pack}?.querySelector('.pack-kill')?.click(); true`)
  await sleep(200)
  await js(`${pack}?.querySelector('.pack-kill')?.click(); true`)
  await waitFor('it goes', () => !core.agentsState().agents.some((a) => a.id === runId), 5000).catch(() => undefined)
  const flat = async (): Promise<string> => (await screen(id)).replace(/\n/g, '') // the pane wraps long lines
  await waitFor('the parent told', async () => (await flat()).includes('The user stopped your sub-agent'), 5000).catch(() => undefined)
  const ints2 = JSON.parse(await readFile(`${sock}.interrupts.json`, 'utf8').catch(() => '[]')) as { threadId?: string }[]
  check('codex: kill (two clicks): the tile goes, the subagent\'s turn (not the session\'s) is interrupted, and the session is told in one typed line', ints2.some((x) => x.threadId === runId) && !ints2.slice(1).some((x) => x.threadId === threadId) && !core.agentsState().agents.some((a) => a.id === runId) && (await flat()).includes('The user stopped your sub-agent “Beauvoir” (/root/ok_agent)'), `${JSON.stringify(ints2)} ${(await flat()).slice(-400)}`)
  await waitFor('idle', () => core.sessions.view(id)?.status === 'idle', 5000).catch(() => undefined)
  for (const a of core.agentsState().agents.filter((x) => x.parent === id)) await js(`window.core.agents.dismiss(${JSON.stringify(a.id)})`)
  check('codex: × clears them', core.agentsState().agents.filter((x) => x.parent === id).length === 0)

  // Its tile in the column: the codex badge, and no pause (the leash is Claude Code's hooks).
  await js(`document.querySelector('.session-plus')?.click(); true`)
  const tile = `document.querySelector('.session-tile[data-session="${id}"]')`
  await waitFor('its tile', async () => (await js(`!!${tile}`)) === true, 5000).catch(() => undefined)
  const head = (await js(`(() => { const t = ${tile}; return t && { badges: [...t.querySelectorAll('.head .badge')].map((b) => b.textContent.trim()), pause: !!t.querySelector('.head .leash-toggle') } })()`)) as { badges: string[]; pause: boolean } | null
  check('codex: its tile wears a codex badge and no pause (Stop instead, while a turn runs)', !!head && head.badges.includes('codex') && !head.pause, JSON.stringify(head))
  await waitFor('its conversation', async () => (await js(`!!${tile}?.querySelector('.chat-tool')`)) === true, 5000).catch(() => undefined)
  const drawn = (await js(`(() => { const t = ${tile}; return t && { user: t.querySelector('.chat-user')?.textContent, bold: t.querySelector('.chat-text strong')?.textContent, tool: t.querySelector('.chat-tool')?.textContent, title: t.querySelector('.subname')?.textContent } })()`)) as Record<string, string> | null
  check('codex: its tile draws the conversation as a Claude session\'s: prompt, markdown, tool line, title', !!drawn && drawn.user === 'hello codex' && drawn.bold === 'hello.txt' && /touch hello\.txt/.test(drawn.tool ?? '') && (drawn.title ?? '').includes('Make hello.txt'), JSON.stringify(drawn))

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
  const wtServer = JSON.parse(await readFile(join(userData, `fake-codex-server-${wtId}.json`), 'utf8').catch(() => '{}')) as { cwd?: string; argv?: string[] }
  const wtRec = core.sessions.find(wtId)
  check('codex: a worktree session starts in .workshop/worktrees/<name> on worktree-<name>, made by core', wtRec?.cwd === wtPath && wtRec.worktree && wtRec.name === 'codex-wt' && g('worktree', 'list').includes(wtPath) && execFileSync('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim() === 'worktree-codex-wt', JSON.stringify(wtRec && { cwd: wtRec.cwd, name: wtRec.name }))
  check('codex: its TUI and server both run in the worktree, and Codex never sees --worktree', wtArgv.join(' ').includes(`-C ${wtPath}`) && !wtArgv.includes('--worktree') && wtServer.cwd === wtPath, `${wtArgv.join(' ')} | ${wtServer.cwd}`)
  check('codex: the worktree core made is trusted for its own server only (no "Trust this folder?")', (wtServer.argv ?? []).join(' ') === `app-server --listen unix://${wtSock} -c projects={${JSON.stringify(wtPath)}={trust_level="trusted"}}`, (wtServer.argv ?? []).join(' '))
  check('codex: the main tree stays clean (.workshop/ is excluded, nothing tracked changed)', g('status', '--porcelain') === '', g('status', '--porcelain'))
  await core.sessions.kill(wtId)

  // Kill: gone, and its socket with it.
  await core.sessions.resume(id)
  await waitFor('the TUI again', async () => (await screen(id)).includes('CONNECTED'), 15_000).catch(() => undefined)
  await core.sessions.kill(id)
  check('codex: kill forgets the session and removes its socket', !core.sessions.find(id) && !existsSync(sock) && !(await core.tmux.hasSession(`ws-${id}`)))
}
