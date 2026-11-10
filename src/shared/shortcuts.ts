// Core's keyboard shortcuts, as deck has them: ⌘1–9 focus a session, ⌘[ and ⌘] step through them,
// ⌘N opens the launcher. Main catches them in `before-input-event` on core's window AND on every
// tile's page (a key pressed in a webview never reaches core's window), so they work wherever the
// focus is, in a terminal or a tile; the page never sees them. The window then acts on them.

export type Shortcut = { kind: 'focus'; n: number } | { kind: 'step'; dir: 1 | -1 } | { kind: 'new' }

export interface KeyInput {
  type: string
  key: string
  code?: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

/** The shortcut a key press is, or null. ⌘ alone: with ⌃, ⌥ or ⇧ it is someone else's key. */
export function shortcutOf(i: KeyInput): Shortcut | null {
  if (i.type !== 'keyDown' || !i.meta || i.control || i.alt || i.shift) return null
  const key = (i.key || '').toLowerCase()
  const code = i.code || ''
  const digit = /^[1-9]$/.test(key) ? Number(key) : /^Digit[1-9]$/.test(code) ? Number(code.slice(5)) : 0
  if (digit) return { kind: 'focus', n: digit }
  if (key === '[' || code === 'BracketLeft') return { kind: 'step', dir: -1 }
  if (key === ']' || code === 'BracketRight') return { kind: 'step', dir: 1 }
  if (key === 'n' || code === 'KeyN') return { kind: 'new' }
  return null
}

/**
 * The session a step lands on: the next or previous in `order` (⌘1–9's order) after `current`,
 * wrapping. From nothing, ⌘] takes the first and ⌘[ the last.
 */
export function stepFrom(order: string[], current: string | null, dir: 1 | -1): string | null {
  if (order.length === 0) return null
  const at = current ? order.indexOf(current) : -1
  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1]
  return order[(at + dir + order.length) % order.length]
}
