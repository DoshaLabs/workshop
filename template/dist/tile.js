// __NAME__: a workshop tile. Everything it can do goes through `window.workshop` (CLAUDE.md in
// this folder lists it all). This starter keeps one number in storage, to show the loop works:
// save this file and the tile in workshop's right-hand column reloads.

const ws = window.workshop
const body = document.getElementById('body')

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v)
  }
  // A condition leaves null or false behind; the DOM would draw them as words.
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k)
  return e
}

let count = Number(await ws.storage.get('count')) || 0

function render() {
  body.replaceChildren(
    el('p', {}, '__NAME__ is running.'),
    el('p', { class: 'muted' }, 'This is the starter. Ask Claude to make it yours.'),
    el(
      'button',
      {
        onclick: async () => {
          count += 1
          await ws.storage.set('count', count)
          render()
        }
      },
      `Clicked ${count} times`
    )
  )
}
render()
