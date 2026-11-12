// Every test run gets one temp folder of its own, removed when the run ends. Tests and the code
// they drive make folders with mkdtemp(tmpdir()) and few remove them; left in the user's $TMPDIR
// they piled up (15,000 folders, 8 GB, in two months) and slowed everything that walks it. os.tmpdir()
// reads TMPDIR at each call and the workers and child processes inherit it, so pointing it here
// before they start covers them all without any test having to clean up after itself.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'workshop-test-'))
  process.env.TMPDIR = root
  return () => rmSync(root, { recursive: true, force: true })
}
