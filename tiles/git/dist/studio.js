// The whole window (the overlay): Fork's, Tower's and Sublime Merge's layout for a lane's review.
// A sidebar (lanes, branches, worktrees, stashes, tags), the files staged and not, one file's diff
// side by side, and a toolbar for the lane's branch. Its foot shows the git each action ran.

import { S, act, allLanes, arm, armedNow, currentLane, laneSession, pickLane, render } from './app.js'
import { el } from './dom.js'
import { drawFile, fileActs, isViewed, setViewed } from './diffview.js'
import { LETTER, bandOf, filesLabel, laneStatus, names, num, short } from './model.js'
import { afterWrite, refreshDiffs } from './data.js'
import { branchName, statusMark } from './lanes.js'
import { commitLane, dock, laneCtx, layoutSwitch, viewedCount } from './review.js'
import { undoLast } from './worktrees.js'

/** The toolbar's actions on the shown lane's branch, also the palette's. */
export function laneActions(cur) {
  if (!cur) return []
  const w = cur.w
  const s = laneSession(w)
  const up = w.branch?.ahead ?? 0
  const down = w.branch?.behind ?? 0
  const noUpstream = w.branch?.head && w.branch?.oid && !w.branch?.upstream
  return [
    { id: 'fetch', label: '↓ Fetch', hint: 'every remote', run: () => act('fetch', 'fetch', { session: s }, afterWrite) },
    { id: 'pull', label: down ? `⇣ Pull ${down}` : '⇣ Pull', hint: 'fast-forward only', run: () => act('pull', 'pull', { session: s }, afterWrite) },
    { id: 'push', label: noUpstream ? '⇡ Publish' : up ? `⇡ Push ${up}` : '⇡ Push', hint: 'never forced', run: () => act('push', 'push', { session: s }, afterWrite) },
    { id: 'stash', label: 'Stash', hint: 'every change, untracked too', run: () => act('stash', 'stash', { session: s }, afterWrite) },
    { id: 'undo', label: '↶ Undo', hint: '⌘Z, two presses', run: () => undoLast(cur.p.root) },
    { id: 'commit', label: 'Commit staged', hint: '⌘↵', run: () => commitLane(cur) }
  ]
}

function toolbar(cur) {
  return el(
    'div',
    { class: 'toolbar' },
    el('span', { class: 'project-name' }, cur.p.name),
    el('span', { class: 'mono' }, branchName(cur.w)),
    el('span', { class: 'spacer' }),
    laneActions(cur)
      .filter((a) => a.id !== 'commit')
      .map((a) => el('button', { class: 'act', 'data-act': a.id, disabled: !!S.acting, title: a.hint, onclick: () => void a.run() }, S.acting === a.id ? `${a.label}…` : a.label)),
    el('button', { class: 'act', 'data-act': 'palette', onclick: () => openPalette() }, el('span', { class: 'k' }, '⌘K'), 'Actions')
  )
}

let paletteOpener = () => {}
export const onPalette = (fn) => {
  paletteOpener = fn
}
const openPalette = () => paletteOpener()

function sidebar(cur) {
  const refs = S.refs.get(cur.p.root)
  const wts = S.wt?.projects.find((p) => p.root === cur.p.root)?.worktrees ?? []
  return el(
    'section',
    { class: 'side', 'data-scroll': 'side', 'aria-label': 'Lanes and refs' },
    el('div', { class: 'sh' }, 'Lanes'),
    allLanes().map(({ p, w }) =>
      el(
        'button',
        {
          class: `si${w.top === cur.w.top ? ' on' : ''}`,
          'data-band': bandOf(w, S.sessions) ?? undefined,
          title: `${p.name} · ${w.top}`,
          onclick: () => {
            pickLane(w.top)
            render()
            void refreshDiffs(true).then(render)
          }
        },
        statusMark(laneStatus(w, S.sessions)),
        el('span', { class: 'n' }, names(w.sessions) || w.name),
        w.count ? el('span', { class: 'counts add' }, String(w.count)) : el('span', { class: 'muted' }, 'clean')
      )
    ),
    refs
      ? [
          el('div', { class: 'sh' }, 'Branches'),
          refs.branches.slice(0, 30).map((b) =>
            el(
              'div',
              { class: 'si', title: b.upstream ? `tracks ${b.upstream}` : 'no upstream' },
              el('span', { class: 'n mono' }, b.name),
              b.ahead ? el('span', { class: 'mono add' }, `↑${b.ahead}`) : null,
              b.behind ? el('span', { class: 'mono warn' }, `↓${b.behind}`) : null,
              b.gone ? el('span', { class: 'muted' }, 'gone') : null
            )
          ),
          refs.remotes.length ? el('div', { class: 'si muted' }, `${refs.remotes.length} remote ${refs.remotes.length === 1 ? 'branch' : 'branches'}`) : null
        ]
      : null,
    wts.length
      ? [
          el('div', { class: 'sh' }, 'Worktrees'),
          wts.map((w) => el('div', { class: 'si', title: w.path }, el('span', { class: 'n' }, w.short), w.dirty ? el('span', { class: 'pill yellow' }, String(w.dirty)) : null))
        ]
      : null,
    refs?.stashes.length
      ? [
          el('div', { class: 'sh' }, 'Stashes'),
          refs.stashes.map((st) => {
            const key = `pop ${st.sha}`
            const on = armedNow(key)
            return el(
              'div',
              { class: 'si', title: st.said },
              el('span', { class: 'n' }, st.said.replace(/^On [^:]+: /, '')),
              el('span', { class: 'muted' }, short(st.at)),
              el('button', { class: `act small${on ? ' armed' : ''}`, 'data-act': 'pop', disabled: !!S.acting, onclick: () => arm(key, () => act(key, 'pop', { session: laneSession(cur.w), sha: st.sha }, afterWrite)) }, on ? 'Pop? Again' : 'Pop')
            )
          })
        ]
      : null,
    refs?.tags.length ? [el('div', { class: 'sh' }, 'Tags'), refs.tags.slice(0, 10).map((t) => el('div', { class: 'si muted' }, el('span', { class: 'n mono' }, t.name)))] : null
  )
}

