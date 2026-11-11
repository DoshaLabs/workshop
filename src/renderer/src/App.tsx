// Core's window: sessions on the left (they arrive in roadmap step 3), what you are on now in the
// center, tiles on the right. Core draws every tile's head; the tile's page fills the face.
//
// The column holds tile INSTANCES. A tile's first instance is keyed by its id; a tile with
// `multiple: true` may have more, keyed `<id>.<n>` (n up to 4), each its own page and partition.

import { goldOf, hex, parseColor } from '@shared/knot'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ThemeState, TileHead, TileInfo, TileProblem, TileView } from '@shared/ipc'
import { syncCosmos } from './cosmos'
import { ThemePicker } from './ThemePicker'
import { FocusPane, Launcher } from './Sessions'
import { SessionColumn } from './SessionColumn'
import { Guard } from './Guard'
import { setPalette } from './terminals'
import { shortcutOrder, type LaunchPrefill, type SessionsState } from '@shared/sessions'
import { stepFrom } from '@shared/shortcuts'
import { LEGACY_KEYS, firstColumn, legacyColumn, type ColumnState } from '@shared/column'
import { MAX_SPAN } from '@shared/manifest'
import type { Usage } from '@shared/usage'
import { UsageMeter } from './UsageMeter'
import { TileLayer, type Instance } from './TileLayer'
import { TilePicker } from './TilePicker'
import { MascotSetup } from './MascotSetup'
import { RecordButton } from './RecordButton'
import { UpdateButton } from './UpdateButton'
import { AppMark } from './Knot'
import { PreviewPane } from './PreviewPane'
import { closeDoc, useDoc } from './preview-store'
import { useReorder } from './reorder'
import { arrange, moved, ordered, pruned } from '@shared/order'

const MAX_INSTANCES = 4

/** Paints the window: the variables, and the attributes the stylesheet keys the wall and dark mode on. */
function applyTheme(t: ThemeState): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v)
  // The worker coat's gold, from this theme's accent (the wolfpack's tiles; their knots use the same).
  const accent = parseColor(t.vars['--ws-accent'] ?? '')
  if (accent) root.style.setProperty('--ws-worker', hex(goldOf(accent)))
  root.dataset.theme = t.theme
  root.dataset.wall = String(t.wall)
  root.dataset.dark = String(t.dark)
  syncCosmos(t.theme)
  setPalette(t.term)
}

/** The ⌘ number of session `id`, if it is one of the first nine. */
const focusKey = (st: SessionsState | null, order: string[] | undefined, id: string): number | undefined => {
  const i = shortcutOrder(st, order).indexOf(id)
  return i >= 0 && i < 9 ? i + 1 : undefined
}
const instanceN = (key: string): number => Number(/\.(\d)$/.exec(key)?.[1] ?? 1)
const tileIdOf = (key: string): string => key.replace(/\.\d$/, '')

