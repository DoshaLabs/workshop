// A new tile from the starter in template/: what the column's + menu does before it starts a
// Claude session in the folder. The starter is a working tile, so the user sees something in the
// column at once and Claude has a page that already loads to change.

import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ID_RE } from '@shared/manifest'

/** "Focus timer!" → "focus-timer". Always a valid tile id. */
export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return ID_RE.test(s) ? s : 'tile'
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

/** JSON and HTML both take these as they are. */
const plain = (s: string, max: number): string => s.replace(/[\u0000-\u001f"\\<>&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * Copies the starter into a new folder under `root`, named after the tile. The id is the name's
 * slug, with a number after it if a tile (`taken`) or a folder already has that one.
 */
export async function scaffoldTile(template: string, root: string, name: string, hint: string, taken: (id: string) => boolean): Promise<{ id: string; name: string; folder: string }> {
  const clean = plain(name, 40) || 'New tile'
  const base = slug(clean)
  let id = base
  for (let n = 2; taken(id) || (await exists(join(root, id))); n++) id = `${base.slice(0, 36)}-${n}`
  const folder = join(root, id)
  await mkdir(root, { recursive: true })
  await cp(template, folder, { recursive: true, errorOnExist: true, force: false })
  const fill = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await fill(p)
      // The guide (CLAUDE.md) is about tiles in general and has no blanks to fill.
      else if (/\.(json|html|js|css)$/.test(e.name)) {
        const text = await readFile(p, 'utf8')
        const out = text.replaceAll('__ID__', id).replaceAll('__NAME__', clean).replaceAll('__HINT__', plain(hint, 120) || clean)
        if (out !== text) await writeFile(p, out)
      }
    }
  }
  await fill(folder)
  return { id, name: clean, folder }
}