function fileRow(cur, f, ctx) {
  const df = S.diffs.get(cur.w.top)?.files.find((x) => x.path === f.path)
  const seen = df ? isViewed(cur.w.top, df) : false
  return el(
    'div',
    { class: `frow file${S.file === f.path ? ' sel' : ''}${seen ? ' seen' : ''}`, 'data-path': f.path, title: f.path, onclick: () => ((S.file = f.path), render()) },
    df ? el('input', { type: 'checkbox', 'aria-label': `Viewed ${f.path}`, checked: seen, onclick: (e) => e.stopPropagation(), onchange: (e) => (setViewed(cur.w.top, df, e.target.checked), render()) }) : null,
    el('span', { class: `letter k-${f.kind}` }, LETTER[f.kind] ?? 'M'),
    el('span', { class: 'p' }, f.path),
    f.binary ? null : el('span', { class: 'counts' }, el('span', { class: 'add' }, num(f.add) && `+${f.add}`), ' ', el('span', { class: 'del' }, num(f.del) && `−${f.del}`))
  )
}

function fileList(cur, ctx) {
  const w = cur.w
  const v = viewedCount(w.top)
  const unstaged = w.files.filter((f) => f.unstaged)
  const staged = w.files.filter((f) => f.staged)
  return el(
    'section',
    { class: 'files' },
    el('div', { class: 'row1', style: { padding: '9px 12px 6px' } }, el('b', {}, 'Changes'), el('span', { class: 'muted' }, filesLabel(w)), el('span', { class: 'spacer' }), v.of ? el('span', { class: 'muted' }, `${v.seen} / ${v.of} viewed`) : null),
    v.of ? el('div', { class: 'progress', style: { margin: '0 12px 6px', flex: 'none' } }, el('div', { style: { width: `${(v.seen / v.of) * 100}%` } })) : null,
    el(
      'div',
      { class: 'list', 'data-scroll': 'files' },
      unstaged.length ? [el('div', { class: 'sh' }, `Not staged · ${unstaged.length}`), unstaged.map((f) => fileRow(cur, f, ctx))] : null,
      staged.length ? [el('div', { class: 'sh' }, `Staged · ${staged.length}`), staged.map((f) => fileRow(cur, f, ctx))] : null,
      !w.files.length ? el('p', { class: 'muted note' }, 'Nothing changed.') : null
    ),
    el(
      'div',
      { class: 'dock' },
      el('input', {
        type: 'text',
        'data-key': 'commitmsg',
        'aria-label': 'Commit message',
        placeholder: staged.length ? 'Commit message' : 'Stage files to commit them',
        value: S.commitMsg[w.top] ?? '',
        oninput: (e) => (S.commitMsg[w.top] = e.target.value),
        onkeydown: (e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void commitLane(cur)
          }
        }
      }),
      el('button', { class: `act${staged.length ? ' go' : ''}`, 'data-act': 'commit', disabled: !staged.length || !!S.acting, onclick: () => void commitLane(cur) }, `Commit ${staged.length} to ${branchName(w)}`)
    )
  )
}

function diffColumn(cur, ctx) {
  const d = S.diffs.get(cur.w.top)
  const files = d?.files ?? []
  const f = files.find((x) => x.path === S.file) ?? files[0]
  if (f && S.file !== f.path) S.file = f.path
  const viewed = f ? isViewed(cur.w.top, f) : false
  return el(
    'section',
    { class: 'diffcol' },
    el(
      'div',
      { class: 'difftop' },
      el('span', { class: 'mono', style: { fontWeight: '600' } }, f?.path ?? ''),
      el('span', { class: 'spacer' }),
      layoutSwitch(),
      f ? fileActs(ctx, f.path) : null,
      f
        ? el(
            'label',
            { class: 'muted', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
            el('input', { type: 'checkbox', checked: viewed, onchange: (e) => (setViewed(cur.w.top, f, e.target.checked), render()) }),
            'Viewed'
          )
        : null
    ),
    el(
      'div',
      { class: 'diffbody', 'data-scroll': 'diff' },
      !d ? el('p', { class: 'muted note' }, cur.w.count ? 'Reading the diff…' : 'Nothing changed in this lane.') : d.error ? el('p', { class: 'err note' }, d.error) : f ? drawFile({ ...ctx, review: false, open: true }, f) : el('p', { class: 'muted note' }, 'Nothing changed in this lane.')
    ),
    dock(cur, { commit: false })
  )
}

export function drawStudio() {
  const cur = currentLane()
  if (!cur) return [el('p', { class: 'muted empty' }, S.projects ? 'No sessions open.' : 'Reading…')]
  const ctx = laneCtx(cur, { layout: S.layout })
  if (cur.w.error) return [toolbar(cur), el('p', { class: 'err note' }, cur.w.error)]
  return [toolbar(cur), el('div', { class: 'studio' }, sidebar(cur), fileList(cur, ctx), diffColumn(cur, ctx))]
}

/** The selected file, then the next or previous one (j / k). */
export function stepFile(by) {
  const cur = currentLane()
  const files = S.diffs.get(cur?.w.top)?.files ?? []
  if (!files.length) return
  const i = Math.max(0, files.findIndex((f) => f.path === S.file))
  S.file = files[Math.min(files.length - 1, Math.max(0, i + by))].path
  render()
}
