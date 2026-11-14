// The Git tile's page state, shared by its views, and the few things every view does: ask the
// backend, arm a destructive button (two clicks, CLAUDE.md §4), say what happened, remember a
// choice across reloads. tile.js boots it and draws; the views (lanes.js, review.js, history.js,
// worktrees.js, prs.js, studio.js) read S and call these.

import { ARM_MS, isArmed, press } from './model.js'

export const ws = window.workshop

export function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null')
    return v ?? fallback
  } catch {
    return fallback
  }
}
export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // it still works; it just forgets
  }
}

export const S = {
  tab: load('tab', 'changes'),
  sessions: [],
  backendState: 'starting',
  /** The Lanes tab: the last changes answer, and diffs by working tree top. */
  projects: null,
  at: 0,
  error: '',
  diffs: new Map(),
  /** The lane shown in the pane and the whole window (its top folder). */
  lane: load('lane', null),
  /** The file chosen in the whole window. */
  file: null,
  layout: load('layout', 'unified'),
  /** Files ticked as viewed: `<top>\0<path>` → the file's diff signature when it was ticked. */
  viewed: load('viewed', {}),
  /** Files folded away in the review, by `<top>\0<path>` (a viewed file starts folded). */
  folded: new Set(),
  opened: new Set(),
  /** Review notes, by lane top: [{ id, path, line, side, code, text }]. */
  notes: load('notes', {}),
  /** The note being written: { top, path, line, side, code, text } or null. */
  editing: null,
  /** Who notes go to, by lane top (a session id). */
  sendTo: {},
  commitMsg: {},
  /** The Worktrees tab. */
  wt: null,
  wtError: '',
  wtFilter: load('wtFilter', 'all'),
  mainDiffs: new Map(),
  /** The History tab. */
  hist: null,
  histError: '',
  histFilter: load('histFilter', 'all'),
  histLimit: 300,
  query: '',
  openCommits: new Set(),
  commitDiffs: new Map(),
  /** The PRs tab, by project root: { which, prs, base, error, at }. */
  prs: new Map(),
  prWhich: load('prWhich', 'open'),
  openPrs: new Set(),
  checkLogs: new Map(),
  /** Operation logs and refs, by project root; the commands the backend ran. */
  oplog: new Map(),
  refs: new Map(),
  cmdlog: [],
  /** Two-click buttons, results by key, and the write running now. */
  armed: null,
  results: new Map(),
  acting: '',
  palette: null,
  keysHelp: false,
  toast: null
}

let draw = () => {}
/** tile.js gives the function that draws the page. */
export const onDraw = (fn) => {
  draw = fn
}
export const render = () => draw()

// ---- asking the backend

export const call = (op, body) => ws.backend.call(op, body)

let toastTimer = null
/** A line at the foot of the page for four seconds: what an action did, or why it could not. */
export function say(text, ok = true) {
  S.toast = { text, ok }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    S.toast = null
    showToast()
  }, 4000)
  showToast()
}
export function showToast() {
  const t = document.getElementById('toast')
  if (!t) return
  t.hidden = !S.toast
  t.textContent = S.toast?.text ?? ''
  t.className = S.toast && !S.toast.ok ? 'bad' : ''
}

/**
 * Runs a write: one at a time (the backend refuses a second anyway), the button saying so while it
 * runs, then `after` (a refresh). Returns the answer, or null when it was refused (and says why).
 */
export async function act(key, op, body, after) {
  if (S.acting) return null
  S.acting = key
  render()
  try {
    const r = await call(op, body)
    if (r?.said) say(r.said)
    return r
  } catch (e) {
    say(e.message, false)
    return null
  } finally {
    S.acting = ''
    if (after) await after()
    render()
  }
}

let armTimer = null
/** The first click on a destructive button arms it for ARM_MS; a second within that time runs `go`. */
export function arm(key, go) {
  const r = press(S.armed, key)
  S.armed = r.armed
  clearTimeout(armTimer)
  if (!r.act) {
    armTimer = setTimeout(() => {
      S.armed = null
      render()
    }, ARM_MS + 50)
    render()
    return
  }
  render()
  void go()
}
export const armedNow = (key) => isArmed(S.armed, key)

// ---- what the views share about sessions and lanes

/** Every lane (working tree) in the last changes answer, with its project. */
export function allLanes() {
  const out = []
  for (const p of S.projects ?? []) for (const w of p.worktrees) out.push({ p, w })
  return out
}
/** The lane the pane shows: the chosen one if it is still there, else the first with changes, else the first. */
export function currentLane() {
  const all = allLanes()
  return all.find((x) => x.w.top === S.lane) ?? all.find((x) => !x.w.error && x.w.count) ?? all[0] ?? null
}
export function pickLane(top) {
  S.lane = top
  S.file = null
  save('lane', top)
}
/** The session a lane's writes go through: the backend finds the working tree from it. */
export const laneSession = (w) => w?.sessions?.[0]?.id ?? null

export const session = (id) => S.sessions.find((s) => s.id === id)

/** Copies text, where the page may (a click in it); says so either way. */
export async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text)
    say(`copied ${what}`)
  } catch {
    say(`could not copy: ${text}`, false)
  }
}