export function App() {
  const [tiles, setTiles] = useState<TileInfo[]>([])
  const [problems, setProblems] = useState<TileProblem[]>([])
  /** Tiles whose first instance is turned off. */
  const [off, setOff] = useState<string[]>([])
  /** Second and later instances that are on: `<id>.<n>`. */
  const [extra, setExtra] = useState<string[]>([])
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
  /** What a tile filled the launcher with (workshop.sessions.launch); the user still presses Start. */
  const [prefill, setPrefill] = useState<LaunchPrefill | undefined>(undefined)
  /** The tile column's + menu. */
  const [picker, setPicker] = useState(false)
  /** The mascot's setup screen, in the center (the button beside the theme picker). */
  const [mascotSetup, setMascotSetup] = useState(false)
  /** Heights the user set with ↕, by instance; a tile without one takes its manifest's `span`. */
  const [spans, setSpans] = useState<Record<string, number>>({})
  /** The orders the user dragged the two columns into (settings.column), or none yet. */
  const [order, setOrder] = useState<string[] | undefined>(undefined)
  const [sessionOrder, setSessionOrder] = useState<string[] | undefined>(undefined)
  /** The file in the preview pane, if any (track E): it takes the center until closed. */
  const doc = useDoc()
  /**
   * The column's state is core's (main/settings.ts), so clearing the window's storage cannot reset it.
   * No tile is drawn until it has arrived: a page mounted for a tile that turns out to be off would
   * be made and thrown away. A profile that has never saved one takes what the window's
   * localStorage held, once, and the old keys go.
   */
  const [columnReady, setColumnReady] = useState(false)
  useEffect(() => {
    let live = true
    const apply = (c: ColumnState): void => {
      if (!live) return
      setOff(c.off)
      setExtra(c.extra)
      setSpans(c.spans)
      setOrder(c.order)
      setSessionOrder(c.sessions)
      setColumnReady(true)
    }
    window.core
      .column()
      .then(async (saved) => {
        if (saved) return apply(saved)
        let legacy: ColumnState
        try {
          legacy = firstColumn(legacyColumn((k) => localStorage.getItem(k)))
        } catch {
          legacy = firstColumn({ off: [], extra: [], spans: {} })
        }
        await window.core.setColumn(legacy)
        try {
          for (const k of Object.values(LEGACY_KEYS)) localStorage.removeItem(k)
        } catch {
          // gone or not, settings has it now
        }
        apply(legacy)
      })
      .catch((err) => {
        // Settings unreachable: the column still draws, it just will not remember.
        console.error('[window] the tile column could not be read:', err)
        apply({ off: [], extra: [], spans: {} })
      })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (columnReady) window.core.setColumn({ off, extra, spans, ...(order ? { order } : {}), ...(sessionOrder ? { sessions: sessionOrder } : {}) }).catch((err) => console.error('[window] the tile column could not be saved:', err))
  }, [columnReady, off, extra, spans, order, sessionOrder])
  const spanOf = (i: Instance): number => {
    const n = spans[i.key] ?? i.tile.manifest.span
    return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_SPAN) : 1
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
      // A tile asked for a new session here: the launcher takes the center, filled in. Nothing starts.
      window.core.onLaunch((p) => {
        if (!closeDoc()) return
        setPane(null)
        setOverlay(null)
        setMascotSetup(false)
        setPrefill(p)
        setLauncher(true)
      }),
      window.core.onTileNotify((key, text) => {
        setChips((c) => ({ ...c, [key]: text }))
        window.setTimeout(() => setChips((c) => (c[key] === text ? { ...c, [key]: '' } : c)), 8000)
      })
    ]
    return () => offs.forEach((f) => f())
  }, [])

  // A wheel a tile's page could not use scrolls the column it sits in (preload/tile.ts passes it on).
  const tileScroll = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      window.core.onTileWheel((_key, dy) => {
        if (tileScroll.current) tileScroll.current.scrollTop += dy
      }),
    []
  )

  // A session coming into focus (started, resumed, clicked) takes the center back from a tile.
  const focusId = sessions?.focus ?? null
  useEffect(() => {
    if (focusId) {
      setPane(null)
      setLauncher(false)
      closeDoc()
    }
  }, [focusId])

  // ⌘1–9, ⌘[ ⌘], ⌘N, from wherever the focus is (main catches them; shared/shortcuts.ts). A session
  // reached this way takes the whole center: the launcher, a pane and an overlay give way.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const sessionOrderRef = useRef(sessionOrder)
  sessionOrderRef.current = sessionOrder
  useEffect(
    () =>
      window.core.onShortcut((s) => {
        if (!closeDoc()) return
        if (s.kind === 'new') {
          setPane(null)
          setOverlay(null)
          setLauncher(true)
          return
        }
        const st = sessionsRef.current
        const keys = shortcutOrder(st, sessionOrderRef.current)
        const id = s.kind === 'focus' ? (keys[s.n - 1] ?? null) : stepFrom(keys, st?.focus ?? null, s.dir)
        if (!id) return
        setPane(null)
        setOverlay(null)
        setLauncher(false)
        void window.core.focusSession(id)
      }),
    []
  )

  useEffect(() => {
    if (focusId) setMascotSetup(false)
  }, [focusId])

  // Anything else taking the center closes the preview pane (which asks first if it has unsaved edits).
  useEffect(() => {
    if (pane || launcher || mascotSetup) closeDoc()
  }, [pane, launcher, mascotSetup])


  /** Every instance that is on, each tile's together, in the catalog's order. */
  const instances = useMemo<Instance[]>(() => {
    const out: Instance[] = []
    if (!columnReady) return out
    for (const tile of tiles) {
      const id = tile.manifest.id
      if (!off.includes(id)) out.push({ key: id, n: 1, tile })
      if (!tile.manifest.multiple) continue
      for (const key of extra.filter((k) => tileIdOf(k) === id).sort()) out.push({ key, n: instanceN(key), tile })
    }
    return out
  }, [tiles, off, extra, columnReady])

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

  // The tile column in the order the user dragged it into; tiles it has not seen at the foot.
  const shown = useMemo(() => {
    const byKey = new Map(instances.map((i) => [i.key, i]))
    return ordered([...byKey.keys()], order ?? []).map((k) => byKey.get(k)!)
  }, [instances, order])
  const tileDrag = useReorder('tiles', (key, target, after) => {
    const showing = instances.map((i) => i.key)
    const known = new Set(tiles.map((t) => t.manifest.id))
    setOrder(pruned(moved(arrange(showing, order ?? []), key, target, after), showing, (k) => known.has(tileIdOf(k))))
  })
  const moveSession = (key: string, target: string | null, after: boolean): void => {
    const all = sessions?.sessions ?? []
    const open = all.filter((x) => x.open).map((x) => x.id)
    // The first drag starts from the column as it is drawn now (most recently active first).
    const from = sessionOrder ?? open
    setSessionOrder(pruned(moved(arrange(open, from), key, target, after), open, (k) => all.some((x) => x.id === k)))
  }

  const paneInst = instances.find((i) => i.key === pane)
  const overInst = instances.find((i) => i.key === overlay)
  const focused = sessions?.sessions.find((s) => s.id === sessions.focus && s.open) ?? null
  const label = (i: Instance): string => heads[i.key]?.title || (i.n > 1 ? `${i.tile.manifest.name} ${i.n}` : i.tile.manifest.name)

  return (
    <div className={`app ${overInst ? 'overlaid' : ''}`}>
      <AppMark working={!!sessions?.sessions.some((s) => s.open && s.status === 'busy')} />
      <div className="topbar">
        <UsageMeter usage={usage} />
        <UpdateButton />
        <RecordButton />
        <button className="ghost small" title="The mascot: a sprite in every session's head" onClick={() => setMascotSetup((v) => !v)}>
          Mascot
        </button>
        {theme && <ThemePicker theme={theme} />}
      </div>
      <Guard what="The session column" reset={sessions}>
        <SessionColumn
          state={sessions}
          usage={usage}
          center={focused && !launcher && !paneInst && !doc ? focused.id : null}
          order={sessionOrder}
          onMove={moveSession}
          onRecent={() => setSessionOrder(undefined)}
          onNew={() => {
            if (!closeDoc()) return
            setPane(null)
            setLauncher(true)
          }}
          onPick={() => {
            closeDoc()
            setPane(null)
            setLauncher(false)
          }}
        />
      </Guard>

      <main className="col center">
        {doc ? (
          <PreviewPane target={doc} onClose={() => closeDoc(true)} />
        ) : mascotSetup ? (
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
          <FocusPane session={focused} usage={usage} n={focusKey(sessions, sessionOrder, focused.id)} />
        ) : (
          <div className="center-scroll">
            <Launcher recent={sessions?.recent ?? []} prefill={prefill} onStarted={() => setLauncher(false)} />
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
        <div className="tile-scroll" ref={tileScroll}>
          {shown.map((i) => {
            const t = i.tile
            const head = heads[i.key]
            return (
              <article key={i.key} className={`tile ${pane === i.key ? 'in-pane' : ''} ${tileDrag.mark(i.key)}`} data-tile={i.key} style={{ '--span': spanOf(i) } as CSSProperties} {...tileDrag.target(i.key)}>
                <header className="head">
                  <span {...tileDrag.grip(i.key, label(i))}>⠿</span>
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
                  <button className="ghost" title={spanOf(i) < MAX_SPAN ? `Make it taller: ${spanOf(i) + 1} rows` : 'Back to one row'} onClick={() => setSpans((s) => ({ ...s, [i.key]: spanOf(i) < MAX_SPAN ? spanOf(i) + 1 : 1 }))}>
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
              onOff={close}
              onOn={(id) => setOff((o) => o.filter((x) => x !== id))}
              onClose={() => setPicker(false)}
            />
          ) : (
            <button className={`tile tile-plus ${tileDrag.mark(null)}`} title="Add a tile, or build a new one" onClick={() => setPicker(true)} {...tileDrag.target(null)}>
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
