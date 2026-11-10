// A tile in a local git repo, made at runtime, for the install tests (test/install.test.ts) and
// the smoke run: install, update and remove are driven against it exactly as against a repo on
// GitHub, through a file path instead of an https URL.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGE = (name: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; font-src 'self'"><title>${name}</title></head><body><p id="hello">${name} from a repo</p></body></html>\n`

export const fixtureGit = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=workshop', '-c', 'user.email=workshop@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim()

export interface TileRepo {
  dir: string
  /** Writes tile.json (the base manifest with `manifest` over it) and `files`, commits, returns the commit id. */
  commit: (manifest?: Record<string, unknown>, files?: Record<string, string>) => string
}

export function tileRepo(dir: string, base: Record<string, unknown>): TileRepo {
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, 'init', '--quiet')
  let n = 0
  return {
    dir,
    commit: (manifest = {}, files = {}) => {
      const m: Record<string, unknown> = { version: '0.1.0', workshop: '^1', author: 'smoke', icon: 'icon.svg', entry: 'dist/index.html', ...base, ...manifest }
      const all: Record<string, string> = { 'tile.json': JSON.stringify(m, null, 2), 'dist/index.html': PAGE(String(m.name)), 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>', ...files }
      for (const [p, text] of Object.entries(all)) {
        mkdirSync(join(dir, p, '..'), { recursive: true })
        writeFileSync(join(dir, p), text)
      }
      fixtureGit(dir, 'add', '-A')
      fixtureGit(dir, 'commit', '--quiet', '--allow-empty', '-m', `version ${++n}`)
      return fixtureGit(dir, 'rev-parse', 'HEAD')
    }
  }
}
