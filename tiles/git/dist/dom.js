// Building the page: elements from data, never HTML from text (a diff line, a commit subject and a
// CI log are all text a session or a stranger wrote). Styles go through the CSSOM (`style: {}`),
// which the page's CSP (style-src 'self') allows where a style attribute would be refused.

const SVG = 'http://www.w3.org/2000/svg'

function fill(e, props, kids) {
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue
    if (k === 'class') e.setAttribute('class', v)
    else if (k === 'style') Object.assign(e.style, v)
    else if (k === 'value') e.value = v
    else if (k === 'checked') e.checked = !!v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v === true ? '' : v)
  }
  // A condition leaves null or false behind; the DOM would draw them as words.
  for (const c of kids.flat(Infinity)) if (c != null && c !== false && c !== '') e.append(c)
  return e
}

export const el = (tag, props = {}, ...kids) => fill(document.createElement(tag), props, kids)
export const svg = (tag, props = {}, ...kids) => fill(document.createElementNS(SVG, tag), props, kids)

/** A text node: so a value that happens to be '' or 0 still draws. */
export const txt = (s) => document.createTextNode(String(s))
