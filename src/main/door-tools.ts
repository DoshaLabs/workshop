// The tiles a Codex session can call through its MCP server (bin/workshop-mcp.mjs): every installed
// tile with door ops, with its plugin's skills read from disk (the words a Claude session reads
// through --plugin-dir). Shaped into tools by src/shared/door-tools.ts.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkill, type DoorTile } from '@shared/door-tools'
import type { Tile } from './tiles'

/** A SKILL.md larger than this is cut (the tool's description is capped anyway). */
const SKILL_MAX = 64 * 1024

export async function doorTilesOf(tiles: Tile[]): Promise<DoorTile[]> {
  const out: DoorTile[] = []
  for (const t of tiles) {
    const ops = t.manifest.permissions.door?.ops ?? []
    if (!ops.length) continue
    out.push({ id: t.manifest.id, name: t.manifest.name, hint: t.manifest.hint ?? '', ops: [...ops], skills: t.plugin ? await skillsOf(t.plugin) : [] })
  }
  return out
}

async function skillsOf(plugin: string): Promise<DoorTile['skills']> {
  const dir = join(plugin, 'skills')
  const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const skills: DoorTile['skills'] = []
  for (const d of names.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await readFile(join(dir, d.name, 'SKILL.md'), 'utf8').catch(() => null)
    if (text) skills.push(parseSkill(text.slice(0, SKILL_MAX), d.name))
  }
  return skills
}
