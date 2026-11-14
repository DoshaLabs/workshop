// One file's diff, drawn: unified or side by side, coloured by file type, the words that changed
// marked, each hunk with the function it is in and (in a session's lane) Stage and Discard, and the
// review notes under their lines. Used by the review, the whole window, a commit and a worktree's
// diff against main. Every piece of a line is text in a span.

import { S, arm, armedNow, act, render, save } from './app.js'
import { el } from './dom.js'
import { fileSig, hunkHeader, langOf, lines, segments, splitRows } from './diff.js'
import { LETTER, num } from './model.js'

/** A line's text as coloured spans, its changed words marked. */
function code(r, lang) {
  return el(
    'span',
    { class: 's' },
    segments(r.s, lang, r.marks).map((g) => (g.k || g.mark ? el('span', { class: [g.k ? `t-${g.k}` : '', g.mark ? 'wm' : ''].filter(Boolean).join(' ') }, g.s) : g.s))
  )
}

const kindOf = (t) => (t === '+' ? 'a' : t === '-' ? 'd' : t === '\\' ? 'nn' : 'c')
const sideOf = (r) => (r.t === '-' ? 'old' : 'new')
const lineOf = (r) => (r.t === '-' ? r.o : r.n)

/** Notes on one line of one file in a lane. */
const notesAt = (ctx, path, line, side) => (ctx.notes ?? []).filter((n) => n.path === path && n.line === line && n.side === side)

function noteBox(ctx, n) {
  return el(
    'div',
    { class: 'rnote', 'data-note': n.id },
    el('div', { class: 'who' }, el('b', {}, 'You'), el('span', { class: 'muted' }, `on line ${n.line} · not sent yet`), el('span', { class: 'spacer' }), el('button', { class: 'act small', onclick: () => removeNote(ctx.top, n.id) }, 'Delete')),
    el('div', { class: 'text' }, n.text)
  )
}

function editor(ctx) {
  const e = S.editing
  return el(
    'div',
    { class: 'rnote' },
    el('div', { class: 'who' }, el('b', {}, 'Note'), el('span', { class: 'muted' }, `on ${e.path.split('/').pop()}, line ${e.line}`)),
    el('textarea', {
      'data-key': 'note',
      'aria-label': 'Your note',
      placeholder: 'What should change here?',
      value: e.text ?? '',
      oninput: (ev) => {
        e.text = ev.target.value
      },
      onkeydown: (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault()
          saveNote()
        }
        ev.stopPropagation()
      }
    }),
    el('div', { class: 'acts' }, el('button', { class: 'act', onclick: () => ((S.editing = null), render()) }, 'Cancel'), el('button', { class: 'act primary', onclick: saveNote }, 'Add note ⌘↵'))
  )
}

export function saveNote() {
  const e = S.editing
  if (!e) return
  const text = (e.text ?? '').trim()
  if (text) {
    const list = S.notes[e.top] ?? (S.notes[e.top] = [])
    list.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, path: e.path, line: e.line, side: e.side, code: e.code, text })
    save('notes', S.notes)
  }
  S.editing = null
  render()
}
function removeNote(top, id) {
  S.notes[top] = (S.notes[top] ?? []).filter((n) => n.id !== id)
  save('notes', S.notes)
  render()
}
/** Opens a note on one line (a click on its number, or c on the first changed line of a hunk). */
export function startNote(ctx, path, r) {
  if (!ctx.top) return
  S.editing = { top: ctx.top, path, line: lineOf(r), side: sideOf(r), code: r.s, text: '' }
  render()
  requestAnimationFrame(() => document.querySelector('[data-key="note"]')?.focus())
}

/** What follows a row: its notes, and the note being written there. */
function after(ctx, path, r) {
  if (!ctx.top || r.t === '\\') return []
  const line = lineOf(r)
  const side = sideOf(r)
  const out = notesAt(ctx, path, line, side).map((n) => noteBox(ctx, n))
  const e = S.editing
  if (e && e.top === ctx.top && e.path === path && e.line === line && e.side === side) out.push(editor(ctx))
  return out
}

function unifiedRow(ctx, path, r, lang) {
  const k = kindOf(r.t)
  return [
    el(
      'div',
      { class: `l ${k}`, 'data-line': lineOf(r) ?? '', 'data-side': sideOf(r) },
      el('span', { class: 'no', title: ctx.top ? 'Add a note on this line' : undefined, onclick: ctx.top && r.t !== '\\' ? () => startNote(ctx, path, r) : undefined }, r.o ?? ''),
      el('span', { class: 'no', onclick: ctx.top && r.t !== '\\' ? () => startNote(ctx, path, r) : undefined }, r.n ?? ''),
      el('span', { class: 'mk' }, r.t === '\\' || r.t === ' ' ? ' ' : r.t === '-' ? '−' : '+'),
      code(r, lang)
    ),
    after(ctx, path, r)
  ]
}

