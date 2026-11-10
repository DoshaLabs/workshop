// The Reminders tile's rules, run against the file the tile ships (tiles/reminders/dist/model.js).
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript, as a tile's page is
import { apply, clean, empty, parseCall, projectsOf, resolveProject, sessionProject, sweep } from '../tiles/reminders/dist/model.js'

const DAY = 24 * 3600 * 1000
const NOON = new Date(2026, 10, 10, 12).getTime()
let n = 0
const ctx = (over: Record<string, unknown> = {}) => ({ by: 'you', now: NOON, here: '/code/app', known: ['/code/app', '/code/site'], id: (p: string) => `${p}_${++n}`, ...over })
const run = (state: unknown, op: string, args: string[], over = {}) => apply(state, parseCall(op, args, NOON), ctx(over))

describe('reminders model', () => {
  it('adds to the calling session’s project, with flags from the door’s words', () => {
    const r = run(empty(), 'add', ['Rotate', 'the key', '--priority', 'high', '--due=tomorrow'], { by: 'fix-auth' })
    expect(r.result.reminder).toMatchObject({ project: '/code/app', text: 'Rotate the key', priority: 'high', due: '2026-11-11', by: 'fix-auth', doneAt: null })
  })

  it('a project is an absolute folder or one known name; never a guess', () => {
    expect(run(empty(), 'add', ['x', '--project', 'site']).result.reminder.project).toBe('/code/site')
    expect(run(empty(), 'add', ['x', '--project', '/tmp/new/']).result.reminder.project).toBe('/tmp/new')
    expect(() => run(empty(), 'add', ['x', '--project', '~/site'])).toThrow(/no project called/)
    expect(() => resolveProject('app', ['/a/app', '/b/app'])).toThrow(/2 projects/)
    expect(() => run(empty(), 'add', ['x'], { here: '' })).toThrow(/which project/)
  })

  it('files a session by its repository, so worktrees of one repo land together', () => {
    const main = { id: 'a', project: '/code/app', root: '/code/app' }
    const wt = { id: 'b', project: '/code/app/.claude/worktrees/fix', root: '/code/app' }
    expect(sessionProject(main)).toBe('/code/app')
    expect(sessionProject(wt)).toBe('/code/app')
    // An older workshop reported only the start folder.
    expect(sessionProject({ id: 'c', project: '/code/site' })).toBe('/code/site')
    expect(sessionProject(undefined)).toBe('')
    const r = run(empty(), 'add', ['from the worktree'], { by: 'fix', here: sessionProject(wt) })
    expect(r.result.reminder.project).toBe('/code/app')
    expect(projectsOf(r.state, [main, wt].map(sessionProject))).toEqual(['/code/app'])
  })

  it('refuses what it does not know', () => {
    expect(() => parseCall('add', ['x', '--shout'], NOON)).toThrow(/no --shout/)
    expect(() => parseCall('done', [], NOON)).toThrow(/which id/)
    expect(() => run(empty(), 'add', ['x', '--priority', 'urgent'])).toThrow(/priority is/)
    expect(() => run(empty(), 'add', ['x', '--due', '2026-02-30'])).toThrow(/real date/)
    expect(() => run(empty(), 'add', ['  '])).toThrow(/empty/)
  })

  it('done writes the log line, undo takes it back, and the day’s end sweeps the reminder but not the line', () => {
    let s = run(empty(), 'add', ['Ship it']).state
    const id = s.reminders[0].id
    s = run(s, 'done', [id], { by: 'a-session' }).state
    expect(s.log).toHaveLength(1)
    expect(s.log[0]).toMatchObject({ text: 'Ship it', by: 'a-session', reminderId: id })
    expect(run(s, 'undo', [id]).state.log).toHaveLength(0)
    expect(sweep(s, NOON)).toBe(s)
    const next = sweep(s, NOON + DAY)
    expect(next.reminders).toHaveLength(0)
    expect(next.log).toHaveLength(1)
  })

  it('set renames a completed reminder’s log line; rm takes a reminder’s line with it', () => {
    let s = run(empty(), 'add', ['Old']).state
    const id = s.reminders[0].id
    s = run(s, 'done', [id]).state
    s = run(s, 'set', [id, '--text', 'New', '--due', 'none']).state
    expect(s.log[0].text).toBe('New')
    expect(run(s, 'rm', [id]).state).toMatchObject({ reminders: [], log: [] })
    expect(() => run(s, 'rm', ['nope'])).toThrow(/nothing has the id/)
  })

  it('lists one project unless --all, open ones first by priority', () => {
    let s = run(empty(), 'add', ['low one', '--priority', 'low']).state
    s = run(s, 'add', ['high one', '--priority', 'high']).state
    s = run(s, 'add', ['elsewhere', '--project', 'site']).state
    s = run(s, 'note', ['a note']).state
    s = run(s, 'log', ['did a thing']).state
    expect(run(s, 'list', []).result.reminders.map((r: { text: string }) => r.text)).toEqual(['high one', 'low one'])
    expect(run(s, 'list', ['--all']).result.reminders).toHaveLength(3)
    expect(run(s, 'notes', []).result.notes).toHaveLength(1)
    expect(run(s, 'history', ['--limit', '5']).result.log[0].text).toBe('did a thing')
    expect(run(s, 'list', []).state).toBe(s)
    expect(projectsOf(s)).toEqual(['/code/app', '/code/site'])
  })

  it('cleans whatever storage held', () => {
    expect(clean(null)).toEqual(empty())
    const s = clean({ reminders: [{ id: 'r_1', project: '/p', text: 't', priority: 'loud', due: 'soon' }, { id: 'r_2' }, 7], notes: 'x', log: [{ id: 'l_1', project: '/p', text: 'did' }] })
    expect(s.reminders).toEqual([{ id: 'r_1', project: '/p', text: 't', detail: '', priority: 'normal', due: null, createdAt: 0, by: 'you', doneAt: null }])
    expect(s.notes).toEqual([])
    expect(s.log[0].reminderId).toBeNull()
  })
})
