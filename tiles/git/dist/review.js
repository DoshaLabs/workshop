// A lane's review, in the pane and the whole window: what a session changed, read like a pull
// request (GitHub's viewed ticks, delta's diffs), with notes on lines sent back to the session as
// one message, and staging, committing, pushing and pulling for when you take it from there.

import { S, act, currentLane, laneSession, render, save, say, session, ws } from './app.js'
import { el } from './dom.js'
import { drawFiles, isViewed } from './diffview.js'
import { LETTER, byFolder, filesLabel, laneOverlaps, notesMessage, num, splitPath } from './model.js'
import { afterWrite } from './data.js'
import { branchName, switcher } from './lanes.js'

/** What the review's pieces share about the lane shown. */
export function laneCtx(cur, extra = {}) {
  const w = cur.w
  return { key: `lane ${w.top}`, top: w.top, session: laneSession(w), lane: w, notes: S.notes[w.top] ?? [], refresh: afterWrite, review: true, ...extra }
}

/** The files a lane's diff has, in order: for the viewed count and the tree. */
const diffFiles = (top) => S.diffs.get(top)?.files ?? []

export function viewedCount(top) {
  const files = diffFiles(top)
  return { seen: files.filter((f) => isViewed(top, f)).length, of: files.length }
}

export function layoutSwitch() {
  return el(
    'span',
    { class: 'seg', role: 'group', 'aria-label': 'Diff layout' },
    [
      ['unified', 'Unified'],
      ['split', 'Split']
    ].map(([id, label]) =>
      el(
        'button',
        {
          class: S.layout === id ? 'on' : undefined,
          'data-layout': id,
          onclick: () => {
            S.layout = id
            save('layout', id)
            render()
          }
        },
        label
      )
    )
  )
}

