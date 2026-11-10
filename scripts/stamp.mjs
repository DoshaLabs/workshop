// `npm run dist`, after the build: writes out/build-info.json, which ships inside the app (it is
// under out/, which electron-builder packs). The installed app compares it with the repo it came
// from (src/main/updates.ts) to know when there is an update to install. Carried from deck.
import { writeFileSync } from 'node:fs'
import { fingerprint } from './lib/fingerprint.mjs'

const repo = process.cwd()
// WORKSHOP_FINGERPRINT: the in-app installer takes it BEFORE the build starts, so an edit made
// while it builds still counts as an update afterwards.
const fp = process.env.WORKSHOP_FINGERPRINT || (await fingerprint(repo))
writeFileSync('out/build-info.json', JSON.stringify({ repo, fingerprint: fp, builtAt: Date.now() }, null, 2) + '\n')
console.log(`stamp: ${fp ?? 'no fingerprint (not a git repo?)'}`)
