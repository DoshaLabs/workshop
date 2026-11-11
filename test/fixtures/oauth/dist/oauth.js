// Starts a sign-in on every real click, with whatever URL the smoke run put in window.next, and
// keeps what came back. The provider is never there: the smoke run plays the browser.
window.results = []
window.next = null
const authorizeUrl = (extra = {}) => {
  const u = new URL('https://auth.example.com/authorize')
  const q = { client_id: 'smoke', response_type: 'code', redirect_uri: workshop.oauth.redirectUri, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', state: 'the-tiles-own', ...extra }
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  return u.toString()
}
window.authorizeUrl = authorizeUrl
document.addEventListener('mousedown', () => {
  const url = window.next ?? authorizeUrl()
  window.next = null
  workshop.oauth.authorize(url).then(
    (r) => window.results.push({ ok: true, query: r.query }),
    (e) => window.results.push({ ok: false, error: e.message })
  )
})
window.oauthReady = true
