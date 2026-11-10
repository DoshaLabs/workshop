import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { hasFiles } from './drop'

// A file dropped where nothing takes it must not navigate the window to the file (drop.ts says
// where drops do land). Only file drags: text dragged into a field still drops as text.
for (const type of ['dragover', 'drop'] as const)
  window.addEventListener(type, (e) => {
    if (hasFiles(e.dataTransfer)) e.preventDefault()
  })

// A press in a conversation: until the button comes up, it is the only conversation that can be
// selected (styles.css, `.ws-selecting`), so a drag that starts in one session tile cannot run its
// selection on into the tiles below it.
window.addEventListener(
  'mousedown',
  (e) => {
    const chat = e.button === 0 && e.target instanceof Element ? e.target.closest('.chat') : null
    if (!(chat instanceof HTMLElement)) return
    chat.dataset.selecting = ''
    document.documentElement.classList.add('ws-selecting')
    const up = (): void => {
      delete chat.dataset.selecting
      document.documentElement.classList.remove('ws-selecting')
      window.removeEventListener('mouseup', up, true)
      window.removeEventListener('blur', up)
    }
    window.addEventListener('mouseup', up, true)
    window.addEventListener('blur', up)
  },
  true
)

// A terminal measures its font once, when it opens: have the mono face in hand before the first
// one is made. A font that will not load must never keep the window from drawing.
void Promise.race([document.fonts.load('13px "JetBrains Mono"'), new Promise((r) => setTimeout(r, 1500))])
  .catch(() => undefined)
  .then(() => createRoot(document.getElementById('root')!).render(<App />))
