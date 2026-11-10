// Smoke checks for the UI fixes of 10 Nov 2026 (called from smoke.ts's sessions run, with `first`
// open and focused): the window's drag strip, what can be selected, session tiles one row of the
// tile column tall, and files dropped on a session (its tile, its prompt bar, its terminal).
//
// The smoke window is hidden, so nothing here is a real pointer: a real drag of the window, a real
// text selection and a real Finder drop still need a person. What is checked is what decides them:
// the computed -webkit-app-region of every element, laid over each other in document order the way
// Electron builds the window's drag region (drag adds, no-drag takes away); the computed
// user-select; and the drop handlers, fed synthetic DataTransfer drops whose file the stand-in CLI
// must receive as a path.

import type { BrowserWindow, WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { CoreSessions } from './core-sessions'

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

/** In the page: the window's drag region at a point, as Electron would build it from the DOM. */
const REGION_AT = `(() => {
  const val = (el) => { const cs = getComputedStyle(el); return cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') }
  const regions = []
  for (const el of document.querySelectorAll('body *')) {
    const v = val(el)
    if (v !== 'drag' && v !== 'no-drag') continue
    const r = el.getBoundingClientRect()
    if (r.width && r.height) regions.push([v, r])
  }
  return (x, y) => {
    let out = 'none'
    for (const [v, r] of regions) if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) out = v
    return out
  }
})()`

/** In the page: a drop of one small PNG named `name` on `target`, as the browser sends it. Returns whether the drop was claimed. */
const DROP = (target: string, name: string): string => `(() => {
  const t = ${target}
  if (!t) return 'no target'
  const dt = new DataTransfer()
  const b = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
  dt.items.add(new File([b], ${JSON.stringify(name)}, { type: 'image/png' }))
  const r = t.getBoundingClientRect()
  const at = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  t.dispatchEvent(new DragEvent('dragenter', at))
  const over = new DragEvent('dragover', at)
  t.dispatchEvent(over)
  const drop = new DragEvent('drop', at)
  t.dispatchEvent(drop)
  return over.defaultPrevented && drop.defaultPrevented
})()`

export async function uiSmoke(check: Check, o: { win: BrowserWindow; core: CoreSessions }, first: string, cwd: string): Promise<void> {
  const { win, core } = o
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (id: string): Promise<string> => ((await core.tmux.screen(`ws-${id}`))?.text ?? '').replace(/\s+/g, '')
  const focus = (): string | null => core.sessions.getState().focus

  // ---- the drag strip: every point of the empty top bar drags the window; its controls do not
  const bar = (await js(`(() => {
    const at = ${REGION_AT}
    const y = 44
    const controls = [...document.querySelectorAll('.topbar > *')].map((c) => c.getBoundingClientRect())
    const inControl = (x) => controls.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)
    const wrong = []
    let free = 0, ctl = 0
    for (let x = 90; x < innerWidth - 4; x += 12) {
      const v = at(x, y)
      if (inControl(x)) { ctl++; if (v !== 'no-drag') wrong.push(['control', x, v]) }
      else { free++; if (v !== 'drag') wrong.push(['bar', x, v]) }
    }
    // The top edge and the gap above the columns drag too; the columns themselves do not.
    for (const yy of [4, 80]) for (let x = 90; x < innerWidth - 4; x += 40) if (!controls.some((r) => x >= r.left && x < r.right && yy >= r.top && yy < r.bottom) && at(x, yy) !== 'drag') wrong.push(['edge', x, yy, at(x, yy)])
    const mid = document.querySelector('.col.center').getBoundingClientRect()
    const under = document.elementFromPoint(innerWidth / 2, y)
    return { free, ctl, wrong: wrong.slice(0, 8), column: at(mid.left + mid.width / 2, mid.top + mid.height / 2), under: under ? under.className : null, layer: getComputedStyle(document.querySelector('.tile-layer')).getPropertyValue('-webkit-app-region') }
  })()`)) as { free: number; ctl: number; wrong: unknown[]; column: string; under: string | null; layer: string }
  check('window: the whole empty top bar is the window\'s drag strip', bar.free > 40 && bar.wrong.length === 0, JSON.stringify(bar))
  check('window: the top bar\'s controls still take the click', bar.ctl > 3 && !bar.wrong.some((w) => (w as unknown[])[0] === 'control'), JSON.stringify(bar))
  check('window: the columns are not a drag region', bar.column === 'no-drag', bar.column)
  check('window: the tile layer over the window takes no part in the drag region', bar.layer === 'none', bar.layer)
  check('window: what is under the empty bar is the window itself, not a control', bar.under === 'app' || bar.under === 'app ', String(bar.under))

  // ---- two sessions as tiles, the launcher in the center
  const two = String((await js(`window.core.newSession({ cwd: ${JSON.stringify(cwd)}, name: 'smoke-ui' })`)).id)
  await waitFor(async () => (await screen(two)).includes('FAKECLAUDEREADY'), 10_000)
  await js(`window.core.ptyInput(${JSON.stringify(two)}, 'hello\\r'); true`)
  await waitFor(async () => (await screen(two)).includes('DONEhello'), 5000)
  await js(`document.querySelector('.session-plus').click(); true`)
  await waitFor(async () => (await js(`document.querySelectorAll('.session-tile .chat-text').length`)) >= 2, 5000)

  // ---- a session tile is one row of the tile column, and the two columns line up
  const rows = (await js(`(() => {
    const s = [...document.querySelectorAll('.session-tile')].map((t) => t.getBoundingClientRect())
    const t = [...document.querySelectorAll('.tiles .tile[data-tile]')].filter((t) => getComputedStyle(t).getPropertyValue('--span').trim() === '1').map((t) => t.getBoundingClientRect())
    const top = document.querySelector('.tiles .tile').getBoundingClientRect().top
    return { s: s.map((r) => Math.round(r.height)), t: t.map((r) => Math.round(r.height)), sTop: Math.round(s[0]?.top ?? -1), tTop: Math.round(top) }
  })()`)) as { s: number[]; t: number[]; sTop: number; tTop: number }
  check('session tiles: each is one row of the tile column tall', rows.s.length >= 2 && rows.t.length > 0 && rows.s.every((h) => Math.abs(h - rows.t[0]) <= 1), JSON.stringify(rows))
  check('session tiles: the two columns start level', Math.abs(rows.sTop - rows.tTop) <= 1, JSON.stringify(rows))
  check('session tiles: the conversation scrolls for history, the wheel going on to the column at its ends', (await js(`(() => { const c = getComputedStyle(document.querySelector('.session-tile .chat')); return c.overflowY + ' ' + c.overscrollBehaviorY })()`)) === 'auto auto')
  if (process.env.WORKSHOP_SHOT_COLUMNS) {
    await sleep(800)
    await writeFile(process.env.WORKSHOP_SHOT_COLUMNS, (await win.webContents.capturePage()).toPNG())
  }

  // ---- what can be selected
  const sel = (await js(`(() => {
    const us = (q) => { const e = document.querySelector(q); return e ? getComputedStyle(e).userSelect : 'missing' }
    return {
      body: us('body'), bar: us('.topbar'), sessionHead: us('.session-tile .head'), tileHead: us('.tiles .tile .head'), launcher: us('.launcher'),
      plus: us('.session-plus'), chat: us('.session-tile .chat'), chatText: us('.session-tile .chat-text'), prompt: us('.tile-prompt textarea'), field: us('.launcher textarea')
    }
  })()`)) as Record<string, string>
  check('selection: core\'s chrome is not selectable (the bar, heads, launcher, +)', ['body', 'bar', 'sessionHead', 'tileHead', 'launcher', 'plus'].every((k) => sel[k] === 'none'), JSON.stringify(sel))
  check('selection: a conversation and the fields are', ['chat', 'chatText', 'prompt', 'field'].every((k) => sel[k] === 'text'), JSON.stringify(sel))
  const held = (await js(`(() => {
    const [a, b] = document.querySelectorAll('.session-tile .chat')
    const r = a.getBoundingClientRect()
    a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 20, clientY: r.top + 20 }))
    const during = [getComputedStyle(a).userSelect, getComputedStyle(b).userSelect]
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    return { during, after: getComputedStyle(b).userSelect, root: document.documentElement.className }
  })()`)) as { during: string[]; after: string }
  check('selection: a drag started in one conversation cannot run on into another', held.during[0] === 'text' && held.during[1] === 'none' && held.after === 'text', JSON.stringify(held))

  // ---- drops: the prompt bar keeps a chip; the tile pastes into its session and focuses it
  const tileOf = (id: string): string => `document.querySelector('.session-tile[data-session="${id}"]')`
  const barClaimed = await js(DROP(`${tileOf(first)}.querySelector('.tile-prompt textarea')`, 'drop-bar.png'))
  const chip = await waitFor(async () => String(await js(`${tileOf(first)}?.querySelector('.prompt-chip')?.title ?? ''`)).endsWith('drop-bar.png'), 3000)
  check('drop: a picture dropped on a tile\'s prompt bar waits there as a chip, the launcher still in the center', barClaimed === true && chip && (await js(`!!document.querySelector('.launcher')`)) === true, `${barClaimed} ${chip}`)
  await js(`${tileOf(first)}.querySelector('.tile-prompt-send').click(); true`)
  check('drop: sent, the session gets its path', await waitFor(async () => (await screen(first)).includes('drop-bar.png'), 5000), (await screen(first)).slice(-200))

  const tileClaimed = await js(DROP(`${tileOf(two)}.querySelector('.chat')`, 'drop-tile.png'))
  const pasted = await waitFor(async () => (await screen(two)).includes('drop-tile.png'), 5000)
  check('drop: a picture dropped on a session tile\'s conversation is pasted into that session', tileClaimed === true && pasted, `${tileClaimed} ${(await screen(two)).slice(-200)}`)
  check('drop: and the session comes into focus, its terminal in the center', await waitFor(async () => focus() === two && (await js(`!!document.querySelector('.focus-pane[data-session="${two}"] .term-host .xterm')`)) === true, 3000))
  check('session tiles: the focused session leaves the column; its ⌘ number and park are on the center\'s head', (await js(`!${tileOf(two)} && !!document.querySelector('.focus-pane[data-session="${two}"] > .head .key') && !!document.querySelector('.focus-pane[data-session="${two}"] > .head .park')`)) === true)
  if (process.env.WORKSHOP_SHOT_FOCUS) {
    await sleep(800)
    await writeFile(process.env.WORKSHOP_SHOT_FOCUS, (await win.webContents.capturePage()).toPNG())
  }

  const termClaimed = await js(DROP(`document.querySelector('.focus-pane .term-host')`, 'drop-term.png'))
  check('drop: a picture dropped on the terminal in the center is pasted into it', termClaimed === true && (await waitFor(async () => (await screen(two)).includes('drop-term.png'), 5000)), `${termClaimed} ${(await screen(two)).slice(-200)}`)

  // Nowhere else takes a file, and nowhere navigates to it.
  const stray = await js(`(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'stray.txt', { type: 'text/plain' }))
    const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    document.querySelector('.topbar').dispatchEvent(e)
    return e.defaultPrevented
  })()`)
  check('drop: a file dropped anywhere else is ignored, never opened in the window', stray === true && win.webContents.getURL().startsWith(await js('location.origin')))

  await js(`window.core.kill(${JSON.stringify(two)})`)
  await waitFor(() => !core.sessions.getState().sessions.some((s) => s.id === two), 3000)
  await js(`window.core.focusSession(${JSON.stringify(first)})`)
  await waitFor(async () => (await js(`document.querySelectorAll('.term-host .xterm').length`)) === 1, 3000)
}

/**
 * The wheel over a tile's page: what the page cannot use scrolls the tile column (deck's rule, a
 * tile never eats the wheel), what it can use stays in the page until its edge. Synthetic wheels in
 * the pages: the bridge's listener sees them as it sees real ones; the scrolling itself is core's.
 */
export async function wheelSmoke(check: Check, o: { win: BrowserWindow; liveByTile: Map<string, { wc: WebContents }> }): Promise<void> {
  const js = (code: string): Promise<any> => o.win.webContents.executeJavaScript(code)
  const col = (): Promise<number> => js(`document.querySelector('.tile-scroll').scrollTop`)
  const room = (await js(`(() => { const c = document.querySelector('.tile-scroll'); c.scrollTop = 0; return c.scrollHeight - c.clientHeight })()`)) as number
  // The column must have somewhere to go; a spacer at its foot if its tiles all fit.
  if (room < 60) await js(`(() => { const c = document.querySelector('.tile-scroll'); const pad = document.createElement('div'); pad.id = 'smoke-pad'; pad.style.cssText = 'flex: none; height: 600px'; c.append(pad); return true })()`)
  const wheel = (wc: WebContents, target: string, dy: number, ctrl = false): Promise<unknown> =>
    wc.executeJavaScript(`(() => { const t = ${target}; t.dispatchEvent(new WheelEvent('wheel', { deltaY: ${dy}, ctrlKey: ${ctrl}, bubbles: true, cancelable: true })); return true })()`)
  const reset = (): Promise<unknown> => js(`document.querySelector('.tile-scroll').scrollTop = 0; true`)

  const wiki = o.liveByTile.get('wikipedia')!.wc
  await wheel(wiki, 'document.body', 120)
  await waitFor(async () => (await col()) > 0, 2000)
  check('wheel: over a tile page with nothing to scroll, the wheel scrolls the tile column', (await col()) > 0, String(await col()))
  await reset()
  await wheel(wiki, 'document.body', 120, true)
  await sleep(300)
  check('wheel: a pinch (ctrl) is never passed on', (await col()) === 0, String(await col()))

  const probe = o.liveByTile.get('probe')!.wc
  await probe.executeJavaScript(`(() => { const d = document.createElement('div'); d.id = 'smoke-scroll'; d.style.cssText = 'height: 40px; overflow-y: auto'; d.innerHTML = '<div style="height: 400px">x</div>'; document.body.append(d); return true })()`)
  await wheel(probe, `document.querySelector('#smoke-scroll div')`, 120)
  await sleep(300)
  check('wheel: a tile that can scroll keeps the wheel', (await col()) === 0, String(await col()))
  await probe.executeJavaScript(`(() => { const d = document.getElementById('smoke-scroll'); d.scrollTop = d.scrollHeight; const r = document.scrollingElement; if (r) r.scrollTop = r.scrollHeight; return true })()`)
  await wheel(probe, `document.querySelector('#smoke-scroll div')`, 120)
  await waitFor(async () => (await col()) > 0, 2000)
  check('wheel: at the end of its own scroll, the column takes over', (await col()) > 0, String(await col()))
  await probe.executeJavaScript(`document.getElementById('smoke-scroll').remove(); true`)
  await js(`(() => { document.getElementById('smoke-pad')?.remove(); document.querySelector('.tile-scroll').scrollTop = 0; return true })()`)
}