function half(ctx, path, r, lang) {
  if (!r) return el('div', { class: 'l e' }, el('span', { class: 'no' }), el('span', { class: 'mk' }), el('span', { class: 's' }))
  const k = kindOf(r.t)
  return el(
    'div',
    { class: `l ${k}`, 'data-line': lineOf(r) ?? '', 'data-side': sideOf(r) },
    el('span', { class: 'no', onclick: ctx.top && r.t !== '\\' ? () => startNote(ctx, path, r) : undefined }, (r.t === '-' ? r.o : r.n) ?? r.o ?? ''),
    el('span', { class: 'mk' }, r.t === ' ' || r.t === '\\' ? ' ' : r.t === '-' ? '−' : '+'),
    code(r, lang)
  )
}

function splitBody(ctx, path, rows, lang) {
  const out = []
  for (const { left, right } of splitRows(rows)) {
    out.push(el('div', { class: 'split' }, el('div', { class: 'side code one' }, half(ctx, path, left, lang)), el('div', { class: 'gap' }), el('div', { class: 'side code one' }, half(ctx, path, right, lang))))
    const notes = [...(left && left.t === '-' ? after(ctx, path, left) : []), ...(right ? after(ctx, path, right) : [])]
    out.push(notes)
  }
  return el('div', { class: 'split-wrap' }, out)
}

/** The lane file a diff file is, for its staged state. */
const laneFile = (ctx, path) => ctx.lane?.files?.find((f) => f.path === path) ?? null

function hunkHead(ctx, f, h, i) {
  const lf = laneFile(ctx, f.path)
  const canPart = ctx.top && lf && !lf.staged && (lf.kind === 'modified' || lf.kind === 'typechange') && !f.truncated
  const key = `discard ${ctx.top}\0${f.path}\0${i}`
  return el(
    'div',
    { class: 'hunk', 'data-hunk': i },
    el('span', { class: 'h' }, `@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`),
    el('span', { class: 'section' }, h.section ?? ''),
    canPart
      ? [
          el('button', { class: 'act small', 'data-act': 'stagehunk', disabled: !!S.acting, onclick: () => void act(key, 'stage', { session: ctx.session, path: f.path, hunk: i, header: hunkHeader(h) }, ctx.refresh) }, 'Stage hunk'),
          el(
            'button',
            { class: `act small danger${armedNow(key) ? ' armed' : ''}`, 'data-act': 'discardhunk', disabled: !!S.acting, title: 'Put these lines back as they are in the last commit. Kept for undo.', onclick: () => arm(key, () => act(key, 'discard', { session: ctx.session, path: f.path, hunk: i, header: hunkHeader(h) }, ctx.refresh)) },
            armedNow(key) ? 'Discard? Click again' : 'Discard'
          )
        ]
      : null
  )
}

/** A file's own actions in a lane: stage or unstage it whole, discard it. */
export function fileActs(ctx, path) {
  const lf = laneFile(ctx, path)
  if (!ctx.top || !lf) return null
  const key = `discard ${ctx.top}\0${path}`
  return [
    lf.unstaged
      ? el('button', { class: 'act small', 'data-act': 'stage', disabled: !!S.acting, onclick: () => void act(`stage ${path}`, 'stage', { session: ctx.session, path }, ctx.refresh) }, 'Stage')
      : el('button', { class: 'act small', 'data-act': 'unstage', disabled: !!S.acting, onclick: () => void act(`unstage ${path}`, 'unstage', { session: ctx.session, path }, ctx.refresh) }, 'Unstage'),
    lf.kind === 'conflict' || lf.submodule
      ? null
      : el(
          'button',
          {
            class: `act small danger${armedNow(key) ? ' armed' : ''}`,
            'data-act': 'discard',
            disabled: !!S.acting,
            title: lf.kind === 'untracked' ? 'Delete this new file. Kept for undo.' : 'Put this file back as it is in the last commit. Kept for undo.',
            onclick: () => {
              arm(key, () => act(key, 'discard', { session: ctx.session, path }, ctx.refresh))
            }
          },
          armedNow(key) ? 'Discard? Click again' : 'Discard'
        )
  ]
}

