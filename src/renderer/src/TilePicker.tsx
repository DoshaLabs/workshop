// The menu behind the + at the foot of the tile column, in three tabs: Built in (the tiles that ship
// with workshop), Yours (folders you are building or loaded, "make one with Claude", "load a
// folder"), Marketplace (tiles installed from a git repo, and the index's). Every row shows the same
// things on every tab: icon, name, hint, its permissions in plain words, and whether it is on.
//
// It is a card IN the column, in the +'s place, not a popover: every tile's page is a webview laid
// over the window, and nothing core draws can sit on top of one. That is also why the install
// prompt is drawn inside this card rather than as a dialog.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TileInfo } from '@shared/ipc'
import type { Permissions } from '@shared/manifest'
import type { IndexEntry } from '@shared/tile-index'
import type { IndexState, InstallRecord, PendingInstall } from '@shared/tile-menu'
import { permissionWords } from '@shared/permissions'

type Tab = 'builtin' | 'yours' | 'market'
const TABS: [Tab, string][] = [
  ['builtin', 'Built in'],
  ['yours', 'Yours'],
  ['market', 'Marketplace']
]

/** An IPC error as the sentence main threw, without Electron's wrapping. */
const said = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(err))
const short = (commit: string): string => commit.slice(0, 7)

export function TilePicker({
  tiles,
  countOf,
  max,
  onAdd,
  onOff,
  onOn,
  onClose
}: {
  tiles: TileInfo[]
  countOf: (id: string) => number
  max: number
  /** Turns a tile on, or opens another instance of one that is on. */
  onAdd: (t: TileInfo) => void
  /** Turns a tile's first instance off. */
  onOff: (id: string) => void
  /** Turns a tile on by id (one just installed, which the window may not have listed yet). */
  onOn: (id: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const t = localStorage.getItem('workshop.pickerTab')
      return t === 'yours' || t === 'market' ? t : 'builtin'
    } catch {
      return 'builtin'
    }
  })
  const card = useRef<HTMLElement>(null)
  // In braces on purpose: this Chromium's scrollIntoView returns a promise, and an effect that
  // returns anything but a function takes the whole window down when the menu closes.
  useEffect(() => {
    void card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])
  const pick = (t: Tab): void => {
    setTab(t)
    try {
      localStorage.setItem('workshop.pickerTab', t)
    } catch {
      // remembered for the session only
    }
  }

  const row = (t: TileInfo, extra?: ReactNode): ReactNode => {
    const id = t.manifest.id
    const n = countOf(id)
    return (
      <TileRow key={id} icon={t.icon} name={t.manifest.name} hint={t.manifest.hint} permissions={t.manifest.permissions} badge={t.source === 'dev' ? 'dev' : undefined} on={n > 0}>
        {n === 0 ? (
          <button className="pick-act" onClick={() => onAdd(t)}>
            Turn on
          </button>
        ) : (
          <>
            {t.manifest.multiple && n < max && (
              <button className="pick-act" title={`Another ${t.manifest.name}`} onClick={() => onAdd(t)}>
                Another
              </button>
            )}
            <button className="pick-act quiet" onClick={() => onOff(id)}>
              Turn off
            </button>
          </>
        )}
        {extra}
      </TileRow>
    )
  }

  return (
    <section className="picker" ref={card}>
      <header className="head">
        <span className="name">Tiles</span>
        <button className="ghost" title="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <nav className="pick-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} data-tab={k} onClick={() => pick(k)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="picker-body">
        {tab === 'builtin' && <BuiltIn tiles={tiles} row={row} />}
        {tab === 'yours' && <Yours tiles={tiles} row={row} onClose={onClose} />}
        {tab === 'market' && <Market tiles={tiles} row={row} onOn={onOn} />}
      </div>
    </section>
  )
}

