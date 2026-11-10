import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkPlugin } from '../src/main/plugin'

function tile(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-plugin-')))
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  return root
}
const SKILL = '---\nname: x\ndescription: Does x.\n---\n\nbody\n'
const errors = async (root: string, id = 'x'): Promise<string[]> => {
  const r = await checkPlugin(root, id)
  return r.ok ? [] : r.errors
}

describe('checkPlugin', () => {
  it('accepts the Wikipedia tile', async () => {
    const r = await checkPlugin(realpathSync(resolve('tiles/wikipedia')), 'wikipedia')
    expect(r).toMatchObject({ ok: true, skills: ['wikipedia'] })
  })

  it('a tile without a plugin is fine', async () => {
    expect(await checkPlugin(tile({ 'tile.json': '{}' }), 'x')).toEqual({ ok: true, dir: null, skills: [] })
  })

  it('wants the plugin named after the tile', async () => {
    const root = tile({ 'plugin/.claude-plugin/plugin.json': '{"name":"other"}', 'plugin/skills/x/SKILL.md': SKILL })
    expect((await errors(root))[0]).toMatch(/must be the tile's id/)
  })

  it('refuses hooks, MCP servers and other trusted-tier pieces', async () => {
    const root = tile({ 'plugin/.claude-plugin/plugin.json': '{"name":"x","mcpServers":{}}', 'plugin/skills/x/SKILL.md': SKILL, 'plugin/hooks/hooks.json': '{}' })
    const e = await errors(root)
    expect(e.some((m) => m.includes('plugin/hooks'))).toBe(true)
    expect(e.some((m) => m.includes('mcpServers'))).toBe(true)
  })

  it('wants every skill to have a SKILL.md with a description', async () => {
    const root = tile({ 'plugin/.claude-plugin/plugin.json': '{"name":"x"}', 'plugin/skills/a/SKILL.md': '---\nname: a\n---\n', 'plugin/skills/b/notes.md': 'hi' })
    const e = await errors(root)
    expect(e.some((m) => m.includes('skills/a/SKILL.md'))).toBe(true)
    expect(e.some((m) => m.includes('skills/b: no SKILL.md'))).toBe(true)
  })
})
