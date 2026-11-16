// Voice commands (the top bar's Voice button, main/voice.ts, renderer/VoiceButton.tsx). What the
// microphone heard, as whisper.cpp wrote it down, becomes one command here; nothing in this file
// touches the mic, a process or the window, so it is all tested (test/voice.test.ts).
//
// The grammar is plain English with a few ways to say each thing, chosen for how whisper writes
// speech down: capitals and full stops, numbers as words ("session three") or digits ("Session 3."),
// "Pomodoro" or "pomodoro". Anything that is not a command is `unknown`, never sent anywhere.

export type ScrollHow = 'lineUp' | 'lineDown' | 'pageUp' | 'pageDown' | 'top' | 'bottom' | 'responseUp' | 'responseDown'
export type MusicHow = 'toggle' | 'play' | 'pause' | 'next' | 'previous'

export type VoiceCommand =
  | { kind: 'focus'; n: number }
  | { kind: 'focus-name'; name: string }
  | { kind: 'step'; dir: 1 | -1 }
  | { kind: 'scroll'; how: ScrollHow; times: number }
  | { kind: 'key'; key: 'escape' | 'enter' }
  /** `draft`: typed into the prompt but not sent (speech that was not a command); "send it" sends. */
  | { kind: 'prompt'; text: string; n?: number; name?: string; draft?: boolean }
  | { kind: 'new-session' }
  | { kind: 'record' }
  | { kind: 'stop-listening' }
  | { kind: 'music'; how: MusicHow }
  | { kind: 'music-volume'; by?: number; to?: number }
  | { kind: 'music-search'; query: string }
  | { kind: 'reminder'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'log'; text: string }
  | { kind: 'pomodoro'; op: 'start' | 'pause' | 'skip' | 'extend' | 'status'; text?: string; minutes?: number }
  | { kind: 'unknown'; text: string }