/** One tile, the same on every tab. `children` are its buttons. */
function TileRow({ icon, name, hint, permissions, badge, on, children }: { icon?: string; name: string; hint?: string; permissions: Permissions; badge?: string; on?: boolean; children?: ReactNode }) {
  const words = permissionWords(permissions)
  return (
    <div className="pick-row" data-on={on ? 'true' : 'false'}>
      {icon ? <img className="icon" src={icon} alt="" /> : <span className="icon letter">{name[0]}</span>}
      <div className="pick-text">
        <div className="pick-name">
          <b>{name}</b>
          {badge && <span className="dev">{badge}</span>}
          {on !== undefined && <span className={`pick-state ${on ? 'is-on' : ''}`}>{on ? 'on' : 'off'}</span>}
        </div>
        {hint && <span className="pick-hint">{hint}</span>}
        <span className="pick-perms">{words.length ? `Can ${words.join(' · ')}` : 'Asks for nothing beyond its own page'}</span>
      </div>
      <div className="pick-acts">{children}</div>
    </div>
  )
}

type RowFn = (t: TileInfo, extra?: ReactNode) => ReactNode

function BuiltIn({ tiles, row }: { tiles: TileInfo[]; row: RowFn }) {
  const core = tiles.filter((t) => t.source === 'core')
  return (
    <>
      <p className="picker-note">Tiles that ship with workshop.</p>
      {core.length === 0 && <p className="picker-note">None loaded.</p>}
      {core.map((t) => row(t))}
    </>
  )
}

function Yours({ tiles, row, onClose }: { tiles: TileInfo[]; row: RowFn; onClose: () => void }) {
  const dev = tiles.filter((t) => t.source === 'dev')
  const [name, setName] = useState('')
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [loaded, setLoaded] = useState('')

  const create = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    setProblem('')
    try {
      await window.core.createTile(name, idea)
      onClose()
    } catch (err) {
      setProblem(said(err))
    } finally {
      setBusy(false)
    }
  }
  const load = async (): Promise<void> => {
    setProblem('')
    setLoaded('')
    try {
      const r = await window.core.menu.loadFolder()
      if (r) setLoaded(r.message)
    } catch (err) {
      setProblem(said(err))
    }
  }

  return (
    <>
      <p className="picker-note">Folders you are building, or loaded to try. They reload as their files change.</p>
      {dev.map((t) =>
        row(
          t,
          <button className="pick-act quiet" title="Stop loading it. The folder and its data are left alone." onClick={() => void window.core.forgetTile(t.manifest.id)}>
            Stop loading
          </button>
        )
      )}
      <button className="pick-wide" onClick={() => void load()}>
        Load a folder…
      </button>
      {loaded && <p className="picker-note">{loaded}</p>}

      <h3>Make one with Claude</h3>
      <p className="picker-note">Starts a session in a new folder under ~/workshop-tiles with a working starter tile. It shows up here at once and reloads as Claude writes it.</p>
      <input value={name} maxLength={40} placeholder="Name, like “Focus timer”" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
      <textarea value={idea} rows={3} maxLength={4000} placeholder="What should it do?" onChange={(e) => setIdea(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.metaKey && void create()} />
      {problem && <p className="picker-problem">{problem}</p>}
      <button className="primary" disabled={!name.trim() || busy} onClick={() => void create()}>
        {busy ? 'Starting…' : 'Start building'}
      </button>
    </>
  )
}

