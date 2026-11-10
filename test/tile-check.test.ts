import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkTileFolder, formatCheck } from '../src/main/tile-check'

const MANIFEST = { id: 'demo', name: 'Demo', version: '0.1.0', workshop: '^1', author: 'me', repo: 'https://example.com/demo', icon: 'icon.svg', entry: 'dist/index.html' }
const PAGE = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><p>hi</p>'
const SKILL = '---\nname: demo\ndescription: Does demo things.\n---\n\nbody\n'

/** A tile folder in a temp dir: the good one, with `files` laid over it (null deletes). */
function folder(files: Record<string, string | null> = {}, manifest: Record<string, unknown> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-check-')))
  const all: Record<string, string | null> = { 'tile.json': JSON.stringify({ ...MANIFEST, ...manifest }), 'dist/index.html': PAGE, 'icon.svg': '<svg/>', ...files }
  for (const [p, text] of Object.entries(all)) {
    if (text === null) continue
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  return root
}

describe('tile check', () => {
  it('passes the tiles that ship with workshop', async () => {
    for (const t of ['wikipedia', 'reminders']) {
      const r = await checkTileFolder(resolve('tiles', t))
      expect(r.errors, t).toEqual([])
      expect(r).toMatchObject({ ok: true, manifest: { id: t } })
    }
  })

  it('passes a good folder with no warnings', async () => {
    const r = await checkTileFolder(folder())
    expect(r).toMatchObject({ ok: true, errors: [], warnings: [] })
    expect(formatCheck(r)).toMatch(/^ok {2}Demo \(demo 0\.1\.0\)/)
  })

  it('wants a folder with a tile.json', async () => {
    expect((await checkTileFolder('/nonexistent/x')).errors[0]).toMatch(/not a folder/)
    expect((await checkTileFolder(folder({ 'tile.json': null }))).errors).toEqual(['tile.json: missing'])
    expect((await checkTileFolder(folder({ 'tile.json': '{nope' }))).errors[0]).toMatch(/^tile\.json:/)
  })

  it('reports the manifest validator\'s errors', async () => {
    const r = await checkTileFolder(folder({}, { id: 'Not An Id', permissions: { root: true } }))
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/id:/)
    expect(r.errors.join('\n')).toMatch(/permissions\.root/)
  })

  it('wants the page and the icon in the folder', async () => {
    expect((await checkTileFolder(folder({ 'dist/index.html': null }))).errors[0]).toMatch(/entry: dist\/index\.html does not exist/)
    expect((await checkTileFolder(folder({ 'icon.svg': null }))).errors[0]).toMatch(/icon: icon\.svg does not exist/)
    const outside = folder({ 'dist/index.html': null, 'dist/other.css': '' })
    symlinkSync(join(folder(), 'dist/index.html'), join(outside, 'dist/index.html'))
    expect((await checkTileFolder(outside)).errors[0]).toMatch(/points outside/)
  })

  it('a dev server entry passes only with --dev', async () => {
    const f = folder({}, { entry: 'http://localhost:5173/' })
    expect((await checkTileFolder(f)).ok).toBe(false)
    expect((await checkTileFolder(f, { dev: true })).ok).toBe(true)
  })

  it('refuses a plugin with more than skills', async () => {
    const ok = await checkTileFolder(folder({ 'plugin/.claude-plugin/plugin.json': '{"name":"demo"}', 'plugin/skills/demo/SKILL.md': SKILL }))
    expect(ok.errors).toEqual([])
    const r = await checkTileFolder(folder({ 'plugin/.claude-plugin/plugin.json': '{"name":"demo"}', 'plugin/skills/demo/SKILL.md': SKILL, 'plugin/hooks/hooks.json': '{}' }))
    expect(r.errors.join()).toMatch(/plugin\/hooks/)
  })

  it('refuses the trusted tier outside the tiles that ship with workshop, however it is asked for', async () => {
    for (const r of [
      await checkTileFolder(folder({}, { permissions: { backend: true } })),
      await checkTileFolder(folder({}, { backend: { entry: 'backend.mjs', ops: ['x'] } })),
      await checkTileFolder(folder({ 'backend.mjs': 'export default {}' }))
    ]) {
      expect(r.ok).toBe(false)
      expect(r.errors[0]).toMatch(/^backend: the trusted tier .* only for tiles that ship with workshop/)
    }
    // Only the backend is wrong with these: the rest of the report is about the rest of the tile.
    expect((await checkTileFolder(folder({}, { permissions: { backend: true, storage: true } }))).errors).toHaveLength(1)
  })

  it('takes a backend from a tile that ships with workshop, if its program is in the folder', async () => {
    const decl = { backend: { entry: 'backend.mjs', ops: ['status'] } }
    const ok = await checkTileFolder(folder({ 'backend.mjs': 'export default () => {}' }, decl), { builtin: true })
    expect(ok.errors).toEqual([])
    expect(ok.manifest?.backend?.ops).toEqual(['status'])
    expect((await checkTileFolder(folder({}, decl), { builtin: true })).errors.join()).toMatch(/backend.entry: backend.mjs does not exist/)
    expect((await checkTileFolder(resolve('test/fixtures/trusted'), { builtin: true })).errors).toEqual([])
    expect((await checkTileFolder(resolve('test/fixtures/trusted'))).errors[0]).toMatch(/trusted tier/)
  })

  it('warns about what install does differently: no symlinks, no submodules', async () => {
    const f = folder({ '.gitmodules': '' })
    symlinkSync('icon.svg', join(f, 'alias.svg'))
    const r = await checkTileFolder(f)
    expect(r.ok).toBe(true)
    expect(r.warnings.join('\n')).toMatch(/submodules/)
    expect(r.warnings.join('\n')).toMatch(/symlinks \(alias\.svg\)/)
  })

  it('warns about a page with no CSP and a manifest with no repo', async () => {
    const r = await checkTileFolder(folder({ 'dist/index.html': '<p>hi</p>' }, { repo: undefined }))
    expect(r.ok).toBe(true)
    expect(r.warnings.join('\n')).toMatch(/Content-Security-Policy/)
    expect(r.warnings.join('\n')).toMatch(/repo: none/)
  })
})
