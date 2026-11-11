import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkManifest, hostAllowed, requestAllowed, type Manifest } from '@shared/manifest'

const base = { id: 'reminders', name: 'Reminders', version: '1.2.0', workshop: '^1', author: 'someone', entry: 'dist/index.html' }
const errs = (raw: unknown): string[] => {
  const r = checkManifest(raw)
  return r.ok ? [] : r.errors
}

describe('checkManifest', () => {
  it('accepts the example from CLAUDE.md §5', () => {
    const r = checkManifest({
      ...base,
      repo: 'https://github.com/someone/workshop-reminders',
      hint: 'To-dos, notes and a log, by project',
      icon: 'icon.svg',
      pane: true,
      multiple: false,
      span: 1,
      permissions: { storage: true, sessions: 'read', door: { ops: ['add', 'note', 'log', 'list', 'done'], timeoutMs: 10000 }, notify: true }
    })
    expect(r.ok).toBe(true)
  })

  it('accepts the shipped tiles', () => {
    for (const f of ['tiles/wikipedia/tile.json', 'test/fixtures/probe/tile.json']) expect(errs(JSON.parse(readFileSync(f, 'utf8')))).toEqual([])
    const trusted = checkManifest(JSON.parse(readFileSync('test/fixtures/trusted/tile.json', 'utf8')), { builtin: true })
    expect(trusted.ok ? [] : trusted.errors).toEqual([])
  })

  it('fills defaults', () => {
    const r = checkManifest(base)
    expect(r.ok && r.manifest).toMatchObject({ pane: false, multiple: false, span: 1, permissions: {} })
  })

  it('refuses unknown permissions rather than ignoring them', () => {
    expect(errs({ ...base, permissions: { storgae: true } })[0]).toMatch(/storgae/)
  })

  it('takes overlay as a permission: true or false, never a typo of it', () => {
    const r = checkManifest({ ...base, permissions: { overlay: true } })
    expect(r.ok && r.manifest.permissions.overlay).toBe(true)
    const off = checkManifest({ ...base, permissions: { overlay: false } })
    expect(off.ok && off.manifest.permissions.overlay).toBeUndefined()
    expect(errs({ ...base, permissions: { overlay: 'yes' } })[0]).toMatch(/permissions.overlay: must be true or false/)
    expect(errs({ ...base, permissions: { overlays: true } })[0]).toMatch(/overlays: not a permission/)
  })

  it('says which bridge an overlay tile needs', () => {
    expect(checkManifest({ ...base, workshop: '^1.1', permissions: { overlay: true } }).ok).toBe(true)
    expect(checkManifest({ ...base, workshop: '^1.2' }).ok).toBe(true)
    expect(errs({ ...base, workshop: '^1.6' })[0]).toMatch(/does not accept/)
  })

  it('takes transcripts (bridge 1.5) only with sessions, and only from a tile built for 1.5', () => {
    const r = checkManifest({ ...base, workshop: '^1.5', permissions: { sessions: 'read', transcripts: true } })
    expect(r.ok && r.manifest.permissions.transcripts).toBe(true)
    expect(errs({ ...base, workshop: '^1', permissions: { sessions: 'read', transcripts: true } })[0]).toMatch(/transcripts is bridge 1.5; set "workshop" to "\^1.5"/)
    expect(errs({ ...base, workshop: '^1.5', permissions: { transcripts: true } })[0]).toMatch(/also ask for "sessions"/)
    const off = checkManifest({ ...base, permissions: { transcripts: false } })
    expect(off.ok && off.manifest.permissions.transcripts).toBeUndefined()
  })

  it('takes music as a permission (bridge 1.3): true or false, never a typo of it', () => {
    const r = checkManifest({ ...base, workshop: '^1.3', permissions: { music: true } })
    expect(r.ok && r.manifest.permissions.music).toBe(true)
    const off = checkManifest({ ...base, permissions: { music: false } })
    expect(off.ok && off.manifest.permissions.music).toBeUndefined()
    expect(errs({ ...base, permissions: { music: 'spotify' } })[0]).toMatch(/permissions.music: must be true or false/)
    expect(errs({ ...base, permissions: { spotify: true } })[0]).toMatch(/spotify: not a permission/)
  })

  it('refuses the trusted tier for any tile not built in, however it is asked for', () => {
    expect(errs({ ...base, permissions: { backend: true } })[0]).toMatch(/^permissions.backend: the trusted tier .* only for tiles that ship with workshop/)
    expect(errs({ ...base, backend: { entry: 'backend.mjs', ops: ['status'] } })[0]).toMatch(/^backend: the trusted tier .* only for tiles that ship with workshop/)
    expect(checkManifest({ ...base, backend: { entry: 'backend.mjs', ops: ['status'] } }, { dev: true }).ok).toBe(false)
  })

  it('takes a built-in tile\'s backend: an .mjs in the folder, ops as the door\'s, a timeout', () => {
    const built = (backend: unknown): string[] => {
      const r = checkManifest({ ...base, backend }, { builtin: true })
      return r.ok ? [] : r.errors
    }
    const r = checkManifest({ ...base, backend: { entry: 'backend.mjs', ops: ['status', 'diff'] } }, { builtin: true })
    expect(r.ok && r.manifest.backend).toEqual({ entry: 'backend.mjs', ops: ['status', 'diff'], timeoutMs: 10_000 })
    // Shown and compared like a permission, though a tile cannot write it as one.
    expect(r.ok && r.manifest.permissions.backend).toBe(true)
    expect(checkManifest(base, { builtin: true }).ok && (checkManifest(base, { builtin: true }) as { manifest: Manifest }).manifest.backend).toBeUndefined()
    expect(built({ entry: 'b.mjs', ops: ['x'], timeoutMs: 60_000 })).toEqual([])
    expect(built({ entry: 'b.js', ops: ['x'] })[0]).toMatch(/backend.entry: must be an .mjs/)
    expect(built({ entry: '../b.mjs', ops: ['x'] })[0]).toMatch(/backend.entry/)
    expect(built({ entry: '/b.mjs', ops: ['x'] })[0]).toMatch(/backend.entry/)
    expect(built({ entry: 'b.mjs', ops: [] })[0]).toMatch(/^backend: /)
    expect(built({ entry: 'b.mjs', ops: ['Status'] })[0]).toMatch(/backend.ops: each op/)
    expect(built({ entry: 'b.mjs', ops: ['a', 'a'] })[0]).toMatch(/backend.ops: listed twice/)
    expect(built({ entry: 'b.mjs', ops: ['a'], timeoutMs: 50 })[0]).toMatch(/backend.timeoutMs/)
    expect(built({ entry: 'b.mjs', ops: ['a'], background: true })[0]).toMatch(/backend.background: not known/)
    expect(built(true)[0]).toMatch(/^backend: /)
    expect(checkManifest({ ...base, permissions: { backend: true } }, { builtin: true }).ok).toBe(false)
  })

  it('refuses a bridge range this core does not satisfy', () => {
    expect(errs({ ...base, workshop: '^2' })[0]).toMatch(/does not accept/)
    expect(errs({ ...base, workshop: 'banana' })[0]).toMatch(/semver range/)
  })

  it.each(['../x.html', '/abs/index.html', 'dist\\index.html', 'dist//index.html', './index.html', 'file:index.html', 'index.js'])('refuses entry %s', (entry) => {
    expect(errs({ ...base, entry }).length).toBeGreaterThan(0)
  })

  it.each(['A-b', '-x', 'x-', 'has space', 'a'.repeat(41), ''])('refuses id %j', (id) => {
    expect(errs({ ...base, id }).length).toBeGreaterThan(0)
  })

  it.each([['*'], ['https://x.com'], ['x.com:443'], ['127.0.0.1'], ['localhost'], ['X.COM'], ['x.com/path'], ['*.*.x.com']])('refuses net %j', (...net) => {
    expect(errs({ ...base, permissions: { net } }).length).toBeGreaterThan(0)
  })

  it('checks door ops and timeouts', () => {
    expect(errs({ ...base, permissions: { door: { ops: [] } } }).length).toBe(1)
    expect(errs({ ...base, permissions: { door: { ops: ['Add'] } } }).length).toBe(1)
    expect(errs({ ...base, permissions: { door: { ops: ['a', 'a'] } } }).length).toBe(1)
    expect(errs({ ...base, permissions: { door: { ops: ['a'], timeoutMs: 999999 } } }).length).toBe(1)
    const r = checkManifest({ ...base, permissions: { door: { ops: ['a'] } } })
    expect(r.ok && r.manifest.permissions.door?.timeoutMs).toBe(10000)
  })

  it('refuses non-objects', () => {
    expect(checkManifest(null).ok).toBe(false)
    expect(checkManifest([]).ok).toBe(false)
  })
})