const viewedKey = (top, path) => `${top}\0${path}`
export const isViewed = (top, f) => !!top && S.viewed[viewedKey(top, f.path)] === fileSig(f)
export function setViewed(top, f, on) {
  const k = viewedKey(top, f.path)
  if (on) S.viewed[k] = fileSig(f)
  else delete S.viewed[k]
  // Ticks on files no longer shown are dropped now and then, so the store stays small.
  const keys = Object.keys(S.viewed)
  if (keys.length > 400) for (const old of keys.slice(0, keys.length - 400)) delete S.viewed[old]
  save('viewed', S.viewed)
  const fk = `${top}\0${f.path}`
  if (on) {
    S.folded.add(fk)
    S.opened.delete(fk)
  } else S.folded.delete(fk)
}

/**
 * One file. ctx: { key (fold key prefix), top (a lane's top: notes, viewed, actions) or null,
 * session, lane (its changes entry, for staged state), notes, refresh, layout, review (draws the
 * viewed tick), open (always unfolded) }.
 */
export function drawFile(ctx, f) {
  const fk = `${ctx.key}\0${f.path}`
  const viewed = ctx.review && isViewed(ctx.top, f)
  const folded = !ctx.open && (S.folded.has(fk) || (viewed && !S.opened.has(fk)))
  const lang = langOf(f.path)
  const lf = laneFile(ctx, f.path)
  const toggle = () => {
    if (folded) {
      S.folded.delete(fk)
      S.opened.add(fk)
    } else {
      S.folded.add(fk)
      S.opened.delete(fk)
    }
    render()
  }
  const name = [lf ? el('span', { class: `letter k-${lf.kind}` }, LETTER[lf.kind] ?? 'M') : null, el('span', { class: 'fpath' }, f.from ? `${f.from} → ${f.path}` : f.path)]
  const head = el(
    'div',
    { class: 'dfile-head', 'data-path': f.path },
    ctx.open ? name : el('button', { class: 'fold', onclick: toggle, 'aria-expanded': String(!folded) }, el('span', { class: 'muted' }, folded ? '▸' : '▾'), name),
    lf?.staged ? el('span', { class: 'staged-mark', title: lf.unstaged ? 'Part of it is staged' : 'Staged' }, lf.unstaged ? 'part staged' : 'staged') : null,
    lf && (lf.add != null || lf.del != null) ? el('span', { class: 'counts' }, el('span', { class: 'add' }, num(lf.add) && `+${lf.add}`), ' ', el('span', { class: 'del' }, num(lf.del) && `−${lf.del}`)) : el('span', { class: 'muted' }, f.status),
    ctx.review ? fileActs(ctx, f.path) : null,
    ctx.review
      ? el(
          'label',
          {},
          el('input', {
            type: 'checkbox',
            checked: viewed,
            'data-act': 'viewed',
            onchange: (e) => {
              setViewed(ctx.top, f, e.target.checked)
              render()
            }
          }),
          'Viewed'
        )
      : null
  )
  let body = null
  if (!folded) {
    if (f.binary) body = el('p', { class: 'muted note' }, 'Binary file, not shown.')
    else if (!f.hunks.length) body = el('p', { class: 'muted note' }, f.truncated ? 'Not shown: the diff was long enough already.' : f.status === 'renamed' ? 'Renamed, contents unchanged.' : 'No changes to its lines (its mode, or an empty file).')
    else {
      const layout = ctx.layout ?? S.layout
      body = el(
        'div',
        {},
        f.hunks.map((h, i) => {
          const rows = lines(h)
          return [
            hunkHead(ctx, f, h, i),
            layout === 'split' ? splitBody(ctx, f.path, rows, lang) : el('div', { class: 'code' }, el('div', { class: 'code-in' }, rows.map((r) => unifiedRow(ctx, f.path, r, lang))))
          ]
        }),
        f.truncated ? el('div', { class: 'more-lines' }, f.cutLines ? `${f.cutLines} more lines not shown.` : 'The rest is not shown.') : null
      )
    }
  }
  return el('div', { class: `dfile${viewed ? ' seen' : ''}`, 'data-file': f.path }, head, body)
}

/** A list of files' diffs, with the notes on what was cut or not read. */
export function drawFiles(ctx, d) {
  if (!d || d.loading) return el('p', { class: 'muted note' }, 'Reading the diff…')
  if (d.error) return el('p', { class: 'err note' }, d.error)
  if (!d.files.length) return el('p', { class: 'muted note' }, ctx.empty ?? 'No changes to files.')
  return el(
    'div',
    { class: 'diffs' },
    d.files.map((f) => drawFile(ctx, f)),
    d.cut ? el('p', { class: 'muted note' }, 'The diff was too long to read whole; the rest is not shown.') : null,
    d.unread ? el('p', { class: 'muted note' }, `${d.unread} more untracked files not shown.`) : null
  )
}
