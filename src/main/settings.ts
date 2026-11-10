// Core's own settings: a small JSON file in the profile, written atomically. Only core's window
// may change them (never a tile).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_THEME_ID, THEMES, type Appearance } from '@shared/themes'

export interface Settings {
  theme: string
  appearance: Appearance
}

const DEFAULTS: Settings = { theme: DEFAULT_THEME_ID, appearance: 'system' }

/** Drops anything that is not a known value, so a hand-edited file cannot break the window. */
export function cleanSettings(raw: unknown, base: Settings = DEFAULTS): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    theme: typeof r.theme === 'string' && THEMES.some((t) => t.id === r.theme) ? r.theme : base.theme,
    appearance: r.appearance === 'light' || r.appearance === 'dark' || r.appearance === 'system' ? r.appearance : base.appearance
  }
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
