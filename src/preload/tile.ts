// The bridge: the only preload a tile's page ever gets, and the only way it talks to core. It
// exposes `window.workshop` and nothing else. Every call is checked again in main (by which
// webview sent it and what its manifest declares); the checks here only give a clear error early.
// CLAUDE.md §5 "The bridge".

import { contextBridge, ipcRenderer } from 'electron'
import { FONTS_PREFIX, FONT_FILES } from '../shared/fonts'
import { CH, type DoorCall, type TileHead, type TileHello, type TileView } from '../shared/ipc'
import { badSeek, badUri, badVolume } from '../shared/music'

const hello = ipcRenderer.sendSync(CH.hello) as TileHello | null

if (hello) {
  let view: TileView = hello.view
  let vars = hello.vars
  const viewSubs = new Set<(v: TileView) => void>()
  const themeSubs = new Set<(v: Record<string, string>) => void>()
  const storageSubs = new Map<string, Set<(v: unknown) => void>>()
  const sessionSubs = new Set<(list: unknown) => void>()
  const usageSubs = new Set<(u: unknown) => void>()
  const backendSubs = new Set<(s: unknown) => void>()
  const backendEventSubs = new Set<(e: unknown) => void>()
  const doorHandlers = new Map<string, (args: string[], caller: string, from: { session: string | null }) => unknown>()
  const perms = hello.permissions

  // The theme as CSS variables on :root, before the page's own styles can need them.
  const applyVars = (): void => {
    const root = document.documentElement
    if (!root) return
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    if (vars['--ws-scheme']) root.style.colorScheme = vars['--ws-scheme']
  }
  applyVars()

  // Core's fonts, so `var(--ws-font)` and friends name faces the page really has. They are fetched
  // from the tile's own origin; a page whose CSP has no `font-src 'self'` just keeps the system's.
  const fontBase = location.protocol === 'tile:' ? '' : `tile://${hello.id}`
  for (const f of FONT_FILES) {
    try {
      document.fonts.add(new FontFace(f.family, `url(${fontBase}${FONTS_PREFIX}${f.file})`, { style: f.style, weight: f.weight, display: 'swap' }))
    } catch {
      // no fonts API this early: the fallbacks in the stacks apply
    }
  }
  if (!document.documentElement) document.addEventListener('readystatechange', applyVars, { once: true })

  const sub = <T>(set: Set<T>, fn: T): (() => void) => {
    if (typeof fn !== 'function') throw new TypeError('expected a function')
    set.add(fn)
    return () => void set.delete(fn)
  }
  const needs = (p: keyof typeof perms): void => {
    if (!perms[p]) throw new Error(`add "${p}" to permissions in tile.json`)
  }
  /** A promise-returning method without its permission rejects, like any other failure. */
  const gate = <T>(p: keyof typeof perms, fn: () => Promise<T>): Promise<T> => {
    try {
      needs(p)
    } catch (err) {
      return Promise.reject(err)
    }
    return fn()
  }
  const call = (fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      console.error('[workshop]', err)
    }
  }

  ipcRenderer.on(CH.view, (_e, v: TileView) => {
    view = v
    for (const fn of viewSubs) call(() => fn(v))
  })
  ipcRenderer.on(CH.theme, (_e, v: Record<string, string>) => {
    vars = v
    applyVars()
    for (const fn of themeSubs) call(() => fn({ ...v }))
  })
  ipcRenderer.on(CH.storageChanged, (_e, key: string, value: unknown) => {
    for (const fn of storageSubs.get(key) ?? []) call(() => fn(value))
  })
  ipcRenderer.on(CH.tileSessionsChanged, (_e, list: unknown) => {
    for (const fn of sessionSubs) call(() => fn(list))
  })
  ipcRenderer.on(CH.tileUsageChanged, (_e, u: unknown) => {
    for (const fn of usageSubs) call(() => fn(u))
  })
  ipcRenderer.on(CH.backendStatusChanged, (_e, st: unknown) => {
    for (const fn of backendSubs) call(() => fn(st))
  })
  ipcRenderer.on(CH.backendEvent, (_e, ev: unknown) => {
    for (const fn of backendEventSubs) call(() => fn(ev))
  })
  const musicSubs = new Set<(s: unknown) => void>()
  ipcRenderer.on(CH.musicChanged, (_e, s: unknown) => {
    for (const fn of musicSubs) call(() => fn(s))
  })

  // The wheel at the page's edge belongs to the column (deck's rule: a tile never eats it). A wheel
  // that nothing under the pointer can use (nothing scrolls that way, or it is at its end) is passed
  // to core, which scrolls the tile column by it: scroll chaining across the webview's border. The
  // page keeps every wheel it can use, and one it cancels (a map's zoom). Summed per frame, so a
  // trackpad's stream (momentum too) is one message a frame. Pinch (ctrlKey) is never passed.
  const scrollsY = (el: Element, dy: number): boolean => {
    const root = el === document.scrollingElement
    const oy = getComputedStyle(el).overflowY
    if (root ? oy === 'hidden' || oy === 'clip' || (document.body && ['hidden', 'clip'].includes(getComputedStyle(document.body).overflowY)) : oy !== 'auto' && oy !== 'scroll') return false
    if (el.scrollHeight <= el.clientHeight + 1) return false
    return dy < 0 ? el.scrollTop > 0.5 : el.scrollTop + el.clientHeight < el.scrollHeight - 1
  }
  const pageCanUse = (e: WheelEvent): boolean => {
    for (let el = e.target instanceof Element ? e.target : null; el; el = el.parentElement) if (scrollsY(el, e.deltaY)) return true
    const root = document.scrollingElement
    return !!root && scrollsY(root, e.deltaY)
  }
  let pending: WheelEvent[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    let dy = 0
    for (const e of pending) if (!e.defaultPrevented) dy += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY
    pending = []
    if (dy) ipcRenderer.send(CH.wheel, dy)
  }
  window.addEventListener(
    'wheel',
    (e) => {
      if (view !== 'tile' || e.ctrlKey || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY) || pageCanUse(e)) return
      // One message a frame; the timer covers a page that is not drawing (rAF waits for a frame).
      if (pending.length === 0) {
        requestAnimationFrame(flush)
        setTimeout(flush, 50)
      }
      pending.push(e)
    },
    { passive: true }
  )

  ipcRenderer.on(CH.doorCall, async (_e, c: DoorCall) => {
    const fn = doorHandlers.get(c.op)
    if (!fn) return ipcRenderer.send(CH.doorReply, c.callId, { ok: false, error: `no handler for "${c.op}"` })
    try {
      const result = await fn([...c.args], c.caller, { session: c.session })
      // Only plain JSON crosses back.
      ipcRenderer.send(CH.doorReply, c.callId, { ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) })
    } catch (err) {
      ipcRenderer.send(CH.doorReply, c.callId, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // The trusted tier (bridge 1.2): only on a built-in tile whose manifest declares a backend.
  const backendOps = hello.backendOps ?? []
  const backend = perms.backend
    ? {
        backend: {
          /** Asks the tile's backend `op` with a JSON `body`; resolves to its JSON answer. The op must be in the manifest's backend.ops. */
          call: (op: string, body?: unknown): Promise<unknown> =>
            backendOps.includes(op) ? ipcRenderer.invoke(CH.backendCall, op, body === undefined ? null : body) : Promise.reject(new Error(`"${op}" is not in backend.ops in tile.json`)),
          /** { state: 'starting' | 'running' | 'restarting' | 'failed' | 'stopped', error? } */
          status: (): Promise<unknown> => ipcRenderer.invoke(CH.backendStatus),
          onStatus: (fn: (s: unknown) => void) => sub(backendSubs, fn),
          /** Something the backend told its pages (`kit.emit(name, data)`): fn({ name, data }). */
          onEvent: (fn: (e: unknown) => void) => sub(backendEventSubs, fn)
        }
      }
    : {}

  // Spotify and Music (bridge 1.3): only on a tile whose manifest asks for "music". Values are
  // checked here for a clear error early, and again in main, which is what counts.
  const control = (op: string, arg?: unknown, bad?: string | null): Promise<void> => (bad ? Promise.reject(new Error(bad)) : ipcRenderer.invoke(CH.musicControl, op, arg))
  const music = perms.music
    ? {
        music: {
          /** { player: 'spotify' | 'music' | null, state, track: { title, artist, album, durationMs, art } | null, positionMs, volume, shuffle?, repeat?, error?, message? } */
          get: (): Promise<unknown> => ipcRenderer.invoke(CH.musicGet),
          /** Calls fn with the state whenever it changes (and once at once). Core reads the apps only while some page watches. */
          watch: (fn: (s: unknown) => void): (() => void) => {
            const first = musicSubs.size === 0
            const stop = sub(musicSubs, fn)
            if (first) ipcRenderer.send(CH.musicWatch, true)
            return () => {
              stop()
              if (musicSubs.size === 0) ipcRenderer.send(CH.musicWatch, false)
            }
          },
          play: (): Promise<void> => control('play'),
          pause: (): Promise<void> => control('pause'),
          toggle: (): Promise<void> => control('toggle'),
          next: (): Promise<void> => control('next'),
          previous: (): Promise<void> => control('previous'),
          seek: (ms: number): Promise<void> => control('seek', ms, badSeek(ms)),
          setVolume: (v: number): Promise<void> => control('volume', v, badVolume(v)),
          /** Spotify only: a URI as Spotify's share menu gives it (spotify:track:…, album, playlist, artist, episode, show). */
          playUri: (uri: string): Promise<void> => control('uri', uri, badUri(uri))
        }
      }
    : {}

  // contextBridge copies a getter's value once, so the live values (view, theme.vars) cross as
  // functions and the page-side object below turns them back into properties.
  const raw = {
    bridge: hello.bridge,
    id: hello.id,
    /** Which instance this page is: the id for the first, `<id>.<n>` for others (manifest `multiple`). */
    instance: hello.instance,
    viewNow: (): TileView => view,
    onViewChange: (fn: (v: TileView) => void) => sub(viewSubs, fn),
    theme: {
      varsNow: (): Record<string, string> => ({ ...vars }),
      onChange: (fn: (v: Record<string, string>) => void) => sub(themeSubs, fn)
    },
    head: {
      set: (h: TileHead): Promise<void> => ipcRenderer.invoke(CH.head, { title: h?.title, badge: h?.badge })
    },
    openPane: (): Promise<void> => ipcRenderer.invoke(CH.pane, true),
    closePane: (): Promise<void> => ipcRenderer.invoke(CH.pane, false),
    /**
     * This page over the whole window, under a strip core draws (the tile's name, a close button).
     * Needs "overlay" in permissions and a click or key in this page in the last few seconds. Esc
     * closes it whatever the page does; `workshop.view` is 'overlay' while it is open.
     */
    openOverlay: (): Promise<void> => gate('overlay', () => ipcRenderer.invoke(CH.overlay, true)),
    closeOverlay: (): Promise<void> => ipcRenderer.invoke(CH.overlay, false),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CH.external, String(url)),
    storage: {
      get: (key: string): Promise<unknown> => gate('storage', () => ipcRenderer.invoke(CH.storageGet, key)),
      set: (key: string, value: unknown): Promise<void> => gate('storage', () => ipcRenderer.invoke(CH.storageSet, key, value)),
      watch: (key: string, fn: (v: unknown) => void): (() => void) => {
        needs('storage')
        let set = storageSubs.get(key)
        if (!set) storageSubs.set(key, (set = new Set()))
        return sub(set, fn)
      }
    },
    files: {
      /** Opens the macOS chooser. Resolves to { handle, name, kind } for what the user picked, or null. */
      pick: (opts: { folder?: boolean; title?: string } = {}): Promise<unknown> => gate('files', () => ipcRenderer.invoke(CH.filesPick, { folder: opts?.folder, title: opts?.title })),
      /** What the user has picked for this tile before (kept across restarts). */
      list: (): Promise<unknown> => gate('files', () => ipcRenderer.invoke(CH.filesList)),
      /** A folder's contents: [{ name, kind, size }]. */
      entries: (handle: string, path = ''): Promise<unknown> => gate('files', () => ipcRenderer.invoke(CH.filesEntries, handle, path)),
      /** A URL for a picked file, for fetch(), <img>, <audio>…; streamed, so large files are fine. */
      url: (handle: string, path = ''): string => {
        needs('files')
        const p = String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/')
        return `tile://${hello.id}/~files/${encodeURIComponent(handle)}/${p}`
      },
      /** A picked file's contents, as text or bytes. */
      read: async (handle: string, path = '', as: 'text' | 'bytes' = 'bytes'): Promise<string | ArrayBuffer> => {
        needs('files')
        const p = String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/')
        const res = await fetch(`tile://${hello.id}/~files/${encodeURIComponent(handle)}/${p}`)
        if (!res.ok) throw new Error(`files: cannot read "${path}"`)
        return as === 'text' ? res.text() : res.arrayBuffer()
      },
      forget: (handle: string): Promise<boolean> => gate('files', () => ipcRenderer.invoke(CH.filesForget, handle))
    },
    sessions: {
      /** The sessions: [{ id, name, project (the start folder), root (its repo root), status, focused, open }]. Needs "sessions": "read", "launch" or "write". */
      list: (): Promise<unknown> => gate('sessions', () => ipcRenderer.invoke(CH.tileSessionsList)),
      watch: (fn: (list: unknown) => void): (() => void) => {
        needs('sessions')
        return sub(sessionSubs, fn)
      },
      /** Types `text` into an open session and submits it. Needs "sessions": "write". */
      paste: (id: string, text: string): Promise<void> => gate('sessions', () => ipcRenderer.invoke(CH.tileSessionsPaste, id, text)),
      // Only there with "sessions": "launch" or "write" (bridge 1.4): a tile without it has no such method.
      ...(perms.sessions === 'launch' || perms.sessions === 'write'
        ? {
            /**
             * Opens core's new-session form, filled in with `folder` (and a new worktree, named after
             * `worktree.branch`, when asked), for the user to start. It never starts a session. Only in
             * answer to a click or key in the tile.
             */
            launch: (opts: { folder: string; worktree?: { branch?: string } }): Promise<void> => ipcRenderer.invoke(CH.tileSessionsLaunch, opts)
          }
        : {})
    },
    usage: {
      /** The account's 5-hour and weekly windows, and each session's context % and cost. Needs "usage". */
      get: (): Promise<unknown> => gate('usage', () => ipcRenderer.invoke(CH.tileUsageGet)),
      watch: (fn: (u: unknown) => void): (() => void) => {
        needs('usage')
        return sub(usageSubs, fn)
      }
    },
    notify: (n: { text: string; attention?: boolean }): Promise<boolean> => gate('notify', () => ipcRenderer.invoke(CH.notify, { text: n?.text, attention: n?.attention === true })),
    door: {
      /**
       * Answer `op` when a Claude session calls it: `fn(args, caller, { session })`. `caller` is the
       * session's name (or "outside"); `session` is its id as `workshop.sessions` lists it, or null.
       * The op must be listed under permissions.door.ops.
       */
      handle: (op: string, fn: (args: string[], caller: string, from: { session: string | null }) => unknown): void => {
        needs('door')
        if (!perms.door!.ops.includes(op)) throw new Error(`"${op}" is not in permissions.door.ops in tile.json`)
        if (typeof fn !== 'function') throw new TypeError('expected a function')
        doorHandlers.set(op, fn)
        ipcRenderer.send(CH.doorReady, [...doorHandlers.keys()])
      }
    },
    ...backend,
    ...music
  }

  contextBridge.executeInMainWorld({
    func: (r: typeof raw) => {
      const { viewNow, theme, ...rest } = r
      const api = { ...rest, theme: { onChange: theme.onChange } }
      Object.defineProperty(api, 'view', { get: viewNow, enumerable: true })
      Object.defineProperty(api.theme, 'vars', { get: theme.varsNow, enumerable: true })
      for (const v of Object.values(api)) if (v && typeof v === 'object') Object.freeze(v)
      Object.defineProperty(window, 'workshop', { value: Object.freeze(api), enumerable: true })
    },
    args: [raw]
  })
}