function Market({ tiles, row, onOn }: { tiles: TileInfo[]; row: RowFn; onOn: (id: string) => void }) {
  const [installed, setInstalled] = useState<InstallRecord[]>([])
  const [index, setIndex] = useState<IndexState | null>(null)
  const [pending, setPending] = useState<PendingInstall | null>(null)
  /** Which row is busy (fetching, removing), by tile id or 'repo' for the form. */
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState('')
  const [note, setNote] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [dropData, setDropData] = useState(false)
  const [source, setSource] = useState('')
  const [repo, setRepo] = useState('')
  const [commit, setCommit] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const s = await window.core.menu.state()
    setInstalled(s.installed)
    setIndex(s.index)
    setSource((x) => x || s.index.source || '')
  }, [])
  useEffect(() => {
    void refresh().catch((err) => setProblem(said(err)))
    // A tile turned on, off or loaded elsewhere: the installed list follows.
    return window.core.onTilesChanged(() => void refresh().catch(() => undefined))
  }, [refresh])

  const fetchTile = async (key: string, req: Parameters<typeof window.core.menu.prepare>[0]): Promise<void> => {
    setBusy(key)
    setProblem('')
    setNote('')
    try {
      const p = await window.core.menu.prepare(req)
      // An update that asks for nothing new goes straight in; anything else is asked first.
      if (p.ask) setPending(p)
      else await finish(p)
    } catch (err) {
      setProblem(said(err))
    } finally {
      setBusy(null)
    }
  }
  const finish = async (p: PendingInstall): Promise<void> => {
    setBusy(p.id)
    setProblem('')
    try {
      await window.core.menu.confirm(p.token)
      if (!p.update) onOn(p.id)
      setNote(p.update ? `${p.name} updated to ${p.version}.` : `${p.name} is installed and on.`)
      setPending(null)
      await refresh()
    } catch (err) {
      setProblem(said(err))
      setPending(null)
    } finally {
      setBusy(null)
    }
  }
  const cancel = (): void => {
    if (pending) void window.core.menu.cancel(pending.token)
    setPending(null)
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(id)
    setProblem('')
    try {
      await window.core.menu.remove(id, { storage: dropData })
      setNote(dropData ? 'Removed, with its data.' : 'Removed. Its data is kept, should you install it again.')
      setRemoving(null)
      setDropData(false)
      await refresh()
    } catch (err) {
      setProblem(said(err))
    } finally {
      setBusy(null)
    }
  }
  const useIndex = async (): Promise<void> => {
    setProblem('')
    try {
      setIndex(await window.core.menu.setIndex(source))
    } catch (err) {
      setProblem(said(err))
    }
  }

  if (pending) return <Prompt p={pending} busy={busy === pending.id} onYes={() => void finish(pending)} onNo={cancel} problem={problem} />

  const byId = new Map(tiles.map((t) => [t.manifest.id, t]))
  const entryOf = new Map((index?.entries ?? []).map((e) => [e.id, e]))
  const mine = installed
  const listed = (index?.entries ?? []).filter((e) => !installed.some((r) => r.id === e.id))

  return (
    <>
      {note && <p className="picker-note pick-done">{note}</p>}
      {problem && <p className="picker-problem">{problem}</p>}

      {mine.length > 0 && <h3>Installed</h3>}
      {mine.map((r) => {
        // A folder under development with the same id stands in front of it: the record's row then.
        const t = byId.get(r.id)?.source === 'installed' ? byId.get(r.id) : undefined
        const e = entryOf.get(r.id)
        const newer = e && e.commit !== r.commit
        const acts = (
          <>
            {newer && (
              <button className="pick-act" data-update={r.id} disabled={!!busy} title={`${r.version} → ${e.version} (${short(e.commit)})`} onClick={() => void fetchTile(r.id, { repo: e.repo, commit: e.commit, expect: { id: e.id, permissions: e.permissions } })}>
                {busy === r.id ? 'Fetching…' : `Update to ${e.version}`}
              </button>
            )}
            <button className="pick-act quiet" data-remove={r.id} disabled={!!busy} onClick={() => (setRemoving(removing === r.id ? null : r.id), setDropData(false))}>
              Remove
            </button>
          </>
        )
        return (
          <div key={r.id} className="pick-group">
            {t ? row(t, acts) : <TileRow name={r.id} hint={byId.has(r.id) ? `installed from ${r.repo}; a folder you are developing is loaded in its place` : `installed from ${r.repo}, but it did not load (see the center pane)`} permissions={r.permissions}>{acts}</TileRow>}
            {removing === r.id && (
              <div className="pick-confirm">
                <label>
                  <input type="checkbox" checked={dropData} onChange={(ev) => setDropData(ev.target.checked)} /> Also delete what it stored
                </label>
                <button className="pick-act danger" data-remove-confirm disabled={!!busy} onClick={() => void remove(r.id)}>
                  {busy === r.id ? 'Removing…' : 'Remove it'}
                </button>
                <button className="pick-act quiet" onClick={() => setRemoving(null)}>
                  Keep
                </button>
              </div>
            )}
          </div>
        )
      })}

      <h3>From the index</h3>
      {!index?.source ? (
        <p className="picker-note">
          The marketplace will list tiles anyone can write and submit: each one pinned to a commit of its own git repo, with the permissions it asks for shown here before anything is downloaded. Install, update and remove from this tab. The index does not exist yet; if you have one, give its address below.
        </p>
      ) : index.problem ? (
        <p className="picker-problem">{index.problem}</p>
      ) : listed.length === 0 ? (
        <p className="picker-note">{index.entries.length ? 'Everything the index lists is installed.' : 'The index lists no tiles yet.'}</p>
      ) : null}
      {listed.map((e) => (
        <IndexRow key={e.id} e={e} builtIn={byId.get(e.id)?.source === 'core'} busy={busy} onInstall={() => void fetchTile(e.id, { repo: e.repo, commit: e.commit, expect: { id: e.id, permissions: e.permissions } })} />
      ))}
      {index && index.errors.length > 0 && (
        <details className="pick-more">
          <summary>{index.errors.length === 1 ? '1 entry was skipped' : `${index.errors.length} entries were skipped`}</summary>
          <ul>
            {index.errors.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
      )}
      {!index?.fromEnv && (
        <div className="pick-line">
          <input value={source} placeholder="https://…/tiles.json, or a file" onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void useIndex()} />
          <button className="pick-act" onClick={() => void useIndex()}>
            {source.trim() ? 'Read' : 'Clear'}
          </button>
        </div>
      )}

      <details className="pick-more">
        <summary>Install from a git repo</summary>
        <p className="picker-note">Any tile's repo, at one commit. Nothing in it is built or run; you see what it asks for before it is turned on.</p>
        <input value={repo} placeholder="https://github.com/someone/my-tile" onChange={(e) => setRepo(e.target.value)} />
        <input value={commit} placeholder="Commit (all 40 characters)" onChange={(e) => setCommit(e.target.value)} />
        <button className="pick-act" disabled={!repo.trim() || !commit.trim() || !!busy} onClick={() => void fetchTile('repo', { repo: repo.trim(), commit: commit.trim() })}>
          {busy === 'repo' ? 'Fetching…' : 'Fetch'}
        </button>
      </details>
    </>
  )
}