/** Scrolls the review to a file's diff. */
export function goToFile(path) {
  S.file = path
  render()
  requestAnimationFrame(() => document.querySelector(`.dfile[data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start' }))
}

function tree(cur) {
  const w = cur.w
  const over = new Set(laneOverlaps(cur.p).flatMap((o) => o.files))
  const diff = new Map(diffFiles(w.top).map((f) => [f.path, f]))
  return el(
    'div',
    { class: 'tree' },
    byFolder(w.files).map(({ dir, files }) => [
      dir ? el('div', { class: 'frow dir' }, `▾ ${dir}`) : null,
      files.map((f) => {
        const df = diff.get(f.path)
        const seen = df ? isViewed(w.top, df) : false
        return el(
          'div',
          { class: `frow file${seen ? ' seen' : ''}${S.file === f.path ? ' sel' : ''}`, 'data-path': f.path, onclick: () => goToFile(f.path), title: f.from ? `${f.from} → ${f.path}` : f.path },
          el('span', { class: `letter k-${f.kind}` }, LETTER[f.kind] ?? 'M'),
          el('span', { class: 'p' }, splitPath(f.path).name),
          f.staged ? el('span', { class: 'staged-mark' }, f.unstaged ? 'part' : 'staged') : null,
          over.has(f.path) ? el('span', { class: 'warn', title: 'Another lane changes this file too' }, '⚠') : null,
          f.binary ? el('span', { class: 'muted' }, 'binary') : el('span', { class: 'counts' }, el('span', { class: 'add' }, num(f.add) && `+${f.add}`), ' ', el('span', { class: 'del' }, num(f.del) && `−${f.del}`)),
          seen ? el('span', { class: 'muted', title: 'Viewed' }, '✓') : null
        )
      })
    ]),
    w.hidden ? el('div', { class: 'frow muted' }, `and ${w.hidden} more not listed`) : null
  )
}

/** Sends a lane's notes to a session in it as one message, typed into its terminal. */
export async function sendNotes(cur) {
  const w = cur.w
  const notes = S.notes[w.top] ?? []
  if (!notes.length) return
  const to = S.sendTo[w.top] ?? laneSession(w)
  const s = session(to)
  if (!ws.sessions.paste) return say('this tile cannot type into sessions', false)
  try {
    await ws.sessions.paste(to, notesMessage(notes))
    S.notes[w.top] = []
    save('notes', S.notes)
    say(`sent ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} to ${s?.name ?? 'the session'}`)
  } catch (e) {
    say(e.message, false)
  }
  render()
}

export async function commitLane(cur) {
  const w = cur.w
  const message = (S.commitMsg[w.top] ?? '').trim()
  if (!message) {
    say('write a commit message first', false)
    document.querySelector('[data-key="commitmsg"]')?.focus()
    return
  }
  const r = await act(`commit ${w.top}`, 'commitstaged', { session: laneSession(w), message }, afterWrite)
  if (r) S.commitMsg[w.top] = ''
  render()
}

/** The foot of a review: notes to send, a commit of what is staged, push and pull. */
export function dock(cur, { commit = true } = {}) {
  const w = cur.w
  const notes = S.notes[w.top] ?? []
  const staged = (w.files ?? []).filter((f) => f.staged).length
  const up = w.branch?.ahead ?? 0
  const down = w.branch?.behind ?? 0
  const s = laneSession(w)
  const noUpstream = w.branch?.head && w.branch?.oid && !w.branch?.upstream
  return el(
    'div',
    { class: 'dock' },
    notes.length
      ? el(
          'div',
          { class: 'row' },
          el('span', { class: 'pill accent tint' }, `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`),
          w.sessions.length > 1
            ? el(
                'select',
                { class: 'sel-box', 'aria-label': 'Send to', onchange: (e) => (S.sendTo[w.top] = e.target.value) },
                w.sessions.map((x) => el('option', { value: x.id, selected: (S.sendTo[w.top] ?? s) === x.id ? true : undefined }, x.name))
              )
            : el('span', { class: 'muted' }, `go to ${w.sessions[0]?.name ?? 'the session'} as one message`),
          el('span', { class: 'spacer' }),
          el('button', { class: 'act primary', 'data-act': 'send', onclick: () => void sendNotes(cur) }, 'Send notes')
        )
      : el('div', { class: 'row muted' }, 'Click a line number to leave the session a note.'),
    !commit
      ? null
      : el(
      'div',
      { class: 'row' },
      el('input', {
        type: 'text',
        'data-key': 'commitmsg',
        'aria-label': 'Commit message',
        placeholder: staged ? 'Commit message' : 'Stage files to commit them (sessions usually commit)',
        value: S.commitMsg[w.top] ?? '',
        oninput: (e) => (S.commitMsg[w.top] = e.target.value),
        onkeydown: (e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault()
            void commitLane(cur)
          }
        }
      }),
      el('button', { class: `act${staged ? ' go' : ''}`, 'data-act': 'commit', disabled: !staged || !!S.acting, onclick: () => void commitLane(cur) }, S.acting === `commit ${w.top}` ? 'Committing…' : `Commit ${staged} staged`),
      up || noUpstream ? el('button', { class: 'act', 'data-act': 'push', disabled: !!S.acting, onclick: () => void act('push', 'push', { session: s }, afterWrite) }, S.acting === 'push' ? 'Pushing…' : noUpstream ? 'Publish' : `Push ↑${up}`) : null,
      down ? el('button', { class: 'act', 'data-act': 'pull', disabled: !!S.acting, onclick: () => void act('pull', 'pull', { session: s }, afterWrite) }, S.acting === 'pull' ? 'Pulling…' : `Pull ↓${down}`) : null
    )
  )
}

/** The pane: the lane strip, the lane's summary and files, its diffs, and the dock. */
export function drawReview() {
  if (!S.projects) return [el('p', { class: 'muted empty' }, 'Reading…')]
  if (!S.projects.length) return [el('p', { class: 'muted empty' }, 'No sessions open. Each session’s changes show here as a lane, by project.')]
  const cur = currentLane()
  if (!cur) return [switcher()]
  const w = cur.w
  if (S.lane !== w.top) S.lane = w.top
  const ctx = laneCtx(cur)
  const v = viewedCount(w.top)
  const head = el(
    'div',
    { class: 'summary' },
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'mono' }, branchName(w)),
      el('span', { class: 'muted' }, w.error ? '' : w.count ? `· ${filesLabel(w)} against HEAD` : '· nothing changed'),
      w.count ? el('span', { class: 'counts' }, el('span', { class: 'add' }, `+${w.add}`), ' ', el('span', { class: 'del' }, `−${w.del}`)) : null,
      el('span', { class: 'spacer' }),
      layoutSwitch(),
      ws.openOverlay ? el('button', { class: 'barbtn', 'data-act': 'whole', title: 'The review studio, over the whole window (f)', onclick: () => void ws.openOverlay().catch((e) => say(e.message, false)) }, '⤢ Whole window') : null
    ),
    v.of ? el('div', { class: 'row' }, el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(v.of), 'aria-valuenow': String(v.seen) }, el('div', { style: { width: `${(v.seen / v.of) * 100}%` } })), el('span', { class: 'muted' }, `${v.seen} of ${v.of} viewed`)) : null
  )
  if (w.error) return [switcher(), head, el('p', { class: 'err note' }, w.error)]
  if (!w.count) return [switcher(), head, el('p', { class: 'muted empty' }, `${w.sessions.map((x) => x.name).join(' and ')} ${w.sessions.length > 1 ? 'have' : 'has'} nothing uncommitted.`), dock(cur)]
  return [switcher(), head, tree(cur), drawFiles(ctx, S.diffs.get(w.top)), dock(cur)]
}