/** What whisper writes for silence, a cough or music: never a command. */
const NOISE = /^\s*(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)\s*$/
const FILLER = new Set(['', 'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'bye', 'okay', 'ok', 'um', 'uh', 'hmm', 'so'])

/** Whisper's text with its punctuation, capitals and bracketed noise taken out. Empty if nothing was said. */
export function cleanHeard(raw: string): string {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l))
  const t = lines
    .join(' ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return FILLER.has(norm(t)) ? '' : t
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, a: 1, an: 1
}

/** A number said as digits or a word ("3", "three", "third"); NaN if it is not one. */
export function numberOf(word: string): number {
  const w = word.toLowerCase()
  if (/^\d+(?:st|nd|rd|th)?$/.test(w)) return parseInt(w, 10)
  return w in WORD_NUMBERS ? WORD_NUMBERS[w] : NaN
}

/** Lower case, no punctuation but apostrophes, single spaces. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”"]/g, '')
    .replace(/[^\p{L}\p{N}'%\s-]/gu, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The text a command carries (a reminder, a prompt): what was said, its own capitals kept, the end's full stop dropped. */
function rest(original: string, said: string, from: number): string {
  // `said` is norm(original); find the same words in the original by counting words.
  const skip = said.slice(0, from).trim().split(' ').filter(Boolean).length
  const words = original.trim().split(/\s+/)
  const out = words.slice(skip).join(' ').replace(/^[,:;.\s]+/, '').replace(/[.。]+$/, '').trim()
  return out ? out[0].toUpperCase() + out.slice(1) : out
}

const N = '(\\d+|[a-z]+)'

/** One utterance → one command. `heard` is whisper's text, cleaned or not. */
export function parseVoice(heard: string): VoiceCommand {
  const original = cleanHeard(heard)
    .replace(/^(?:hey |ok |okay )?workshop[,.]?\s+/i, '')
    .replace(/^(?:please|can you|could you)[,]?\s+/i, '')
    .replace(/[,]?\s+please[.!?]*$/i, '')
  const s = norm(original)
  if (!s) return { kind: 'unknown', text: '' }
  let m: RegExpExecArray | null

  // ---- listening itself
  if (/^(?:stop|quit|end) (?:listening|voice)$|^(?:go to sleep|that's all|mic off|microphone off)$/.test(s)) return { kind: 'stop-listening' }

  // ---- sessions by their ID: a session is named <folder>-<ID> ("slay-10", "builditbox-b2"), and
  // the ID is what is called out: "session b2", "switch to six d", "slay ten". The window matches
  // what was said against the open sessions (matchSession); a plain number that is no session's ID
  // falls back to the ⌘ number there.
  if (/^(?:(?:go to|switch to|jump to) )?(?:the )?next session$/.test(s)) return { kind: 'step', dir: 1 }
  if (/^(?:(?:go to|switch to|jump to|go back to) )?(?:the )?(?:previous|last) session$|^session back$/.test(s)) return { kind: 'step', dir: -1 }
  if (/^(?:new|start a|open a|start a new|open a new) session$|^new chat$/.test(s)) return { kind: 'new-session' }

  // ---- talking to a session: "tell b2 to run the tests", "ask session slay ten to…", "type yes"
  m = /^(?:tell|ask) (?:session )?(.+?) to (.+)$/.exec(s)
  if (m && m[1] !== 'me' && m[1] !== 'it' && m[1].split(' ').length <= 4) return { kind: 'prompt', name: m[1], text: rest(original, s, s.length - m[2].length) }
  m = /^(?:type|send|say|prompt|dictate)(?: this)?[: ]+(.+)$/.exec(s)
  if (m) return { kind: 'prompt', text: rest(original, s, s.indexOf(m[1], s.indexOf(' '))) }

  m = /^(?:(?:switch|go|jump|change|move|focus|open|show)(?: me)?(?: (?:to|on))? )?(?:the )?session (?:number |id |i d )?(.+)$/.exec(s)
  if (m) return { kind: 'focus-name', name: m[1] }
  m = /^(?:(?:switch|go|jump|change|move)(?: to)? )?(?:the )?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth) session$/.exec(s)
  if (m) return { kind: 'focus', n: numberOf(m[1]) }

  // ---- the focused terminal
  const times = (w: string | undefined): number => {
    const n = w ? numberOf(w) : 1
    return isNaN(n) || n < 1 ? 1 : Math.min(n, 20)
  }
  m = new RegExp(`^(?:scroll |go |jump |move )?(up|down|back|forward)(?: by)?(?: ${N})? (?:response|responses|message|messages|reply|replies|answer|answers|turn|turns)$`).exec(s)
  if (m) return { kind: 'scroll', how: m[1] === 'up' || m[1] === 'back' ? 'responseUp' : 'responseDown', times: times(m[2]) }
  m = new RegExp(`^(?:scroll |go )?(?:to )?(?:the )?(previous|last|next) (?:response|message|reply|answer|turn)$`).exec(s)
  if (m) return { kind: 'scroll', how: m[1] === 'next' ? 'responseDown' : 'responseUp', times: 1 }
  m = new RegExp(`^(?:scroll )?page (up|down)(?: ${N}(?: times)?)?$`).exec(s)
  if (m) return { kind: 'scroll', how: m[1] === 'up' ? 'pageUp' : 'pageDown', times: times(m[2]) }
  m = new RegExp(`^(?:scroll |go )?(up|down) (?:a |one |${N} )?(?:page|pages|screen|screens)$`).exec(s)
  if (m) return { kind: 'scroll', how: m[1] === 'up' ? 'pageUp' : 'pageDown', times: times(m[2]) }
  m = new RegExp(`^scroll (up|down)(?: ${N})?(?: lines?)?$`).exec(s)
  if (m) return { kind: 'scroll', how: m[1] === 'up' ? 'lineUp' : 'lineDown', times: m[2] ? times(m[2]) : 5 }
  if (/^(?:scroll |go |jump |take me )?(?:to )?(?:the )?(?:top|beginning|start of (?:the )?(?:conversation|chat))$/.test(s)) return { kind: 'scroll', how: 'top', times: 1 }
  if (/^(?:scroll |go |jump |take me )?(?:to )?(?:the )?(?:bottom|end|latest|newest)$|^jump to bottom$|^back to (?:the )?(?:bottom|latest)$/.test(s)) return { kind: 'scroll', how: 'bottom', times: 1 }
  if (/^(?:escape|interrupt|cancel that|stop that|stop it|stop claude|press escape)$/.test(s)) return { kind: 'key', key: 'escape' }
  if (/^(?:press )?(?:enter|return|submit|send it)$/.test(s)) return { kind: 'key', key: 'enter' }

  // ---- the recorder
  if (/^(?:start |stop )?record(?:ing)?$|^(?:open|close) the recorder$|^screen record$/.test(s)) return { kind: 'record' }

  // ---- pomodoro (before music: "pause the timer" is not "pause")
  const POMO = '(?:pomodoro|pomodoros|tomato|focus block|focus session|focus timer|timer|focus)'
  m = new RegExp(`^(?:start|begin|kick off|set)(?: a| the| my| another)? ${POMO}(?: (?:on|for) (.+))?$`).exec(s)
  if (m) {
    const at = m[1] ? s.lastIndexOf(m[1]) : -1
    return m[1] ? { kind: 'pomodoro', op: 'start', text: rest(original, s, at) } : { kind: 'pomodoro', op: 'start' }
  }
  m = new RegExp(`^(?:pause|stop)(?: the| my)? ${POMO}$`).exec(s)
  if (m) return { kind: 'pomodoro', op: 'pause' }
  m = new RegExp(`^(?:resume|continue|unpause)(?: the| my)? ${POMO}$`).exec(s)
  if (m) return { kind: 'pomodoro', op: 'start' }
  if (/^skip(?: the| my)? (?:break|pomodoro|timer|focus block|phase)$/.test(s)) return { kind: 'pomodoro', op: 'skip' }
  m = new RegExp(`^(?:extend(?: the| my)? (?:timer|pomodoro|focus|break)|(?:give me|add) ${N} more minutes?|(?:give me|add) more time)(?: by ${N} minutes?)?$`).exec(s)
  if (m) {
    const n = numberOf(m[1] ?? m[2] ?? '')
    return isNaN(n) ? { kind: 'pomodoro', op: 'extend' } : { kind: 'pomodoro', op: 'extend', minutes: Math.min(60, Math.max(1, n)) }
  }
  if (/^(?:how (?:long|much time) is left|how much (?:time )?(?:is )?left|time left|pomodoro status|timer status)$/.test(s)) return { kind: 'pomodoro', op: 'status' }

  // ---- reminders: "remind me to …", "take a note …", "log …"
  m = /^(?:remind me (?:to |that |about )?|add (?:a )?reminder(?: to)?(?: that)? |reminder |add (?:a )?to ?do |to ?do |don't let me forget (?:to )?)(.+)$/.exec(s)
  if (m) return { kind: 'reminder', text: rest(original, s, s.length - m[1].length) }
  m = /^(?:take a note|make a note|note|write down|jot down|add a note)(?: that| of| about)?[: ]+(.+)$/.exec(s)
  if (m) return { kind: 'note', text: rest(original, s, s.length - m[1].length) }
  m = /^(?:log|log that|i (?:just )?(?:finished|shipped|did))[: ]+(.+)$/.exec(s)
  if (m) return { kind: 'log', text: rest(original, s, s.length - m[1].length) }

  // ---- music
  if (/^(?:pause|stop)(?: the)?(?: music| song| spotify| playback)?$|^(?:music|spotify) (?:pause|stop|off)$|^(?:mute|silence)$/.test(s)) return { kind: 'music', how: 'pause' }
  if (/^(?:resume|unpause|continue|play)(?: the)?(?: music| song| spotify| playback)?$|^(?:music|spotify) (?:on|play|resume)$|^put (?:on )?(?:some |a |the )?(?:music|song|tune|tunes|spotify)(?: on)?$/.test(s))
    return { kind: 'music', how: 'play' }
  if (/^(?:next|skip)(?: the| this)?(?: song| track| tune)?$|^skip(?: it)?$/.test(s)) return { kind: 'music', how: 'next' }
  if (/^(?:previous|last|go back a|back a)(?: song| track| tune)$|^play (?:the )?previous (?:song|track)$/.test(s)) return { kind: 'music', how: 'previous' }
  m = new RegExp(`^(?:turn |set )?(?:the )?volume (up|down)(?: by ${N})?$|^turn (?:it|the music) (up|down)$|^(louder|quieter|softer)$`).exec(s)
  if (m) {
    const dir = m[1] ?? m[3] ?? m[4]
    const by = m[2] ? numberOf(m[2]) : 15
    return { kind: 'music-volume', by: (dir === 'up' || dir === 'louder' ? 1 : -1) * (isNaN(by) ? 15 : by) }
  }
  m = new RegExp(`^(?:set )?(?:the )?volume (?:to )?${N}(?: percent|%)?$`).exec(s)
  if (m && !isNaN(numberOf(m[1]))) return { kind: 'music-volume', to: Math.max(0, Math.min(100, numberOf(m[1]))) }
  m = /^(?:play|put on|queue up|start playing|put)(?: me)?(?: some)? (.+?)(?: on| in)?(?: on spotify| in spotify| on)?$/.exec(s)
  if (m) {
    let q = rest(original, s, s.indexOf(m[1]))
    q = q.replace(/\s+(?:on|in) spotify\.?$/i, '').replace(/\s+on$/i, '').trim()
    if (q) return { kind: 'music-search', query: q }
  }

  // ---- "switch to workshop", "go to the slay session": a session by name (last: it takes anything)
  m = /^(?:switch|go|jump|change|move) (?:to|over to) (?:the )?(.+?)(?: session)?$/.exec(s)
  if (m) return { kind: 'focus-name', name: m[1] }

  return { kind: 'unknown', text: original }
}

/** A short line saying what a command does, for the button's tooltip and the toast. */
export function describeVoice(c: VoiceCommand): string {
  switch (c.kind) {
    case 'focus': return `Session ${c.n}`
    case 'focus-name': return `Session “${c.name}”`
    case 'step': return c.dir > 0 ? 'Next session' : 'Previous session'
    case 'scroll': {
      const what: Record<ScrollHow, string> = { lineUp: 'Scroll up', lineDown: 'Scroll down', pageUp: 'Page up', pageDown: 'Page down', top: 'To the top', bottom: 'To the bottom', responseUp: 'Up a response', responseDown: 'Down a response' }
      return c.times > 1 && !['top', 'bottom'].includes(c.how) ? `${what[c.how]} ×${c.times}` : what[c.how]
    }
    case 'key': return c.key === 'escape' ? 'Esc' : 'Enter'
    case 'prompt': return `${c.draft ? 'Typed (say “send it”)' : c.n ? `To session ${c.n}` : c.name ? `To “${c.name}”` : 'Typed'}: ${c.text}`
    case 'new-session': return 'New session'
    case 'record': return 'Recorder'
    case 'stop-listening': return 'Stopped listening'
    case 'music': return { toggle: 'Play / pause', play: 'Play', pause: 'Pause', next: 'Next track', previous: 'Previous track' }[c.how]
    case 'music-volume': return c.to !== undefined ? `Volume ${c.to}` : `Volume ${c.by! > 0 ? '+' : ''}${c.by}`
    case 'music-search': return `Play “${c.query}”`
    case 'reminder': return `Reminder: ${c.text}`
    case 'note': return `Note: ${c.text}`
    case 'log': return `Logged: ${c.text}`
    case 'pomodoro': return c.op === 'start' ? `Pomodoro${c.text ? `: ${c.text}` : ''}` : c.op === 'extend' ? `Pomodoro +${c.minutes ?? 5} min` : `Pomodoro ${c.op}`
    case 'unknown': return c.text ? `Didn't catch a command: “${c.text}”` : 'Nothing heard'
  }
}

/** A session's ID: the two letters or digits its name ends with ("slay-10" → "10", "builditbox-b2" → "b2"). */
export function sessionTag(name: string): string | null {
  const m = /[-_ ]([0-9a-z]{2})$/i.exec(name.trim())
  return m ? m[1].toLowerCase() : null
}

const LETTER_WORDS: Record<string, string> = {
  ay: 'a', eh: 'a', bee: 'b', be: 'b', see: 'c', sea: 'c', cee: 'c', si: 'c', dee: 'd', de: 'd', ee: 'e', eff: 'f', ef: 'f'
}
const UNITS: Record<string, number> = { zero: 0, oh: 0, o: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9 }
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 }
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/**
 * What was said, as the characters it spells: number words as digits ("eighty three" → "83",
 * "oh three" → "03", "ten" → "10"), letter names as letters ("bee two" → "b2", "six dee" → "6d"),
 * other words kept, all run together. "slay ten" → "slay10", the way its name squashes.
 */
export function spelled(said: string): string {
  const words = norm(said).split(' ').filter(Boolean)
  let out = ''
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w in TENS) {
      const next = words[i + 1]
      if (next && next in UNITS && UNITS[next] > 0) {
        out += String(TENS[w] + UNITS[next])
        i++
      } else out += String(TENS[w])
    } else if (w in TEENS) out += String(TEENS[w])
    else if (w in UNITS) out += String(UNITS[w])
    // Whisper hears "oh three" as "all three".
    else if (w === 'all' && words[i + 1] in UNITS) out += '0'
    else if (w in LETTER_WORDS && (words.length <= 3 || i > 0)) out += LETTER_WORDS[w]
    else out += w.replace(/[\s_.'-]/g, '')
  }
  return out
}

/**
 * The session whose ID (or whole name) is exactly what was said, or null: "b2", "six d",
 * "slay ten", "builditbox b2". A one-digit "3" also finds "03". Safe for a sentence said on its
 * own, with no "session" before it: nothing partial counts.
 */
export function sessionById<T extends { name: string }>(said: string, sessions: T[]): T | null {
  const sp = spelled(norm(said).replace(/\b(?:the|session)\b/g, ' '))
  if (!sp) return null
  const squash = (x: string): string => norm(x).replace(/[\s_.'-]/g, '')
  const hits = sessions.filter((s) => {
    const tag = sessionTag(s.name)
    return squash(s.name) === sp || (tag !== null && (tag === sp || (sp.length === 1 && tag === `0${sp}`)))
  })
  return hits.length === 1 ? hits[0] : null
}

/**
 * The open session that was meant, or null. Its ID first ("b2", "six d", "slay ten" all reach
 * "slay-10" / "builditbox-b2" by ID or by name and ID), then its whole name, its folder, and last
 * Claude's title for it. Words like "the" and "session" are ignored.
 */
export function matchSession<T extends { id: string; name: string; cwd?: string; title?: string | null }>(said: string, sessions: T[]): T | null {
  const want = norm(said).replace(/\b(?:the|session|project|folder|one)\b/g, ' ').replace(/\s+/g, ' ').trim()
  if (!want) return null
  // 1. The ID alone, or the name with its ID ("slay ten").
  const byTag = sessionById(want, sessions)
  if (byTag) return byTag
  // 2. A name, folder or title, closest first.
  const squash = (x: string): string => norm(x).replace(/[\s_.'-]/g, '')
  const w = squash(want)
  let best: { s: T; score: number } | null = null
  let tie = false
  for (const s of sessions) {
    const tag = sessionTag(s.name)
    const bare = tag ? s.name.trim().slice(0, -3) : ''
    const names = [s.name, bare, s.cwd?.split('/').filter(Boolean).pop() ?? '', s.title ?? ''].filter(Boolean)
    let mine = 0
    for (const n of names) {
      const h = squash(n)
      mine = Math.max(mine, h === w ? 3 : w.length >= 3 && (h.startsWith(w) || w.startsWith(h)) ? 2 : h.includes(w) && w.length >= 4 ? 1 : 0)
    }
    if (mine > (best?.score ?? 0)) {
      best = { s, score: mine }
      tie = false
    } else if (mine > 0 && mine === best?.score && best.s !== s) tie = true
  }
  // Two sessions in one folder ("slay-10", "slay-4f") and only "slay" said: ask for the ID instead of guessing.
  return best && !tie ? best.s : null
}

/**
 * What to write to a session's terminal for a scroll. Claude Code's fullscreen renderer (the one
 * workshop's sessions run under the user's own settings) binds PageUp / PageDown, ctrl+Home /
 * ctrl+End and the wheel in its Scroll context; tmux passes keys and SGR wheel reports through to
 * it. `col` and `row` are where the wheel "is" (1-based, the terminal's middle).
 */
export function scrollBytes(how: Exclude<ScrollHow, 'responseUp' | 'responseDown'>, col: number, row: number): string {
  switch (how) {
    case 'pageUp': return '\x1b[5~'
    case 'pageDown': return '\x1b[6~'
    case 'top': return '\x1b[1;5H'
    case 'bottom': return '\x1b[1;5F'
    case 'lineUp': return `\x1b[<64;${col};${row}M`
    case 'lineDown': return `\x1b[<65;${col};${row}M`
  }
}

/**
 * Where a response starts on screen: a line whose first mark is Claude Code's ⏺ (a reply or a tool
 * call) or its prompt mark (❯ or >) followed by text: what you typed. Row numbers, top first.
 */
export function responseRows(lines: string[]): number[] {
  const out: number[] = []
  lines.forEach((l, i) => {
    if (/^\s{0,2}(?:⏺|●)\s+\S/.test(l) || /^\s{0,2}(?:❯|>)\s+\S/.test(l)) out.push(i)
  })
  return out
}

// ---------------------------------------------------------------- audio

/** 16-bit mono PCM WAV, what whisper.cpp reads. `samples` are -1..1 at `rate`. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const n = samples.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true)
  }
  return new Uint8Array(buf)
}

/** Resample `input` (at `from` Hz) to `to` Hz, linear: plenty for speech going to whisper. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio
    const a = Math.floor(x)
    const b = Math.min(a + 1, input.length - 1)
    out[i] = input[a] + (input[b] - input[a]) * (x - a)
  }
  return out
}

/**
 * The utterance cutter: fed one level reading (RMS) per audio block, says when speech starts and
 * when it has ended (a run of quiet after speech). The threshold follows the room's noise floor.
 */
export class Utterances {
  private floor = 0.01
  private speaking = false
  private quietMs = 0
  private spokenMs = 0
  constructor(
    private readonly o: { endQuietMs: number; minSpeechMs: number; maxMs: number } = { endQuietMs: 700, minSpeechMs: 250, maxMs: 15_000 }
  ) {}

  /** One block of `ms` at level `rms`. 'start': begin keeping audio; 'end': the utterance is done; 'drop': it was a click, not speech. */
  feed(rms: number, ms: number): 'start' | 'end' | 'drop' | null {
    const threshold = Math.max(0.015, this.floor * 3)
    const loud = rms > threshold
    if (!this.speaking) {
      // The floor creeps toward quiet readings only, so speech never raises it.
      this.floor = this.floor * 0.95 + Math.min(rms, threshold) * 0.05
      if (!loud) return null
      this.speaking = true
      this.quietMs = 0
      this.spokenMs = ms
      return 'start'
    }
    this.spokenMs += ms
    this.quietMs = loud ? 0 : this.quietMs + ms
    if (this.spokenMs >= this.o.maxMs || this.quietMs >= this.o.endQuietMs) {
      this.speaking = false
      return this.spokenMs - this.quietMs >= this.o.minSpeechMs ? 'end' : 'drop'
    }
    return null
  }

  get active(): boolean {
    return this.speaking
  }

  reset(): void {
    this.speaking = false
    this.quietMs = 0
    this.spokenMs = 0
  }
}
