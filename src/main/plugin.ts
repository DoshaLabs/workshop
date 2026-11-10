// A tile's optional Claude Code half: `plugin/` in the tile's folder, an ordinary Claude Code
// plugin that core hands to new sessions with `--plugin-dir`. The layout is Claude Code's own
// (checked with `claude plugin validate` on 2.1.322):
//
//   plugin/.claude-plugin/plugin.json   { "name": "<the tile's id>", ... }
//   plugin/skills/<skill>/SKILL.md      frontmatter with name and description
//
// The plugin's name must be the tile's id, so its skills read `<tile-id>:<skill>` in a session
// and two tiles can never collide. Only skills are accepted for now: hooks, MCP servers, agents
// and commands would run with the session's full permissions, which is the trusted tier.

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

export const PLUGIN_DIR = 'plugin'
/** What a plugin folder may hold besides its manifest and skills. Anything else is refused. */
const ALLOWED_TOP = new Set(['.claude-plugin', 'skills', 'README.md', 'LICENSE'])

export type PluginCheck = { ok: true; dir: string | null; skills: string[] } | { ok: false; errors: string[] }

const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

/** Checks `<root>/plugin`. A tile without one is fine (`dir: null`). */
export async function checkPlugin(root: string, tileId: string): Promise<PluginCheck> {
  const dir = join(root, PLUGIN_DIR)
  if (!(await exists(dir))) return { ok: true, dir: null, skills: [] }
  const errors: string[] = []
  const real = await realpath(dir)
  if (!real.startsWith(root + sep)) return { ok: false, errors: ['plugin: points outside the tile folder'] }

  for (const name of await readdir(real)) {
    if (name === '.DS_Store') continue
    if (!ALLOWED_TOP.has(name)) errors.push(`plugin/${name}: a tile's plugin holds only skills for now (hooks, MCP servers, agents and commands are the trusted tier)`)
  }

  try {
    const man = JSON.parse(await readFile(join(real, '.claude-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>
    if (man.name !== tileId) errors.push(`plugin/.claude-plugin/plugin.json: "name" must be the tile's id, "${tileId}"`)
    for (const k of ['hooks', 'mcpServers', 'agents', 'commands', 'lspServers']) if (k in man) errors.push(`plugin/.claude-plugin/plugin.json: "${k}" is the trusted tier`)
  } catch (err) {
    errors.push(`plugin/.claude-plugin/plugin.json: ${(err as Error).message}`)
  }

  const skills: string[] = []
  let entries: string[] = []
  try {
    entries = await readdir(join(real, 'skills'))
  } catch {
    errors.push('plugin/skills: missing (put each skill at plugin/skills/<name>/SKILL.md)')
  }
  for (const s of entries) {
    if (s === '.DS_Store') continue
    const file = join(real, 'skills', s, 'SKILL.md')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      errors.push(`plugin/skills/${s}: no SKILL.md`)
      continue
    }
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
    if (!/^description:\s*\S/m.test(fm)) errors.push(`plugin/skills/${s}/SKILL.md: frontmatter needs a description (it is how a session knows when to use it)`)
    skills.push(s)
  }
  if (entries.length && !skills.length) errors.push('plugin/skills: no skills')

  return errors.length ? { ok: false, errors } : { ok: true, dir: real, skills }
}
