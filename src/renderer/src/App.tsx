// Core's window: sessions on the left (they arrive in roadmap step 3), what you are on now in the
// center, tiles on the right. Core draws every tile's head; the tile's page fills the face.
//
// The column holds tile INSTANCES. A tile's first instance is keyed by its id; a tile with
// `multiple: true` may have more, keyed `<id>.<n>` (n up to 4), each its own page and partition.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { ThemeState, TileHead, TileInfo, TileProblem, TileView } from '@shared/ipc'
import { syncCosmos } from './cosmos'
import { ThemePicker } from './ThemePicker'
import { FocusPane, Launcher, SessionColumn } from './Sessions'
import { setPalette } from './terminals'
import type { SessionsState } from '@shared/sessions'
import type { Usage } from '@shared/usage'
import { UsageMeter } from './UsageMeter'
import { TileLayer, type Instance } from './TileLayer'
import { TilePicker } from './TilePicker'
import { MascotSetup } from './MascotSetup'
import { AppMark } from './Knot'

const OFF_KEY = 'workshop.off'
const EXTRA_KEY = 'workshop.extra'
const MAX_INSTANCES = 4
const SPAN_KEY = 'workshop.span'
/** The tile column is this many rows tall, as deck's is by default: a tile is one row unless it asks for more or ↕ made it taller. */
const ROWS = 4

function readSpans(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(SPAN_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function readList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // the column still works, it just forgets
  }
}

/** Paints the window: the variables, and the attributes the stylesheet keys the wall and dark mode on. */
function applyTheme(t: ThemeState): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v)
  root.dataset.theme = t.theme
  root.dataset.wall = String(t.wall)
  root.dataset.dark = String(t.dark)
  syncCosmos(t.theme)
  setPalette(t.term)
}

const instanceN = (key: string): number => Number(/\.(\d)$/.exec(key)?.[1] ?? 1)
const tileIdOf = (key: string): string => key.replace(/\.\d$/, '')

