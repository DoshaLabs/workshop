// Voice commands (shared/voice.ts): whisper's text → one command, the session a name means, the
// bytes a scroll writes, where responses start on screen, the WAV whisper reads, the utterance cutter.
import { describe, expect, it } from 'vitest'
import { Utterances, cleanHeard, encodeWav, matchSession, sessionById, sessionTag, parseVoice, resample, responseRows, scrollBytes } from '@shared/voice'

describe('parseVoice', () => {
  const cases: [string, unknown][] = [
    ['Session B2.', { kind: 'focus-name', name: 'b2' }],
    ['Switch to session six D.', { kind: 'focus-name', name: 'six d' }],
    ['Go to session number 10', { kind: 'focus-name', name: '10' }],
    ['the second session', { kind: 'focus', n: 2 }],
    ['Workshop, session slay ten.', { kind: 'focus-name', name: 'slay ten' }],
    ['Next session.', { kind: 'step', dir: 1 }],
    ['Previous session', { kind: 'step', dir: -1 }],
    ['New session.', { kind: 'new-session' }],
    ['Scroll up one response.', { kind: 'scroll', how: 'responseUp', times: 1 }],
    ['Up two responses', { kind: 'scroll', how: 'responseUp', times: 2 }],
    ['Down a message.', { kind: 'scroll', how: 'responseDown', times: 1 }],
    ['Previous response', { kind: 'scroll', how: 'responseUp', times: 1 }],
    ['Page up.', { kind: 'scroll', how: 'pageUp', times: 1 }],
    ['Page down three times', { kind: 'scroll', how: 'pageDown', times: 3 }],
    ['Scroll up.', { kind: 'scroll', how: 'lineUp', times: 5 }],
    ['Scroll down 10 lines', { kind: 'scroll', how: 'lineDown', times: 10 }],
    ['Go to the top.', { kind: 'scroll', how: 'top', times: 1 }],
    ['Jump to bottom', { kind: 'scroll', how: 'bottom', times: 1 }],
    ['Back to the latest.', { kind: 'scroll', how: 'bottom', times: 1 }],
    ['Interrupt.', { kind: 'key', key: 'escape' }],
    ['Press enter', { kind: 'key', key: 'enter' }],
    ['Over.', { kind: 'key', key: 'enter' }],
    ['Over and out.', { kind: 'key', key: 'enter' }],
    ['Turn it over to the tests', { kind: 'unknown', text: 'Turn it over to the tests' }],
    ['Start recording.', { kind: 'record' }],
    ['Stop listening.', { kind: 'stop-listening' }],
    ['Pause the music.', { kind: 'music', how: 'pause' }],
    ['Pause.', { kind: 'music', how: 'pause' }],
    ['Play.', { kind: 'music', how: 'play' }],
    ['Put a song on.', { kind: 'music', how: 'play' }],
    ['Next song.', { kind: 'music', how: 'next' }],
    ['Skip.', { kind: 'music', how: 'next' }],
    ['Previous track', { kind: 'music', how: 'previous' }],
    ['Volume up.', { kind: 'music-volume', by: 15 }],
    ['Turn it down', { kind: 'music-volume', by: -15 }],
    ['Set the volume to 40 percent.', { kind: 'music-volume', to: 40 }],
    ['Play Kind of Blue on Spotify.', { kind: 'music-search', query: 'Kind of Blue' }],
    ['Put on Radiohead.', { kind: 'music-search', query: 'Radiohead' }],
    ['Please play some Bon Iver', { kind: 'music-search', query: 'Bon Iver' }],
    ['Remind me to call the dentist tomorrow.', { kind: 'reminder', text: 'Call the dentist tomorrow' }],
    ["Don't let me forget to renew the domain", { kind: 'reminder', text: 'Renew the domain' }],
    ['Add a reminder to rotate the Stripe key.', { kind: 'reminder', text: 'Rotate the Stripe key' }],
    ['Take a note that the staging DB is stale.', { kind: 'note', text: 'The staging DB is stale' }],
    ['Note: Ask Sam about the API.', { kind: 'note', text: 'Ask Sam about the API' }],
    ['Log shipped the export button.', { kind: 'log', text: 'Shipped the export button' }],
    ['Start a pomodoro.', { kind: 'pomodoro', op: 'start' }],
    ['Start a Pomodoro on the auth tests.', { kind: 'pomodoro', op: 'start', text: 'The auth tests' }],
    ['Pause the timer.', { kind: 'pomodoro', op: 'pause' }],
    ['Skip the break.', { kind: 'pomodoro', op: 'skip' }],
    ['Give me five more minutes.', { kind: 'pomodoro', op: 'extend', minutes: 5 }],
    ['How long is left?', { kind: 'pomodoro', op: 'status' }],
    ['Tell session 2 to run the tests.', { kind: 'prompt', name: '2', text: 'Run the tests' }],
    ['Tell B2 to run the tests.', { kind: 'prompt', name: 'b2', text: 'Run the tests' }],
    ['Ask slay ten to check the logs', { kind: 'prompt', name: 'slay ten', text: 'Check the logs' }],
    ['Type yes, go ahead.', { kind: 'prompt', text: 'Yes, go ahead' }],
    ['Switch to workshop tiles.', { kind: 'focus-name', name: 'workshop tiles' }],
    ['Go to the slay session', { kind: 'focus-name', name: 'slay' }]
  ]
  for (const [said, want] of cases) it(`"${said}"`, () => expect(parseVoice(said)).toEqual(want))

  it('noise and filler are nothing', () => {
    for (const x of ['[BLANK_AUDIO]', ' (music) ', 'Thank you.', '', '*coughs*']) expect(parseVoice(x)).toEqual({ kind: 'unknown', text: '' })
  })
  it('anything else is unknown (the window types it as an unsent draft)', () => {
    expect(parseVoice('I wonder what time it is in Tokyo.')).toEqual({ kind: 'unknown', text: 'I wonder what time it is in Tokyo.' })
  })
})

