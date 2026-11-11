// Smoke checks for the leash and permission prompts answered from a session's tile (main/leash.ts,
// Leash.tsx; docs/progress/2026-11-11-leash.md), with the stand-in CLI, which fires PreToolUse and
// PermissionRequest the way Claude Code 2.1.322 does (test/fixtures/fake-claude/claude). The
// buttons are clicked in the window, on the session's tile and on the center's head. What happens
// to a held call across a restart of core is in smoke.ts's `restart`.

import type { BrowserWindow, WebContents } from 'electron'
import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreSessions } from './core-sessions'
import type { Door } from './door'

type Check = (name: string, ok: boolean, detail?: string) => void

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return true
    await sleep(100)
  }
  return false
}
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)
/** `WORKSHOP_SHOT_LEASH=<prefix>` saves pictures of the cards: <prefix>-tile.png, <prefix>-center.png. */
async function shot(win: BrowserWindow, name: string): Promise<void> {
  if (!process.env.WORKSHOP_SHOT_LEASH) return
  await sleep(400)
  await writeFile(`${process.env.WORKSHOP_SHOT_LEASH}-${name}.png`, (await win.webContents.capturePage()).toPNG())
}

export async function leashSmoke(check: Check, o: { win: BrowserWindow; door: Door; core: CoreSessions; userData: string; liveByTile: Map<string, { wc: WebContents }> }): Promise<void> {
  const { win, door, core, userData } = o
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ws-leash-')))
  const id = String((await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: 'leashed' })`)).id)
  const screen = async (): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const seen = (s: string) => async (): Promise<boolean> => (await screen()).includes(s)
  const view = () => core.sessions.view(id)!
  const type = (line: string): Promise<unknown> => js(`window.core.ptyInput(${JSON.stringify(id)}, ${JSON.stringify(`${line}\r`)}); true`)
  const tile = `.session-tile[data-session="${id}"]`
  const center = `.focus-pane[data-session="${id}"]`
  const text = (sel: string): Promise<string> => js(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`)
  const click = (sel: string): Promise<boolean> => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true })()`)
  const pausedFile = join(userData, 'leash', `${id}.paused`)
  await waitFor(seen('FAKE CLAUDE READY'), 10_000)

  const settings = JSON.parse(await readFile(core.settings.path, 'utf8')) as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> }
  check('leash: every session is started with PreToolUse and PermissionRequest hooks that wait', !!settings.hooks.PreToolUse?.[0] && !!settings.hooks.PermissionRequest?.[0] && settings.hooks.PreToolUse[0].hooks[0].timeout > 3600, JSON.stringify(Object.keys(settings.hooks)))

  // Not paused: a tool call goes straight through.
  const t0 = Date.now()
  await type('bash echo free-call')
  const free = await waitFor(seen('BASH free-call'), 5000)
  check('leash: an unpaused session’s tool call is not held', free && view().leash.held.length === 0, `${Date.now() - t0} ms`)
  await waitFor(seen('DONE bash echo free-call'))

  // Pause from the center's head (the new session is focused).
  check('leash: the center head has a pause button', await click(`${center} [data-leash="pause"]`))
  await waitFor(() => view().leash.paused)
  check('leash: pausing writes the pause where the hook looks for it', view().leash.paused && (await exists(pausedFile)))
  await waitFor(async () => (await js(`!!document.querySelector('${center} [data-leash="resume"]')`)) === true, 2000)
  check('leash: the head shows resume while paused', (await js(`!!document.querySelector('${center} [data-leash="resume"]')`)) === true)

  // The next tool call is held, shown with its command, and refused from the center.
  await type('bash echo after-the-pause')
  const held = await waitFor(() => view().leash.held.length === 1)
  check('leash: a paused session’s next tool call is held', held, JSON.stringify(view().leash))
  await sleep(1200)
  check('leash: and does not run while held', !(await screen()).includes('BASH after-the-pause'))
  await waitFor(async () => (await text(`${center} .leash-card`)).includes('echo after-the-pause'), 2000)
  const card = await text(`${center} .leash-card`)
  check('leash: the center shows the held call as text', card.includes('Bash') && card.includes('echo after-the-pause'), card)
  check('leash: refuse from the center', await click(`${center} [data-leash-action="refuse"]`))
  const refused = await waitFor(seen('DENIED The user paused this session'))
  check('leash: a refused call is denied with the reason, and the session stays paused', refused && view().leash.paused && !(await screen()).includes('BASH after-the-pause'), (await screen()).slice(-300))
  await waitFor(seen('DONE bash echo after-the-pause'))

  // From the tile: the session out of the center, its call held, resumed from the card on its tile.
  await js(`window.core.focusSession(null)`)
  await waitFor(async () => (await js(`!!document.querySelector('${tile}')`)) === true, 3000)
  check('leash: the tile head shows resume while paused', (await js(`!!document.querySelector('${tile} .head [data-leash="resume"]')`)) === true)
  await type('bash echo resumed-call')
  await waitFor(() => view().leash.held.length === 1)
  await waitFor(async () => (await text(`${tile} .leash-card`)).includes('echo resumed-call'), 2000)
  check('leash: the tile shows the held call', (await text(`${tile} .leash-card`)).includes('echo resumed-call'), await text(tile))
  check('leash: resume from the tile', await click(`${tile} [data-leash-action="resume"]`))
  const resumed = await waitFor(seen('BASH resumed-call'))
  check('leash: resume lets the held call run', resumed && !view().leash.paused && view().leash.held.length === 0)
  check('leash: and takes the pause off the disk', !(await exists(pausedFile)))
  await waitFor(seen('DONE bash echo resumed-call'))

  // Only the session itself can be held, and nothing reaches a tile.
  await js(`window.core.leash(${JSON.stringify(id)}, 'pause')`)
  const ask = async (headers: Record<string, string>, sessionId: string): Promise<[number, number]> => {
    const t = Date.now()
    const res = await fetch(`http://127.0.0.1:${door.port}/ask/pretool`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'x' } }) })
    return [res.status, Date.now() - t]
  }
  const outside = await ask({ Authorization: `Bearer ${door.token}` }, core.sessions.find(id)!.claudeSessionId)
  check('leash: a caller outside any session is never held', outside[0] === 204 && outside[1] < 1000, JSON.stringify(outside))
  const header = (await readFile(JSON.parse(await readFile(join(userData, `fake-${id}.json`), 'utf8')).auth, 'utf8')).trim()
  const spoof = await ask({ Authorization: header.replace(/^Authorization:\s*/, '') }, '00000000-0000-0000-0000-000000000000')
  check('leash: a session naming another session’s id is not held', spoof[0] === 204 && spoof[1] < 1000 && view().leash.held.length === 0, JSON.stringify(spoof))
  const browser = await ask({ Authorization: `Bearer ${door.token}`, Origin: 'https://example.com' }, 'x')
  check('leash: a browser cannot reach it', browser[0] === 403, JSON.stringify(browser))
  await js(`window.core.leash(${JSON.stringify(id)}, 'resume')`)
  const probe = o.liveByTile.get('probe')?.wc
  const list = probe ? ((await probe.executeJavaScript('workshop.sessions.list()')) as Record<string, unknown>[]) : []
  const keys = [...new Set(list.flatMap((x) => Object.keys(x)))]
  const mine = list.find((x) => x.id === id)
  check('leash: a tile’s sessions list carries no pause, held call or prompt', !!mine && !keys.some((k) => /leash|ask|held|pause/i.test(k)) && !JSON.stringify(list).includes('echo '), keys.join(' '))
  check('leash: a tile has no way to answer', probe ? (await probe.executeJavaScript(`typeof window.core === 'undefined' && !('leash' in workshop) && !('answerPermission' in workshop.sessions)`)) === true : false)

  // A permission prompt, answered from the tile: Allow.
  await type('perm touch allowed-from-tile.txt')
  const asked = await waitFor(() => view().leash.asks.length === 1)
  check('permission: the prompt reaches core while the terminal shows it', asked && (await screen()).includes('PERMISSION? touch allowed-from-tile.txt'), (await screen()).slice(-200))
  check('permission: the session needs you (the status mark)', view().status === 'blocked' && view().attention === true, `${view().status} ${view().attention}`)
  await waitFor(async () => (await text(`${tile} .leash-card.is-ask`)).includes('touch allowed-from-tile.txt'), 2000)
  const askCard = await js(`(() => { const c = document.querySelector('${tile} .leash-card.is-ask'); return c && { text: c.textContent, links: c.querySelectorAll('a').length, pre: c.querySelector('pre')?.textContent } })()`)
  check('permission: the tile shows the tool and its input as text, with no link', !!askCard && askCard.text.includes('Bash') && askCard.pre === 'touch allowed-from-tile.txt' && askCard.links === 0, JSON.stringify(askCard))
  await shot(win, 'tile')
  check('permission: Allow on the tile', await click(`${tile} .leash-card [data-answer="allow"]`))
  const allowed = await waitFor(seen('(allow)'))
  check('permission: allowed from the tile, the tool runs', allowed && (await exists(join(cwd, 'allowed-from-tile.txt'))), (await screen()).slice(-200))
  await waitFor(() => view().leash.asks.length === 0, 3000)
  await waitFor(async () => (await js(`!document.querySelector('${tile} .leash-card')`)) === true, 2000)
  check('permission: the card goes once answered', view().leash.asks.length === 0 && (await js(`!document.querySelector('${tile} .leash-card')`)) === true)
  await waitFor(seen('DONE perm touch allowed-from-tile.txt'))

  // Deny, from the center's head.
  await js(`window.core.focusSession(${JSON.stringify(id)})`)
  await type('perm touch denied-from-center.txt')
  await waitFor(() => view().leash.asks.length === 1)
  await waitFor(async () => (await text(`${center} .leash-card.is-ask`)).includes('denied-from-center'), 2000)
  check('permission: the center head shows it when the session is focused', (await text(`${center} .leash-card.is-ask`)).includes('touch denied-from-center.txt'))
  await shot(win, 'center')
  check('permission: Deny on the center head', await click(`${center} .leash-card [data-answer="deny"]`))
  const denied = await waitFor(seen('DENIED The user denied this tool call'))
  check('permission: denied from the center, the tool does not run and the session is told', denied && !(await exists(join(cwd, 'denied-from-center.txt'))), (await screen()).slice(-200))
  await waitFor(seen('DONE perm touch denied-from-center.txt'))

  // The terminal answers first: Yes. The hook is left running, as the real CLI leaves it; core sees
  // the tool finish (PostToolUse, posted only while a prompt is open) and the card goes.
  await type('perm touch yes-in-terminal.txt')
  await waitFor(() => view().leash.asks.length === 1)
  const stale = view().leash.asks[0]?.id ?? ''
  await type('y')
  const yes = await waitFor(seen('(yes)'))
  const goneYes = await waitFor(() => view().leash.asks.length === 0, 4000)
  check('permission: a Yes in the terminal takes the buttons off the tile', yes && goneYes && (await exists(join(cwd, 'yes-in-terminal.txt'))), JSON.stringify(view().leash))
  const late = (await js(`window.core.answerPermission(${JSON.stringify(id)}, ${JSON.stringify(stale)}, false)`)) as boolean
  check('permission: a late click finds nothing to answer', late === false)
  await waitFor(seen('DONE perm touch yes-in-terminal.txt'))

  // No in the terminal: the CLI kills the hook, and core sees it hang up.
  await type('perm touch no-in-terminal.txt')
  await waitFor(() => view().leash.asks.length === 1)
  await type('n')
  const no = await waitFor(seen('REJECTED'))
  const goneNo = await waitFor(() => view().leash.asks.length === 0, 4000)
  check('permission: a No in the terminal takes the buttons off the tile', no && goneNo && !(await exists(join(cwd, 'no-in-terminal.txt'))), JSON.stringify(view().leash))
  check('permission: nothing is left open', !(await exists(join(userData, 'leash', `${id}.asking`))))

  await js(`window.core.kill(${JSON.stringify(id)})`)
  await sleep(300)
}
