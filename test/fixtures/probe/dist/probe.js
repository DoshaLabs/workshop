// The smoke test's tile. It answers two door ops; the escape attempts are run from the smoke
// harness (src/main/smoke.ts) inside this page, so they see exactly what a tile's code would.
workshop.door.handle('echo', (args, caller) => ({ args, caller }))
workshop.door.handle('slow', () => new Promise((r) => setTimeout(() => r('late'), 5000)))
window.probeReady = true
