// Smoke checks for track E's first half (called from smoke.ts's sessions run): the preview pane
// opened by a session's `doc` CLI and by a click on a path in a conversation, a task box ticked on
// disk, reload on a change and the unsaved-edits guard, ⌘S; a tile and a session dragged to a new
// place (and ⌘1–9 following the session column's order).
//
// Drags are dispatched as DOM events in core's window: the smoke window is hidden,
// and a real drag cannot be injected into it. What they exercise is the handlers and the order; that
// a real pointer drag gets through a tile's webview is the `ws-dragging` style, checked here by its
// computed value.

import type { BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoreSessions } from './core-sessions'
import type { Door } from './door'

type Check = (name: string, ok: boolean, detail?: string) => void

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return true
    await sleep(100)
  }
  return false
}

const PLAN = ['# Smoke plan', '', 'Some **prose** first.', '', '- [ ] write the pane', '- [x] read deck', '  - [ ] a nested one', ''].join('\n')

/** `id` is an open, focused session started in `cwd`. Leaves it focused, its terminal in the center. */
export async function previewSmoke(check: Check, o: { win: BrowserWindow; door: Door; core: CoreSessions; userData: string }, id: string, cwd: string): Promise<void> {
  const { win, core } = o
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const turn = async (line: string): Promise<string> => {
    await js(`window.core.ptyInput(${JSON.stringify(id)}, ${JSON.stringify(line + '\r')}); true`)
    await waitFor(async () => (await screen()).includes(`DONE ${line}`))
    return screen()
  }
  const shown = (): Promise<string | null> => js(`document.querySelector('.preview')?.dataset.preview ?? null`)
  const terminals = (): Promise<number> => js(`document.querySelectorAll('.term-host .xterm').length`)
  const plan = join(cwd, 'plan.md')
  await writeFile(plan, PLAN)
  await writeFile(join(cwd, 'README.md'), '# Readme\n\nThe smoke project.\n')
  await mkdir(join(cwd, 'notes'), { recursive: true })
  await writeFile(join(cwd, 'notes', 'a.md'), '# Notes A\n')
  await writeFile(join(cwd, 'data.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  await writeFile(join(cwd, 'code.ts'), Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n'))

  // ---- the doc CLI, from inside the session, with its own token
  const out = await turn('doc open plan.md --line 5')
  // The screen wraps long lines, so the JSON is compared without its spaces.
  const flat = out.replace(/\s+/g, '')
  check('preview: the doc CLI answers from inside a session', flat.includes('"kind":"markdown"') && flat.includes('"editable":true') && flat.includes(`"path":"${plan}"`), out.slice(-300))
  await waitFor(async () => (await shown()) === plan)
  check('preview: the session\'s doc open shows the file in the center', (await shown()) === plan, String(await shown()))
  check('preview: the terminal gives way to it, and the session shows as a tile', (await terminals()) === 0 && (await js(`!!document.querySelector('.session-tile[data-session="${id}"]')`)) === true)
  // --line on a markdown file shows it as written, scrolled to that line and marked.
  check('preview: --line marks the line', (await js(`document.querySelector('.preview-row[data-hit="1"]')?.textContent ?? ''`)).includes('- [ ] write the pane'))
  await js(`[...document.querySelectorAll('.preview .preview-btn')].find((b) => b.textContent === 'source').click(); true`)
  await waitFor(async () => (await js(`!!document.querySelector('.preview-md')`)) === true, 2000)
  check('preview: markdown renders through the tree, in the reading face', (await js(`(() => { const m = document.querySelector('.preview-md'); return !!m && m.querySelector('strong')?.textContent === 'prose' && m.querySelectorAll('.md-task input').length === 3 && getComputedStyle(m).fontFamily.includes('Source Serif') })()`)) === true)

  // ---- a box ticked in the pane changes that one line on disk
  await js(`document.querySelector('.preview-md .md-task input').click(); true`)
  await waitFor(async () => (await readFile(plan, 'utf8')) !== PLAN, 3000)
  const ticked = await readFile(plan, 'utf8')
  check('preview: ticking a box writes that one character to disk', ticked === PLAN.replace('- [ ] write the pane', '- [x] write the pane'), JSON.stringify(ticked))
  await waitFor(async () => (await js(`document.querySelector('.preview-md .md-task input').checked`)) === true, 2000)
  check('preview: the box shows ticked after', (await js(`document.querySelector('.preview-md .md-task input').checked`)) === true)

  // ---- a change on disk reloads it (no unsaved edits)
  await writeFile(plan, ticked + '- [ ] added on disk\n')
  check('preview: a change on disk reloads the pane', await waitFor(async () => (await js(`document.querySelectorAll('.preview-md .md-task input').length`)) === 4, 4000))

  // ---- edit and ⌘S
  const setDraft = (text: string): Promise<unknown> =>
    js(`(() => { const ta = document.querySelector('.preview-edit'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await js(`[...document.querySelectorAll('.preview .preview-btn')].find((b) => b.textContent === 'edit').click(); true`)
  await waitFor(async () => (await js(`!!document.querySelector('.preview-edit')`)) === true, 2000)
  check('preview: edit turns the file into an editor in the mono face', (await js(`getComputedStyle(document.querySelector('.preview-edit')).fontFamily`)).includes('JetBrains Mono'))
  await setDraft('# Edited in the pane\n')
  await sleep(100)
  check('preview: unsaved edits are marked', (await js(`!!document.querySelector('.preview-dirty')`)) === true)
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })); true`)
  check('preview: ⌘S saves', await waitFor(async () => (await readFile(plan, 'utf8')) === '# Edited in the pane\n', 3000), await readFile(plan, 'utf8'))
  await waitFor(async () => (await js(`!document.querySelector('.preview-dirty')`)) === true, 2000)

  // ---- a change on disk while there are unsaved edits: said, and the edits are kept
  await setDraft('# My unsaved words\n')
  await sleep(100)
  await writeFile(plan, '# Someone else wrote this\n')
  const warned = await waitFor(async () => String(await js(`document.querySelector('.preview-bar')?.textContent ?? ''`)).includes('changed on disk'), 4000)
  check('preview: a change on disk with unsaved edits is said, not loaded over them', warned && (await js(`document.querySelector('.preview-edit').value`)) === '# My unsaved words\n')
  // Closing now asks first (in the pane), and "keep editing" keeps everything.
  await js(`document.querySelector('.preview > .head .ghost').click(); true`)
  await sleep(150)
  check('preview: closing with unsaved edits asks first', String(await js(`document.querySelector('.preview-bar')?.textContent ?? ''`)).includes('unsaved edits') && (await shown()) === plan)
  await js(`[...document.querySelectorAll('.preview-bar .preview-btn')].find((b) => b.textContent === 'keep editing').click(); true`)
  await js(`[...document.querySelectorAll('.preview-bar .preview-btn')].find((b) => b.textContent === 'reload').click(); true`)
  check('preview: reload takes the file as it is on disk', await waitFor(async () => String(await js(`document.querySelector('.preview-md')?.textContent ?? ''`)).includes('Someone else wrote this'), 3000))

  // WORKSHOP_SHOT_PREVIEW=<png>: the pane with a markdown file, beside the session as a tile.
  await writeFile(plan, PLAN)
  await waitFor(async () => (await js(`document.querySelectorAll('.preview-md .md-task input').length`)) === 3, 3000)
  if (process.env.WORKSHOP_SHOT_PREVIEW) {
    await sleep(600)
    await writeFile(process.env.WORKSHOP_SHOT_PREVIEW, (await win.webContents.capturePage()).toPNG())
  }

  // ---- closing returns the center to what it showed before: the session's terminal
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
  await waitFor(async () => (await terminals()) === 1, 3000)
  check('preview: Esc closes it and the session\'s terminal comes back', (await shown()) === null && (await terminals()) === 1)

  // ---- refused politely: a binary, through the CLI; code in mono with numbers
  await turn('doc open data.bin')
  await waitFor(async () => (await shown()) === join(cwd, 'data.bin'))
  check('preview: a binary is refused politely', String(await js(`document.querySelector('.preview-refused')?.textContent ?? ''`)).includes('binary'))
  await turn('doc open code.ts:12')
  await waitFor(async () => (await shown()) === join(cwd, 'code.ts'))
  check('preview: code is shown in mono with line numbers, path:N marks the line', (await js(`(() => { const r = document.querySelector('.preview-row[data-hit="1"]'); return !!r && r.textContent.includes('line12') && getComputedStyle(r).fontFamily.includes('JetBrains Mono') })()`)) === true)
  const nope = await turn('doc open nowhere.md')
  check('preview: a missing file is refused by the CLI', nope.includes('no such file'), nope.slice(-200))
  const outside = await fetch(`http://127.0.0.1:${o.door.port}/core/doc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.door.token}` }, body: JSON.stringify({ op: 'open', path: plan }) })
  check('preview: /core/doc refuses a caller that is not a session', outside.status === 400)
  const noToken = await fetch(`http://127.0.0.1:${o.door.port}/core/doc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'open', path: plan }) })
  check('preview: /core/doc refuses a call with no token', noToken.status === 401)
  await js(`document.querySelector('.preview > .head .ghost').click(); true`)
  await waitFor(async () => (await terminals()) === 1, 3000)

  // ---- a path printed in the center terminal is a link to the preview pane
  const lines = (await turn('notes/a.md')).split('\n')
  const row = lines.findIndex((l) => l.includes('notes/a.md'))
  const col = row < 0 ? -1 : lines[row].indexOf('notes/a.md') + 2
  await js(`(() => {
    const scr = document.querySelector('.term-host .xterm-screen'), r = scr.getBoundingClientRect()
    const rows = ${lines.length}
    const ch = r.height / rows
    const probe = document.querySelector('.term-host .xterm-char-measure-element')
    const cw = probe ? probe.getBoundingClientRect().width / Math.max(1, probe.textContent.length) : 0
    const at = { clientX: r.left + (${col} + 0.5) * cw, clientY: r.top + (${row} + 0.5) * ch, bubbles: true, button: 0 }
    scr.dispatchEvent(new MouseEvent('mousemove', at))
    window.__termAt = at
    return true
  })()`)
  await sleep(300)
  await js(`(() => { const scr = document.querySelector('.term-host .xterm-screen'), at = window.__termAt
    scr.dispatchEvent(new MouseEvent('mousedown', at)); scr.dispatchEvent(new MouseEvent('mouseup', at)); scr.dispatchEvent(new MouseEvent('click', at)); return true })()`)
  await waitFor(async () => (await shown()) === join(cwd, 'notes', 'a.md'), 3000)
  check('preview: a path in the center terminal opens, resolved against the session\'s folder', (await shown()) === join(cwd, 'notes', 'a.md'), `${String(await shown())} row ${row} col ${col}`)
  await js(`document.querySelector('.preview > .head .ghost')?.click(); true`)
  await waitFor(async () => (await terminals()) === 1, 3000)

  // ⌘-click hands a file to its Mac app; never anything that would run (not tried with a real file: it would open an app)
  await writeFile(join(cwd, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(cwd, 'tool'), 'x', { mode: 0o755 })
  const refused = await js(`Promise.all(['run.sh', 'tool', 'nowhere.md', 'X.app'].map((p) => window.core.openFileApp(p, ${JSON.stringify(cwd)})))`)
  check('preview: ⌘-click refuses scripts, executables, apps and missing files', JSON.stringify(refused) === '[false,false,false,false]', JSON.stringify(refused))

  // ---- a session tile has no links (Colin, 11 Nov 2026): a path in its prose is text
  await js(`document.querySelector('.session-plus').click(); true`)
  const tile = `document.querySelector('.session-tile[data-session="${id}"]')`
  await waitFor(async () => (await js(`[...(${tile}?.querySelectorAll('.chat-text') ?? [])].some((e) => e.textContent.includes('notes/a.md'))`)) === true)
  check('preview: a session tile draws paths and links as text, never as links', (await js(`${tile}.querySelectorAll('.chat a').length`)) === 0)

}

/**
 * Drag to reorder: the probe and Wikipedia tiles swapped in the tile column and the order saved in
 * settings; two sessions swapped in the session column, ⌘1 following, and "most recent first" back.
 */
export async function reorderSmoke(check: Check, o: { win: BrowserWindow; core: CoreSessions; userData: string }, first: string, cwd: string): Promise<void> {
  const { win, core } = o
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  // A drag as the browser would send it: dragstart on the grip, dragover and drop on the target's top half.
  const drag = (grip: string, target: string): Promise<unknown> =>
    js(`(async () => {
      const dt = new DataTransfer()
      const g = ${grip}, t = ${target}
      g.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
      window.__dragging = document.documentElement.classList.contains('ws-dragging')
      window.__through = getComputedStyle(document.querySelector('.tile-page')).pointerEvents
      const r = t.getBoundingClientRect()
      const at = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 4 }
      t.dispatchEvent(new DragEvent('dragover', at))
      await new Promise((r) => setTimeout(r, 30))
      window.__bar = t.className
      t.dispatchEvent(new DragEvent('drop', at))
      g.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
      return true
    })()`)
  const tiles = (): Promise<string[]> => js(`[...document.querySelectorAll('.tiles .tile[data-tile]')].map((t) => t.dataset.tile)`)

  const before = await tiles()
  const last = before[before.length - 1]
  await drag(`document.querySelector('.tile[data-tile="${last}"] .grip')`, `document.querySelector('.tile[data-tile="${before[0]}"]')`)
  check('reorder: while a tile is dragged, the tile pages let the pointer through', (await js('window.__dragging')) === true && (await js('window.__through')) === 'none', `${await js('window.__dragging')} ${await js('window.__through')}`)
  check('reorder: a bar shows where it will land', String(await js('window.__bar')).includes('drop-before'))
  await waitFor(async () => (await tiles())[0] === last, 2000)
  const after = await tiles()
  check('reorder: a tile dropped on the top half of another lands before it', after[0] === last && after.length === before.length, `${before.join(',')} → ${after.join(',')}`)
  check('reorder: the drag is over, the pages take the pointer again', (await js(`document.documentElement.classList.contains('ws-dragging')`)) === false && (await js(`getComputedStyle(document.querySelector('.tile-page')).pointerEvents`)) === 'auto')
  await sleep(300)
  const saved = JSON.parse(await readFile(join(o.userData, 'settings.json'), 'utf8')).column as { order?: string[] }
  check('reorder: the tile column\'s order is saved in settings.column', saved.order?.[0] === last, JSON.stringify(saved))
  // The window reloads: the order comes back from settings.
  win.webContents.reload()
  await waitFor(async () => ((await tiles().catch(() => [])) as string[]).length === before.length, 8000)
  check('reorder: the order survives a reload of the window', (await tiles())[0] === last, (await tiles()).join(','))

  // ---- the session column: two open sessions, the second dragged above the first
  const two = String((await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: 'smoke-drag' })`)).id)
  await waitFor(async () => ((await core.tmux.screen(`ws-${two}`))?.text ?? '').includes('FAKE CLAUDE READY'))
  await js(`document.querySelector('.session-plus').click(); true`)
  await waitFor(async () => (await js(`document.querySelectorAll('.session-tile').length`)) === 2)
  const keyOf = (s: string): Promise<string> => js(`document.querySelector('[data-session="${s}"] .key')?.textContent ?? ''`)
  check('reorder: before any drag, ⌘ numbers follow the order sessions started', (await keyOf(first)) === '⌘1' && (await keyOf(two)) === '⌘2')
  const col = (): Promise<string[]> => js(`[...document.querySelectorAll('.session-scroll > [data-session]')].map((t) => t.dataset.session)`)
  const firstTop = (await col())[0]
  const other = firstTop === first ? two : first
  await drag(`document.querySelector('[data-session="${other}"] .grip')`, `document.querySelector('.session-scroll > [data-session="${firstTop}"]')`)
  await waitFor(async () => (await col())[0] === other, 2000)
  check('reorder: a session dragged to the top stays there', (await col())[0] === other, (await col()).join(','))
  check('reorder: once dragged, ⌘1 is the top tile', (await keyOf(other)) === '⌘1' && (await keyOf(firstTop)) === '⌘2')
  // Activity no longer reorders the column: a turn in the lower one leaves it below.
  await js(`window.core.ptyInput(${JSON.stringify(firstTop)}, 'still below\\r'); true`)
  await waitFor(async () => ((await core.tmux.screen(`ws-${firstTop}`))?.text ?? '').includes('DONE still below'))
  await sleep(400)
  check('reorder: a dragged order is kept while sessions work', (await col())[0] === other)
  await sleep(300)
  const savedS = JSON.parse(await readFile(join(o.userData, 'settings.json'), 'utf8')).column as { sessions?: string[] }
  check('reorder: the session order is saved in settings.column', savedS.sessions?.[0] === other, JSON.stringify(savedS))
  await js(`document.querySelector('.session-recent').click(); true`)
  await waitFor(async () => (await keyOf(first)) === '⌘1', 2000)
  check('reorder: "most recent first" goes back to the column by recency and ⌘ by start', (await keyOf(first)) === '⌘1' && (await col())[0] === firstTop)

  await js(`window.core.kill(${JSON.stringify(two)})`)
  await waitFor(() => !core.sessions.getState().sessions.some((s) => s.id === two), 3000)
  await js(`window.core.focusSession(${JSON.stringify(first)})`)
  await waitFor(async () => (await js(`document.querySelectorAll('.term-host .xterm').length`)) === 1, 3000)
}
