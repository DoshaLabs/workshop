// The smoke test's trusted tile. Its checks run from the harness (src/main/smoke-backend.ts) inside
// this page, through workshop.backend, as a built-in tile's own page would call it.
window.statuses = []
workshop.backend.onStatus((s) => window.statuses.push(s.state))
window.trustedReady = true
