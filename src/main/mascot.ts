// Sprite packs on disk: `<profile>/mascots/<id>/pack.json` and its PNG(s). One is active at a
// time (core's settings say which); core's window asks for it as data: URLs, because its page may
// load images only from itself and data: (the window's CSP), and a pack lives outside the app.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_SHEET_BYTES, checkPack, pngSize, type ActiveMascot } from '@shared/mascot'

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'mascot'

const dataUrl = (png: Uint8Array): string => `data:image/png;base64,${Buffer.from(png).toString('base64')}`

/** A sheet must be a PNG of the size its pack says, and not huge. */
function checkSheet(png: unknown, want: { w: number; h: number }, what: string): Uint8Array {
  if (!(png instanceof Uint8Array)) throw new Error(`${what}: not a file`)
  if (png.byteLength > MAX_SHEET_BYTES) throw new Error(`${what}: larger than ${MAX_SHEET_BYTES / 1024 / 1024} MB`)
  const size = pngSize(png)
  if (!size) throw new Error(`${what}: not a PNG`)
  if (size.w !== want.w || size.h !== want.h) throw new Error(`${what}: ${size.w} × ${size.h}, but the pack says ${want.w} × ${want.h}`)
  return png
}

export class MascotStore {
  constructor(private readonly dir: string) {}

  /** The pack in `<dir>/<id>`, checked again as it is read (a hand-edited folder cannot break the window), or null. */
  async load(id: string | null): Promise<ActiveMascot | null> {
    if (!id || !ID.test(id)) return null
    const folder = join(this.dir, id)
    try {
      const r = checkPack(JSON.parse(await readFile(join(folder, 'pack.json'), 'utf8')))
      if (!r.ok) {
        console.warn(`[mascot] ${folder}/pack.json refused:\n  ${r.errors.join('\n  ')}`)
        return null
      }
      const sheet = checkSheet(new Uint8Array(await readFile(join(folder, r.pack.image))), r.pack.sheet, r.pack.image)
      let worker: string | null = null
      if (r.pack.worker?.image) {
        try {
          worker = dataUrl(checkSheet(new Uint8Array(await readFile(join(folder, r.pack.worker.image))), r.pack.sheet, r.pack.worker.image))
        } catch (err) {
          console.warn(`[mascot] worker sheet ignored: ${(err as Error).message}`)
        }
      }
      return { id, pack: r.pack, sheet: dataUrl(sheet), worker }
    } catch (err) {
      console.warn(`[mascot] ${folder}: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Writes a pack made in the setup screen and returns its id. The folder is written beside its
   * final place and renamed over it, so a pack is never half there. Saving under a name that is
   * already a pack replaces that pack.
   */
  async save(raw: unknown, png: unknown, workerPng?: unknown): Promise<string> {
    const r = checkPack(raw)
    if (!r.ok) throw new Error(r.errors.join('; '))
    const pack = r.pack
    const sheet = checkSheet(png, pack.sheet, 'the sheet')
    const worker = pack.worker?.image ? checkSheet(workerPng, pack.sheet, 'the worker sheet') : null
    const id = slug(pack.name)
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.${id}.${process.pid}.${Date.now()}`)
    await mkdir(tmp)
    await writeFile(join(tmp, 'pack.json'), JSON.stringify(pack, null, 2))
    await writeFile(join(tmp, pack.image), sheet)
    if (worker && pack.worker?.image) await writeFile(join(tmp, pack.worker.image), worker)
    const final = join(this.dir, id)
    await rm(final, { recursive: true, force: true })
    await rename(tmp, final)
    return id
  }

  async remove(id: string | null): Promise<void> {
    if (!id || !ID.test(id)) return
    await rm(join(this.dir, id), { recursive: true, force: true })
  }
}