describe('cleanHeard', () => {
  it('drops bracketed noise lines and joins the rest', () => {
    expect(cleanHeard('[BLANK_AUDIO]\n Session 3.\n')).toBe('Session 3.')
  })
})

describe('sessions by ID (Colin\'s: <folder>-<ID>)', () => {
  const real = [
    { id: '6343ac', name: 'demoscene-03', cwd: '/Users/colin/workshop-tiles/demoscene', title: null },
    { id: 'b6ea4f', name: 'builditbox-b2', cwd: '/Users/colin/builditbox', title: null },
    { id: 'f74a21', name: 'slay-10', cwd: '/Users/colin/slay', title: null },
    { id: '03cf68', name: 'life-83', cwd: '/Users/colin/life', title: null },
    { id: '8211b4', name: 'workshop-tiles-6d', cwd: '/Users/colin/workshop-tiles', title: null }
  ]
  const who = (said: string): string | undefined => matchSession(said, real)?.name
  it('the ID as whisper writes it', () => {
    expect(who('B2')).toBe('builditbox-b2')
    expect(who('10')).toBe('slay-10')
    expect(who('83')).toBe('life-83')
    expect(who('6D')).toBe('workshop-tiles-6d')
    expect(who('03')).toBe('demoscene-03')
  })
  it('the ID in words', () => {
    expect(who('bee two')).toBe('builditbox-b2')
    expect(who('b two')).toBe('builditbox-b2')
    expect(who('ten')).toBe('slay-10')
    expect(who('eighty three')).toBe('life-83')
    expect(who('six d')).toBe('workshop-tiles-6d')
    expect(who('six dee')).toBe('workshop-tiles-6d')
    expect(who('oh three')).toBe('demoscene-03')
    expect(sessionById('All three.', real)?.name).toBe('demoscene-03')
    expect(who('three')).toBe('demoscene-03')
  })
  it('the name, with or without its ID', () => {
    expect(who('slay ten')).toBe('slay-10')
    expect(who('life')).toBe('life-83')
    expect(who('builditbox')).toBe('builditbox-b2')
    expect(who('demoscene')).toBe('demoscene-03')
    expect(who('workshop tiles')).toBe('workshop-tiles-6d')
  })
  it('two sessions in one folder: only the ID decides', () => {
    const two = [...real, { id: 'aa', name: 'slay-4f', cwd: '/Users/colin/slay', title: null }]
    expect(matchSession('slay', two)).toBeNull()
    expect(matchSession('four f', two)?.name).toBe('slay-4f')
    expect(matchSession('slay ten', two)?.name).toBe('slay-10')
  })
  it('said on its own, only an exact ID or name counts', () => {
    expect(sessionById('B2.', real)?.name).toBe('builditbox-b2')
    expect(sessionById('slay ten', real)?.name).toBe('slay-10')
    expect(sessionById('life is good', real)).toBeNull()
    expect(sessionById('', real)).toBeNull()
  })
  it('reads IDs from names', () => {
    expect(sessionTag('workshop-tiles-6d')).toBe('6d')
    expect(sessionTag('new session')).toBeNull()
  })
})

