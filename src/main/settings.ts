// Core's own settings: a small JSON file in the profile, written atomically. Only core's window
// may change them (never a tile).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_THEME_ID, THEMES, type Appearance } from '@shared/themes'
import { cleanColumn, type ColumnState } from '@shared/column'
import { cleanPrefs, type RecPrefs } from '@shared/recorder'

export interface Settings {
  theme: string
  appearance: Appearance
  /** Folders of tiles under development (`workshop tile dev`, or made from the + menu): loaded again at every start. */
  devTiles: string[]
  /** The active sprite pack (a folder under `<profile>/mascots/`), or null for the plain status dot. */
  mascot: string | null
  /** The tile column (off, extra instances, heights). Absent until first saved: the window then migrates its old localStorage once. */
  column?: ColumnState
  /** Where the + menu's Marketplace tab reads the tile index (`tiles.json`): an https URL, or a file on this Mac. Absent: none yet. */
  index?: string
  /** The screen recorder's switches (sound, microphone, safe zones). Absent: the defaults (shared/recorder.ts). */
  recorder?: RecPrefs
}

const DEFAULTS: Settings = { theme: DEFAULT_THEME_ID, appearance: 'system', devTiles: [], mascot: null }

/** Drops anything that is not a known value, so a hand-edited file cannot break the window. */
export function cleanSettings(raw: unknown, base: Settings = DEFAULTS): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    theme: typeof r.theme === 'string' && THEMES.some((t) => t.id === r.theme) ? r.theme : base.theme,
    appearance: r.appearance === 'light' || r.appearance === 'dark' || r.appearance === 'system' ? r.appearance : base.appearance,
    devTiles: Array.isArray(r.devTiles) ? [...new Set(r.devTiles.filter((d): d is string => typeof d === 'string' && d.startsWith('/')))].slice(0, 50) : base.devTiles,
    mascot: r.mascot === null || (typeof r.mascot === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(r.mascot)) ? (r.mascot as string | null) : base.mascot,
    ...column(r.column, base.column),
    ...indexOf(r.index, base.index),
    ...(r.recorder !== undefined || base.recorder ? { recorder: cleanPrefs(r.recorder, base.recorder) } : {})
  }
}

/** The column as saved, or the base's; left out altogether while it has never been saved. */
function column(raw: unknown, base: ColumnState | undefined): { column?: ColumnState } {
  const c = cleanColumn(raw) ?? base
  return c ? { column: c } : {}
}

/** The index's address as saved; '' clears it. */
function indexOf(raw: unknown, base: string | undefined): { index?: string } {
  if (raw === '') return {}
  if (typeof raw === 'string' && raw.length <= 500 && /^(https:\/\/|file:\/\/\/|\/)\S+$/.test(raw)) return { index: raw }
  return base ? { index: base } : {}
}

export class SettingsStore {
  private value: Settings

  constructor(private readonly file: string) {
    try {
      this.value = cleanSettings(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      this.value = { ...DEFAULTS }
    }
  }

  get(): Settings {
    return { ...this.value }
  }

  async patch(p: Partial<Settings>): Promise<Settings> {
    this.value = cleanSettings({ ...this.value, ...p }, this.value)
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(this.value, null, 2))
    await rename(tmp, this.file)
    return this.get()
  }
}