function IndexRow({ e, builtIn, busy, onInstall }: { e: IndexEntry; builtIn: boolean; busy: string | null; onInstall: () => void }) {
  return (
    <TileRow name={e.name} hint={`${e.hint ? `${e.hint} · ` : ''}by ${e.author} · ${e.version}`} permissions={e.permissions}>
      {builtIn ? (
        <span className="picker-note" title="An installed tile can never take the id of one that ships with workshop">built in</span>
      ) : (
        <button className="pick-act" data-install={e.id} disabled={!!busy} onClick={onInstall}>
          {busy === e.id ? 'Fetching…' : 'Install'}
        </button>
      )}
    </TileRow>
  )
}

/** The permission prompt, core's own, in the card. A new install lists everything; an update lists what changed. */
function Prompt({ p, busy, onYes, onNo, problem }: { p: PendingInstall; busy: boolean; onYes: () => void; onNo: () => void; problem: string }) {
  const change = p.update?.change
  return (
    <div className="pick-prompt" role="dialog" aria-label={`Install ${p.name}`}>
      <h4>{p.update ? `Update ${p.name}?` : `Install ${p.name}?`}</h4>
      <p className="picker-note">
        {p.update ? `${p.update.version} → ${p.version}` : p.version} · by {p.author}
        <br />
        <code>{p.repo}</code> at <code>{short(p.commit)}</code>
      </p>
      {p.hint && <p className="pick-hint">{p.hint}</p>}
      {change ? (
        <>
          <p>It now also asks to:</p>
          <ul className="pick-asks">
            {change.added.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          {change.removed.length > 0 && <p className="picker-note">No longer: {change.removed.join(' · ')}</p>}
        </>
      ) : (
        <>
          <p>{p.words.length ? 'It will be able to:' : 'It asks for nothing beyond its own page: no network, no data, no sessions.'}</p>
          {p.words.length > 0 && (
            <ul className="pick-asks">
              {p.words.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {p.warnings.length > 0 && (
        <details className="pick-more">
          <summary>{p.warnings.length === 1 ? '1 note from the check' : `${p.warnings.length} notes from the check`}</summary>
          <ul>
            {p.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {problem && <p className="picker-problem">{problem}</p>}
      <div className="pick-line">
        <button className="primary" data-confirm disabled={busy} onClick={onYes}>
          {busy ? 'Installing…' : p.update ? 'Update' : 'Install and turn on'}
        </button>
        <button className="pick-act quiet" disabled={busy} onClick={onNo}>
          Cancel
        </button>
      </div>
    </div>
  )
}