describe('hostAllowed', () => {
  it('matches exact hosts and subdomain wildcards only', () => {
    expect(hostAllowed('api.x.com', ['api.x.com'])).toBe(true)
    expect(hostAllowed('API.X.COM.', ['api.x.com'])).toBe(true)
    expect(hostAllowed('evil-api.x.com', ['api.x.com'])).toBe(false)
    expect(hostAllowed('a.x.com', ['*.x.com'])).toBe(true)
    expect(hostAllowed('a.b.x.com', ['*.x.com'])).toBe(true)
    expect(hostAllowed('x.com', ['*.x.com'])).toBe(false)
    expect(hostAllowed('evilx.com', ['*.x.com'])).toBe(false)
    expect(hostAllowed('x.com', undefined)).toBe(false)
  })
})

describe('requestAllowed', () => {
  const tile = { manifest: { id: 'wiki', permissions: { net: ['en.wikipedia.org'] } } as unknown as Manifest }
  it.each([
    ['tile://wiki/index.html', true],
    ['tile://other/index.html', false],
    ['https://en.wikipedia.org/api', true],
    ['wss://en.wikipedia.org/x', true],
    ['http://en.wikipedia.org/api', false],
    ['https://en.wikipedia.org.evil.com/', false],
    ['https://example.com/', false],
    ['file:///etc/hosts', false],
    ['http://127.0.0.1:4000/tile/x', false],
    ['chrome://gpu', false],
    ['data:text/plain,hi', true],
    ['not a url', false]
  ])('%s → %s', (url, ok) => {
    expect(requestAllowed(tile, url)).toBe(ok)
  })
})

