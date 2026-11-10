// Where core's own files are: tmux.conf, bin/ (the door's and the preview pane's CLIs), tiles/,
// template/, assets/, plugin/ and native/ (the recorder's Swift helper).
//
// From the repo (`npm run dev`, `npm run smoke`) they sit beside package.json, which is
// app.getAppPath(). In the packaged app that path is inside app.asar, which only Electron's own
// fs can read: tmux, `node`, swiftc and the CLI's `--plugin-dir` cannot. So electron-builder
// copies them out to Contents/Resources (package.json `build.extraResources`), and that is
// process.resourcesPath.
//
// No electron import: main/index.ts passes the three facts in, and the tests call it directly.

import { join } from 'node:path'

export interface ResourceWhere {
  /** app.isPackaged */
  packaged: boolean
  /** process.resourcesPath: Contents/Resources in the packaged app. */
  resourcesPath: string
  /** app.getAppPath(): the repo under `npm run dev`, …/app.asar packaged. */
  appPath: string
}

/** The folder core's own files are in. */
export function resourceRoot(w: ResourceWhere): string {
  return w.packaged ? w.resourcesPath : w.appPath
}

/** One of core's own files or folders, e.g. `resourcePath(w, 'bin', 'workshop-tile.mjs')`. */
export function resourcePath(w: ResourceWhere, ...parts: string[]): string {
  return join(resourceRoot(w), ...parts)
}