describe('matchSession', () => {
  const list = [
    { id: 'a', name: 'workshop', cwd: '/Users/c/workshop', title: 'Voice commands' },
    { id: 'b', name: 'slay', cwd: '/Users/c/code/slay-app', title: null },
    { id: 'c', name: 'workshop-tiles', cwd: '/Users/c/workshop-tiles', title: 'Spotify door' }
  ]
  it('takes an exact name over a prefix', () => expect(matchSession('workshop', list)?.id).toBe('a'))
  it('spaces and dashes do not matter', () => expect(matchSession('workshop tiles', list)?.id).toBe('c'))
  it('a folder name', () => expect(matchSession('the slay app session', list)?.id).toBe('b'))
  it('a title', () => expect(matchSession('spotify door', list)?.id).toBe('c'))
  it('nothing close is null', () => expect(matchSession('kitchen', list)).toBeNull())
})

describe('scrollBytes', () => {
  it('keys and wheel reports', () => {
    expect(scrollBytes('pageUp', 1, 1)).toBe('\x1b[5~')
    expect(scrollBytes('bottom', 1, 1)).toBe('\x1b[1;5F')
    expect(scrollBytes('lineUp', 40, 12)).toBe('\x1b[<64;40;12M')
  })
})

describe('responseRows', () => {
  it('finds replies, tool calls and prompts', () => {
    expect(responseRows(['  text', '⏺ Here is the plan', '  ⎿ done', '❯ fix it', '> ', '● Bash(ls)'])).toEqual([1, 3, 5])
  })
})

describe('audio', () => {
  it('a WAV header whisper reads', () => {
    const w = encodeWav(new Float32Array([0, 1, -1]), 16000)
    const v = new DataView(w.buffer)
    expect(String.fromCharCode(...w.slice(0, 4))).toBe('RIFF')
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(40, true)).toBe(6)
    expect(v.getInt16(46, true)).toBe(0x7fff)
    expect(v.getInt16(48, true)).toBe(-0x8000)
  })
  it('resamples 48 kHz to 16 kHz', () => expect(resample(new Float32Array(4800), 48000, 16000).length).toBe(1600))
  it('cuts an utterance at a run of quiet, drops a click', () => {
    const u = new Utterances({ endQuietMs: 300, minSpeechMs: 200, maxMs: 5000 })
    for (let i = 0; i < 20; i++) expect(u.feed(0.002, 50)).toBeNull()
    expect(u.feed(0.2, 50)).toBe('start')
    for (let i = 0; i < 6; i++) expect(u.feed(0.2, 50)).toBeNull()
    for (let i = 0; i < 5; i++) expect(u.feed(0.001, 50)).toBeNull()
    expect(u.feed(0.001, 50)).toBe('end')
    expect(u.feed(0.3, 50)).toBe('start')
    let r = null
    for (let i = 0; i < 6 && !r; i++) r = u.feed(0.001, 50)
    expect(r).toBe('drop')
  })
})
