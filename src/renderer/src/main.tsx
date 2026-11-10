import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// A terminal measures its font once, when it opens: have the mono face in hand before the first
// one is made. A font that will not load must never keep the window from drawing.
void Promise.race([document.fonts.load('13px "JetBrains Mono"'), new Promise((r) => setTimeout(r, 1500))])
  .catch(() => undefined)
  .then(() => createRoot(document.getElementById('root')!).render(<App />))