describe('dev server entries', () => {
  it('only for a dev tile, and only on localhost with a port', () => {
    expect(errs({ ...base, entry: 'http://localhost:5173/' })[0]).toMatch(/only for a tile loaded with workshop tile dev/)
    expect(checkManifest({ ...base, entry: 'http://localhost:5173/' }, { dev: true }).ok).toBe(true)
    expect(checkManifest({ ...base, entry: 'http://127.0.0.1:8080/index.html' }, { dev: true }).ok).toBe(true)
    for (const entry of ['https://localhost:5173/', 'http://localhost/', 'http://evil.com:5173/', 'http://localhost:5173.evil.com/'])
      expect(checkManifest({ ...base, entry }, { dev: true }).ok).toBe(false)
  })

  it('lets a dev tile reach its own dev server and nothing else on localhost', () => {
    const tile = { manifest: { id: 'x', permissions: {} } as unknown as Manifest, devOrigin: 'http://localhost:5173' }
    expect(requestAllowed(tile, 'http://localhost:5173/src/main.ts')).toBe(true)
    expect(requestAllowed(tile, 'ws://localhost:5173/')).toBe(true)
    expect(requestAllowed(tile, 'http://localhost:5174/')).toBe(false)
    expect(requestAllowed(tile, 'http://127.0.0.1:5173/')).toBe(false)
    expect(requestAllowed({ ...tile, devOrigin: null }, 'http://localhost:5173/')).toBe(false)
  })
})
