// The bridge: the only preload a tile's page ever gets, and the only way it talks to core. It
// exposes `window.workshop` and nothing else. Every call is checked again in main (by which
// webview sent it and what its manifest declares); the checks here only give a clear error early.
// CLAUDE.md §5 "The bridge".

import { contextBridge, ipcRenderer } from 'electron'
import { CH, type DoorCall, type TileHead, type TileHello, type TileView } from '../shared/ipc'

const hello = ipcRenderer.sendSync(CH.hello) as TileHello | null

if (hello) {
  let view: TileView = hello.view
  let vars = hello.vars
  const viewSubs = new Set<(v: TileView) => void>()
  const themeSubs = new Set<(v: Record<string, string>) => void>()
  const storageSubs = new Map<string, Set<(v: unknown) => void>>()
  const doorHandlers = new Map<string, (args: string[], caller: string) => unknown>()
  const perms = hello.permissions

  // The theme as CSS variables on :root, before the page's own styles can need them.
  const applyVars = (): void => {
    const root = document.documentElement
    if (!root) return
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  }
  applyVars()
  if (!document.documentElement) document.addEventListener('readystatechange', applyVars, { once: true })

  const sub = <T>(set: Set<T>, fn: T): (() => void) => {
    if (typeof fn !== 'function') throw new TypeError('expected a function')
    set.add(fn)
    return () => void set.delete(fn)
  }
  const needs = (p: keyof typeof perms): void => {
    if (!perms[p]) throw new Error(`add "${p}" to permissions in tile.json`)
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
  ipcRenderer.on(CH.doorCall, async (_e, c: DoorCall) => {
    const fn = doorHandlers.get(c.op)
    if (!fn) return ipcRenderer.send(CH.doorReply, c.callId, { ok: false, error: `no handler for "${c.op}"` })
    try {
      const result = await fn([...c.args], c.caller)
      // Only plain JSON crosses back.
      ipcRenderer.send(CH.doorReply, c.callId, { ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) })
    } catch (err) {
      ipcRenderer.send(CH.doorReply, c.callId, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

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
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CH.external, String(url)),
    storage: {
      get: (key: string): Promise<unknown> => (needs('storage'), ipcRenderer.invoke(CH.storageGet, key)),
      set: (key: string, value: unknown): Promise<void> => (needs('storage'), ipcRenderer.invoke(CH.storageSet, key, value)),
      watch: (key: string, fn: (v: unknown) => void): (() => void) => {
        needs('storage')
        let set = storageSubs.get(key)
        if (!set) storageSubs.set(key, (set = new Set()))
        return sub(set, fn)
      }
    },
    notify: (n: { text: string; bark?: boolean }): Promise<boolean> => (needs('notify'), ipcRenderer.invoke(CH.notify, { text: n?.text })),
    door: {
      /** Answer `op` when a Claude session calls it. The op must be listed under permissions.door.ops. */
      handle: (op: string, fn: (args: string[], caller: string) => unknown): void => {
        needs('door')
        if (!perms.door!.ops.includes(op)) throw new Error(`"${op}" is not in permissions.door.ops in tile.json`)
        if (typeof fn !== 'function') throw new TypeError('expected a function')
        doorHandlers.set(op, fn)
        ipcRenderer.send(CH.doorReady, [...doorHandlers.keys()])
      }
    }
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