export function App() {
  const [tiles, setTiles] = useState<TileInfo[]>([])
  const [problems, setProblems] = useState<TileProblem[]>([])
  /** Tiles whose first instance is turned off. */
  const [off, setOff] = useState<string[]>(() => readList(OFF_KEY))
  /** Second and later instances that are on: `<id>.<n>`. */
  const [extra, setExtra] = useState<string[]>(() => readList(EXTRA_KEY))
  const [pane, setPane] = useState<string | null>(null)
  /** The instance whose page is over the whole window (permissions.overlay), if any. */
  const [overlay, setOverlay] = useState<string | null>(null)
  const [heads, setHeads] = useState<Record<string, TileHead>>({})
  const [chips, setChips] = useState<Record<string, string>>({})
  const [theme, setTheme] = useState<ThemeState | null>(null)
  const [sessions, setSessions] = useState<SessionsState | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  /** The launcher asked for (the + in the session column), over the focused session. */
  const [launcher, setLauncher] = useState(false)
  /** The tile column's + menu. */
  const [picker, setPicker] = useState(false)
  /** The mascot's setup screen, in the center (the button beside the theme picker). */
  const [mascotSetup, setMascotSetup] = useState(false)
  /** Heights the user set with ↕, by instance; a tile without one takes its manifest's `span`. */
  const [spans, setSpans] = useState<Record<string, number>>(readSpans)
  useEffect(() => {
    try {
      localStorage.setItem(SPAN_KEY, JSON.stringify(spans))
    } catch {
      // the column still works, it just forgets
    }
  }, [spans])
  const spanOf = (i: Instance): number => {
    const n = spans[i.key] ?? i.tile.manifest.span
    return Number.isInteger(n) && n >= 1 && n <= ROWS ? n : 1
  }

  useEffect(() => {
    const load = () =>
      void window.core.listTiles().then((r) => {
        setTiles(r.tiles)
        setProblems(r.problems)
        applyTheme(r.theme)
        setTheme(r.theme)
      })
    load()
    void window.core.sessions().then(setSessions)
    void window.core.usage().then(setUsage)
    const offs = [
      window.core.onSessions(setSessions),
      window.core.onUsage(setUsage),
      window.core.onTilesChanged(load),
      window.core.onTheme((t) => {
        applyTheme(t)
        setTheme(t)
      }),
      window.core.onTileHead((key, head) => setHeads((h) => ({ ...h, [key]: head }))),
      window.core.onTilePane((key, open) => setPane((p) => (open ? key : p === key ? null : p))),
      window.core.onTileOverlay((key, open) => setOverlay((o) => (open ? key : o === key ? null : o))),
      window.core.onTileNotify((key, text) => {
        setChips((c) => ({ ...c, [key]: text }))
        window.setTimeout(() => setChips((c) => (c[key] === text ? { ...c, [key]: '' } : c)), 8000)
      })
    ]
    return () => offs.forEach((f) => f())
  }, [])

  // A session coming into focus (started, resumed, clicked) takes the center back from a tile.
  const focusId = sessions?.focus ?? null
  useEffect(() => {
    if (focusId) {
      setPane(null)
      setLauncher(false)
    }
  }, [focusId])

  useEffect(() => {
    if (focusId) setMascotSetup(false)
  }, [focusId])

  useEffect(() => writeList(OFF_KEY, off), [off])
  useEffect(() => writeList(EXTRA_KEY, extra), [extra])

  /** Every instance that is on, each tile's together, in the catalog's order. */
  const instances = useMemo<Instance[]>(() => {
    const out: Instance[] = []
    for (const tile of tiles) {
      const id = tile.manifest.id
      if (!off.includes(id)) out.push({ key: id, n: 1, tile })
      if (!tile.manifest.multiple) continue
      for (const key of extra.filter((k) => tileIdOf(k) === id).sort()) out.push({ key, n: instanceN(key), tile })
    }
    return out
  }, [tiles, off, extra])

  const viewOf = useCallback((key: string): TileView => (overlay === key ? 'overlay' : pane === key ? 'pane' : 'tile'), [overlay, pane])
  // An overlay whose instance went away (turned off, its tile unloaded) goes with it.
  useEffect(() => {
    if (overlay && !instances.some((i) => i.key === overlay)) setOverlay(null)
  }, [overlay, instances])
  useEffect(() => {
    for (const i of instances) void window.core.setView(i.key, viewOf(i.key))
  }, [viewOf, instances])

  useEffect(() => {
    if (!pane) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPane(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pane])

  const close = useCallback((key: string) => {
    setPane((p) => (p === key ? null : p))
    setOverlay((o) => (o === key ? null : o))
    if (instanceN(key) === 1) setOff((o) => [...o, key])
    else setExtra((x) => x.filter((k) => k !== key))
  }, [])

  /** Another instance of a `multiple` tile: the first one that is off, else the lowest free slot. */
  const another = (tile: TileInfo): void => {
    const id = tile.manifest.id
    if (off.includes(id)) return setOff((o) => o.filter((x) => x !== id))
    for (let n = 2; n <= MAX_INSTANCES; n++) {
      const key = `${id}.${n}`
      if (!extra.includes(key)) return setExtra((x) => [...x, key])
    }
  }
  const countOf = (id: string): number => instances.filter((i) => i.tile.manifest.id === id).length

  const paneInst = instances.find((i) => i.key === pane)
  const overInst = instances.find((i) => i.key === overlay)
  const focused = sessions?.sessions.find((s) => s.id === sessions.focus && s.open) ?? null
  const label = (i: Instance): string => heads[i.key]?.title || (i.n > 1 ? `${i.tile.manifest.name} ${i.n}` : i.tile.manifest.name)

  return (
    <div className={`app ${overInst ? 'overlaid' : ''}`}>
      <AppMark working={!!sessions?.sessions.some((s) => s.open && s.status === 'busy')} />
      <div className="topbar">
        <UsageMeter usage={usage} />
        <button className="ghost small" title="The mascot: a sprite in every session's head" onClick={() => setMascotSetup((v) => !v)}>
          Mascot
        </button>
        {theme && <ThemePicker theme={theme} />}
      </div>
      <SessionColumn
        state={sessions}
        launcher={launcher || !focused}
        onNew={() => {
          setPane(null)
          setLauncher(true)
        }}
        onPick={() => {
          setPane(null)
          setLauncher(false)
        }}
      />

      <main className="col center">
        {mascotSetup ? (
          <div className="center-scroll">
            <MascotSetup onClose={() => setMascotSetup(false)} />
          </div>
        ) : paneInst ? (
          <section className="pane">
            <header className="head">
              <Icon tile={paneInst.tile} />
              <span className="name">{label(paneInst)}</span>
              <button className="ghost" title="Back (Esc)" onClick={() => setPane(null)}>
                ×
              </button>
            </header>
            <div className="face pane-face" data-pane={paneInst.key}>
              {overlay === paneInst.key && <span className="away">open over the window</span>}
            </div>
          </section>
        ) : focused && !launcher ? (
          <FocusPane session={focused} />
        ) : (
          <div className="center-scroll">
            <Launcher recent={sessions?.recent ?? []} onStarted={() => setLauncher(false)} />
            {problems.length > 0 && (
              <div className="problems">
                <h2>Tiles that were refused</h2>
                {problems.map((p) => (
                  <div key={p.folder} className="problem">
                    <code>{p.folder}</code>
                    <ul>
                      {p.errors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      <aside className="col tiles">
        <div className="tile-scroll">
          {instances.map((i) => {
            const t = i.tile
            const head = heads[i.key]
            return (
              <article key={i.key} className={`tile ${pane === i.key ? 'in-pane' : ''}`} style={{ '--span': spanOf(i) } as CSSProperties}>
                <header className="head">
                  <Icon tile={t} />
                  <span className="name" title={t.manifest.hint}>
                    {label(i)}
                  </span>
                  {head?.badge && <span className="badge">{head.badge}</span>}
                  {chips[i.key] && (
                    <span className="chip" title={chips[i.key]}>
                      {chips[i.key]}
                    </span>
                  )}
                  {t.source === 'dev' && <span className="dev">dev</span>}
                  {t.manifest.multiple && countOf(t.manifest.id) < MAX_INSTANCES && (
                    <button className="ghost" title={`Another ${t.manifest.name}`} onClick={() => another(t)}>
                      +
                    </button>
                  )}
                  <button className="ghost" title={spanOf(i) < ROWS ? `Make it taller: ${spanOf(i) + 1} rows of ${ROWS}` : 'Back to one row'} onClick={() => setSpans((s) => ({ ...s, [i.key]: spanOf(i) < ROWS ? spanOf(i) + 1 : 1 }))}>
                    ↕
                  </button>
                  {t.manifest.pane && (
                    <button className="ghost" title="Open large" onClick={() => setPane(pane === i.key ? null : i.key)}>
                      ⤢
                    </button>
                  )}
                  <button className="ghost" title="Turn off" onClick={() => close(i.key)}>
                    ×
                  </button>
                </header>
                <div className="face" data-face={i.key}>
                  {overlay === i.key ? <span className="away">open over the window</span> : pane === i.key && <span className="away">open in the center</span>}
                </div>
              </article>
            )
          })}
          {/* The + is the column's last cell, as in deck. Its menu opens in its place: every tile's
              page is a webview laid over the window, so nothing core draws can sit on top of one. */}
          {picker ? (
            <TilePicker
              tiles={tiles}
              countOf={countOf}
              max={MAX_INSTANCES}
              onAdd={(t) => {
                another(t)
                setPicker(false)
              }}
              onClose={() => setPicker(false)}
            />
          ) : (
            <button className="tile tile-plus" title="Add a tile, or make one with Claude" onClick={() => setPicker(true)}>
              +
            </button>
          )}
        </div>
      </aside>

      <TileLayer instances={instances} viewOf={viewOf} />

      {/* A tile's page over the whole window, below a strip that is core's alone: the page cannot
          draw on it (it is outside the webview, which core places) and so cannot hide the way out
          or pass itself off as core. Esc closes it too, from main, wherever the focus is. */}
      {overInst && (
        <>
          <div className="overlay-strip" role="toolbar" aria-label={`${overInst.tile.manifest.name}, over the window`}>
            <Icon tile={overInst.tile} />
            <span className="name">{overInst.tile.manifest.name}</span>
            <span className="muted">{overInst.tile.source === 'core' ? 'is showing over the window' : `is showing over the window · ${overInst.tile.manifest.author}`}</span>
            <span className="overlay-hint">Esc</span>
            <button className="overlay-close" title={`Close ${overInst.tile.manifest.name} (Esc)`} onClick={() => setOverlay(null)}>
              ×
            </button>
          </div>
          <div className="overlay-box" data-overlay={overInst.key} />
        </>
      )}
    </div>
  )
}

function Icon({ tile }: { tile: TileInfo }) {
  return tile.icon ? <img className="icon" src={tile.icon} alt="" /> : <span className="icon letter">{tile.manifest.name[0]}</span>
}
