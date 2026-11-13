// Smoke checks for the wolfpack and the `transcripts` permission (called from smoke.ts's sessions
// run). The stand-in CLI (test/fixtures/fake-claude/claude) runs subagents the way Claude Code
// 2.1.322 does: the hooks with the parent's session id, the agent's own transcript under
// <session id>/subagents/ with its meta sidecar. Here: a subagent's tile appears under its session,
// working, in the worker coat; it finishes by its stop hook and by its sidecar alone; a Workflow's
// is found two folders down by looking; an internal fork gets no tile; kill takes the tile and
// tells the parent; pause waits for the leash, and the seam the leash calls holds and releases.
// Then a tile reads a session's conversation with the permission, and is refused without it.

import type { BrowserWindow, WebContents } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentView } from '@shared/agents'
import type { CoreSessions } from './core-sessions'

type Check = (name: string, ok: boolean, detail?: string) => void

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return true
    await sleep(100)
  }
  return false
}

interface O {
  win: BrowserWindow
  core: CoreSessions
  userData: string
  liveByTile: Map<string, { wc: WebContents }>
}

/** `id` is an open session (its terminal in the center). Leaves it with no pack. */
export async function agentsSmoke(check: Check, o: O, id: string): Promise<void> {
  const { win, core, userData } = o
  const js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const screen = async (): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const type = (line: string): Promise<unknown> => js(`window.core.ptyInput(${JSON.stringify(id)}, ${JSON.stringify(line + '\r')}); true`)
  const turn = async (line: string): Promise<void> => {
    await type(line)
    await waitFor(async () => (await screen()).includes(`DONE ${line}`), 10_000)
  }
  const idOf = async (how: string): Promise<string> => (await readFile(join(userData, `fake-agent-${how}.txt`), 'utf8').catch(() => '')).trim()
  const agent = (aid: string): AgentView | undefined => core.agentsState().agents.find((a) => a.id === aid)
  const dom = (sel: string): Promise<any> => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? { text: el.textContent, coat: el.querySelector('canvas.knot')?.dataset.coat ?? null } : null })()`)

  // A subagent that ends with its stop hook: seen working first (the stand-in waits a beat between).
  await type('agent stop')
  let working: AgentView | undefined
  await waitFor(async () => {
    const aid = await idOf('stop')
    working = aid ? agent(aid) : undefined
    return !!working && working.found && working.endedAt === null
  })
  check('wolfpack: a subagent is a tile while it works, its transcript found by looking', !!working && working.parent === id && working.type === 'general-purpose' && working.description === 'smoke stop', JSON.stringify(working))
  const tile = await dom(`.pack-tile[data-pack="${id}"]`)
  check('wolfpack: its pack tile is in the column, under its session', !!tile && String(tile.text).includes('smoke stop'), JSON.stringify(tile))
  check('wolfpack: its mark wears the worker coat', tile?.coat === 'worker', JSON.stringify(tile))
  await waitFor(async () => (await screen()).includes('DONE agent stop'), 10_000)
  const sid = (await idOf('stop')) || 'none'
  const ended = await waitFor(() => agent(sid)?.endedAt != null)
  check('wolfpack: the stop hook finishes it, with what it said last', ended && agent(sid)?.lastText === 'The stop agent read it.', JSON.stringify(agent(sid)))
  const t = core.transcripts.get(`agent:${sid}`)
  check(
    'wolfpack: its conversation is tailed from its own file (the brief, the tool call, the answer)',
    !!t && t.blocks[0]?.kind === 'user' && t.blocks.some((b) => b.kind === 'tool' && b.name === 'Read' && b.done) && t.blocks.some((b) => b.kind === 'text' && b.text.includes('read it')),
    JSON.stringify(t?.blocks)
  )
  await waitFor(async () => String((await dom(`.pack-tile[data-pack="${id}"] .chat`))?.text ?? '').includes('The stop agent read it.'))
  check('wolfpack: the pack tile shows the agent\'s conversation', String((await dom(`.pack-tile[data-pack="${id}"] .chat`))?.text ?? '').includes('The stop agent read it.'))
  const parentT = core.transcripts.get(id)
  check('wolfpack: the subagent\'s lines stay out of the parent\'s conversation', !!parentT && !JSON.stringify(parentT.blocks).includes('read it'))

  // An internal fork: a stop for an agent that never wrote a transcript. No tile.
  await turn('agent fork')
  await sleep(300)
  check('wolfpack: an internal fork (no transcript) gets no tile', !agent(await idOf('fork')))
  check('wolfpack: a prompt you typed clears the finished', !agent(sid))

  // No stop hook ever: the sidecar says finished and the transcript is quiet.
  await turn('agent nostop')
  const nid = await idOf('nostop')
  const byMeta = await waitFor(() => agent(nid)?.endedAt != null, 4000)
  check('wolfpack: one whose stop never comes is finished by its sidecar once quiet', byMeta && agent(nid)?.found === true && agent(nid)?.lastText === null, JSON.stringify(agent(nid)))

  // A Workflow's agent, two folders down, its stop naming no file.
  await turn('agent workflow')
  const wid = await idOf('workflow')
  await waitFor(() => agent(wid)?.endedAt != null && !!agent(wid)?.found)
  const w = agent(wid)
  check('wolfpack: a Workflow agent is found under workflows/wf_<run>/, with its phase', !!w && w.found && w.type === 'workflow-subagent' && w.phase === 'Build' && w.endedAt !== null, JSON.stringify(w))

  // One that never ends: pause holds its calls through the leash; kill takes it and tells the session.
  await turn('agent hold')
  const hid = await idOf('hold')
  await waitFor(() => !!agent(hid)?.found)
  const marked = (): Promise<boolean> => stat(join(userData, 'leash', `${id}.agents`)).then(() => true, () => false)
  await waitFor(async () => (await js(`!!document.querySelector('.pack-tile .pack-pause')`)) === true, 3000)
  check('wolfpack: each running agent has a pause button (the leash is wired)', (await js(`!!document.querySelector('.pack-tile .pack-pause')`)) === true)
  check('wolfpack: no agent paused, no mark: the session\'s calls never reach core', !(await marked()))
  await js(`window.core.agents.pause(${JSON.stringify(hid)})`)
  await waitFor(() => marked(), 3000)
  check('wolfpack: pausing an agent marks its session for leash.sh', await marked())
  // The agent's next tool call, through the real PreToolUse hook (leash.sh) and /ask/pretool.
  await type('subtool hold')
  await waitFor(() => agent(hid)?.held === true, 5000)
  await sleep(500)
  check('wolfpack: a paused agent\'s tool call is held, through the hook', agent(hid)?.held === true && !(await screen()).includes('SUBTOOL'), JSON.stringify(agent(hid)))
  await js(`window.core.agents.resume(${JSON.stringify(hid)})`)
  await waitFor(async () => (await screen()).includes('DONE subtool hold'), 5000)
  check('wolfpack: resume lets it through, and the mark goes', (await screen()).replace(/\s+/g, ' ').includes('SUBTOOL ran') && agent(hid)?.held === false && !(await marked()), (await screen()).slice(-300))
  // Kill: two clicks in place on the chosen agent's line.
  await js(`document.querySelector('.pack-tile .pack-chip[data-agent="${hid}"]').click(); true`)
  await sleep(100)
  await js(`document.querySelector('.pack-tile .pack-line[data-agent="${hid}"] .pack-kill').click(); true`)
  await sleep(100)
  const armed = (await js(`document.querySelector('.pack-tile .pack-line[data-agent="${hid}"] .pack-kill')?.textContent`)) as string
  check('wolfpack: kill arms first (one click is not enough)', armed === 'stop' && !!agent(hid), armed)
  await js(`document.querySelector('.pack-tile .pack-line[data-agent="${hid}"] .pack-kill').click(); true`)
  await waitFor(() => !agent(hid), 3000)
  check('wolfpack: the second click takes the tile at once', !agent(hid))
  const told = await waitFor(async () => (await screen()).includes('DONE [workshop] The user stopped your subagent'), 5000)
  check('wolfpack: the session is told, in one typed line', told, (await screen()).slice(-400))
  // The terminal is narrow: a long line wraps, so the screen is read as one run of text. (The first
  // `subtool hold` left its DONE on screen, so this waits for the refusal itself.)
  const flatScreen = async (): Promise<string> => (await screen()).replace(/\s+/g, ' ')
  await type('subtool hold')
  await waitFor(async () => (await flatScreen()).includes('SUBTOOL denied'), 10_000)
  const flat = await flatScreen()
  check('wolfpack: a killed agent\'s later calls are refused, through the hook', /SUBTOOL denied Refused: the user stopped this agent/.test(flat) && (await marked()), flat.slice(-300))

  // A helper session: the session starts one through its CLI, as the workshop:helper skill says.
  await turn('bash node "$WORKSHOP_HELPER" start --name smoke-helper "Say hi"')
  let hv: AgentView | undefined
  await waitFor(() => !!(hv = core.agentsState().agents.find((a) => a.kind === 'helper' && a.description === 'smoke-helper')), 5000)
  check('helpers: a session starts one, and it is in its pack', !!hv && hv.parent === id && hv.type === 'helper', JSON.stringify(core.agentsState().agents.filter((a) => a.kind === 'helper')))
  const short = hv?.attach ?? 'none'
  const started = JSON.parse(await readFile(join(userData, `fake-helper-${short}.json`), 'utf8').catch(() => '{"args":[]}')) as { args: string[]; auth?: string; session?: string }
  const own = JSON.parse(await readFile(join(userData, `fake-${id}.json`), 'utf8')) as { auth: string }
  const ha = started.args.join(' ')
  check(
    "helpers: it is the CLI's own background session, with our settings, the parent's model and permission mode",
    started.args.includes('--bg') && started.args.includes('--settings') && ha.includes('--name smoke-helper') && ha.includes('--model sonnet') && ha.includes('--permission-mode plan') && started.args.at(-1) === 'Say hi',
    ha
  )
  check("helpers: it has a token of its own, not its parent's", !!started.auth && started.auth !== own.auth && started.session === id, JSON.stringify(started))
  const finished = await waitFor(() => !!core.agentsState().agents.find((a) => a.id === hv?.id && a.endedAt !== null && a.found), 8000)
  const hd = core.agentsState().agents.find((a) => a.id === hv?.id)
  check('helpers: its hooks reach core by its token; its Stop finishes it with what it said', finished && hd?.lastText === 'Helper finished: Say hi', JSON.stringify(hd))
  const ht = core.transcripts.get(`agent:${hv?.id}`)
  check('helpers: its conversation is tailed by its session id', !!ht && ht.found && ht.blocks.some((b) => b.kind === 'user' && b.text === 'Say hi'), JSON.stringify(ht?.blocks))
  check("helpers: its hooks never touch its parent's state", core.sessions.view(id)?.status === 'idle')
  await turn(`bash node "$WORKSHOP_HELPER" result ${hv?.id}`)
  check('helpers: the session collects the result', (await screen()).replace(/\s+/g, ' ').includes('"result": "Helper finished: Say hi"'), (await screen()).slice(-400))
  // One that holds: stopping it is the CLI's own `claude stop <id>`.
  await turn('bash node "$WORKSHOP_HELPER" start --name smoke-hold "hold on"')
  let hold: AgentView | undefined
  await waitFor(() => !!(hold = core.agentsState().agents.find((a) => a.description === 'smoke-hold' && a.found)), 5000)
  await js(`window.core.agents.kill(${JSON.stringify(hold?.id ?? '')})`)
  const marker = join(userData, 'claude-config', `fake-stop-${hold?.attach}`)
  const stoppedIt = await waitFor(() => readFile(marker).then(() => true, () => false), 5000)
  check('helpers: kill is claude stop <id>, and the tile goes', stoppedIt && !core.agentsState().agents.some((a) => a.id === hold?.id), marker)
  const outside = await core.call('helper', '0'.repeat(48), { op: 'list' }).then(() => 'listed', (e: Error) => e.message)
  check('helpers: only a session inside workshop can start or list them', /only a session/.test(outside), outside)

  // WORKSHOP_SHOT_PACK=<file.png>: a picture of the window with a pack of three, to eyeball the tile.
  if (process.env.WORKSHOP_SHOT_PACK) {
    await type('agent hold')
    await sleep(2500)
    await writeFile(process.env.WORKSHOP_SHOT_PACK, (await win.webContents.capturePage()).toPNG())
    const extra = await idOf('hold')
    if (agent(extra)) await js(`window.core.agents.dismiss(${JSON.stringify(extra)})`)
  }

  // The finished ones' × clears them; the column is left as it was.
  for (const a of core.agentsState().agents.filter((x) => x.parent === id)) await js(`window.core.agents.dismiss(${JSON.stringify(a.id)})`)
  await waitFor(async () => (await js(`!document.querySelector('.pack-tile')`)) === true, 3000)
  check('wolfpack: × clears a finished agent, and an empty pack has no tile', (await js(`!document.querySelector('.pack-tile')`)) === true)
}

/** The probe asks for "transcripts" (with "sessions"); Wikipedia asks for neither. */
export async function transcriptsSmoke(check: Check, o: O, id: string): Promise<void> {
  const { win, core, liveByTile } = o
  const probe = liveByTile.get('probe')!.wc
  const wiki = liveByTile.get('wikipedia')!.wc
  const screen = async (): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  const t = (await probe.executeJavaScript(`workshop.sessions.transcript(${JSON.stringify(id)})`)) as { id: string; blocks: { kind: string; text?: string }[]; found: boolean } | null
  check('transcripts: a tile with the permission reads a session\'s conversation, parsed', !!t && t.id === id && t.found && JSON.stringify(t.blocks) === JSON.stringify(core.transcripts.get(id)?.blocks) && t.blocks.some((b) => b.kind === 'user') && t.blocks.some((b) => b.kind === 'tool'), JSON.stringify(t).slice(0, 300))
  check('transcripts: the shape a session tile draws, not the raw lines', !!t && !JSON.stringify(t).includes('isSidechain') && !JSON.stringify(t).includes('SIDECHAIN NOT SHOWN') && !JSON.stringify(t).includes('META NOT SHOWN'))
  await probe.executeJavaScript(`window.seenT = []; window.stopT = workshop.sessions.watchTranscript(${JSON.stringify(id)}, (t) => window.seenT.push(t)); true`)
  await win.webContents.executeJavaScript(`window.core.ptyInput(${JSON.stringify(id)}, 'watched turn\\r'); true`)
  await waitFor(async () => (await screen()).includes('DONE watched turn'))
  const heard = await waitFor(async () => (await probe.executeJavaScript(`window.seenT.some((t) => t.blocks.some((b) => b.kind === 'user' && b.text === 'watched turn'))`)) === true, 4000)
  check('transcripts: watchTranscript hears the next turn', heard)
  await probe.executeJavaScript(`window.stopT(); true`)
  const bad = (await probe.executeJavaScript(`Promise.all([workshop.sessions.transcript('agent:x').then(() => 'ok', (e) => e.message), workshop.sessions.transcript('ffffff').then(() => 'ok', (e) => e.message)])`)) as string[]
  check('transcripts: only a session\'s, by its id (never a subagent\'s, never a guess)', bad.every((m) => /no such session/.test(m)), JSON.stringify(bad))
  const refused = (await wiki.executeJavaScript(`workshop.sessions.transcript(${JSON.stringify(id)}).then(() => 'read it', (e) => e.message)`)) as string
  check('transcripts: a tile without the permission is refused', /transcripts/.test(refused), refused)
  const noWatch = (await wiki.executeJavaScript(`(() => { try { workshop.sessions.watchTranscript(${JSON.stringify(id)}, () => 0); return 'watching' } catch (e) { return e.message } })()`)) as string
  check('transcripts: nor can it watch one', /transcripts/.test(noWatch), noWatch)
}

/** The probe asks for "activity" (with "sessions"); Wikipedia does not. Run after transcriptsSmoke's turns. */
export async function activitySmoke(check: Check, o: O, id: string): Promise<void> {
  const { win, core, liveByTile } = o
  const probe = liveByTile.get('probe')!.wc
  const wiki = liveByTile.get('wikipedia')!.wc
  const screen = async (): Promise<string> => (await core.tmux.screen(`ws-${id}`))?.text ?? ''
  type Ev = { kind: string; name?: string; input?: Record<string, unknown>; status?: string; model?: string; end?: number }
  const a = (await probe.executeJavaScript(`workshop.sessions.activity(${JSON.stringify(id)})`)) as { id: string; found: boolean; events: Ev[] } | null
  const ev = a?.events ?? []
  const shell = ev.find((e) => e.kind === 'tool' && e.name === 'Bash')
  check(
    'activity: a tile with the permission reads what a session does: prompts, model steps, calls and their end',
    !!a && a.id === id && a.found && ev.some((e) => e.kind === 'prompt') && ev.some((e) => e.kind === 'step' && e.model === 'claude-haiku-5-5') && ev.some((e) => e.kind === 'end') && shell?.status === 'ok' && shell.input?.command === 'curl -s https://example.com/smoke',
    JSON.stringify(ev).slice(0, 400)
  )
  const raw = JSON.stringify(a)
  check('activity: never the prose, a result, or what a call wrote', !/Looking into|Finished|RESULT TEXT NOT SERVED|WRITTEN TEXT NOT SERVED|SIDECHAIN NOT SHOWN|META NOT SHOWN/.test(raw), raw.slice(0, 300))
  await probe.executeJavaScript(`window.seenA = []; window.stopA = workshop.sessions.watchActivity(${JSON.stringify(id)}, (a) => window.seenA.push(a)); true`)
  const prompts = ev.filter((e) => e.kind === 'prompt').length
  await win.webContents.executeJavaScript(`window.core.ptyInput(${JSON.stringify(id)}, 'mapped turn\\r'); true`)
  await waitFor(async () => (await screen()).includes('DONE mapped turn'))
  const heard = await waitFor(async () => (await probe.executeJavaScript(`window.seenA.some((a) => a.events.filter((e) => e.kind === 'prompt').length > ${prompts})`)) === true, 4000)
  check('activity: watchActivity hears the next turn', heard)
  await probe.executeJavaScript(`window.stopA(); true`)
  const bad = (await probe.executeJavaScript(`Promise.all([workshop.sessions.activity('agent:x').then(() => 'ok', (e) => e.message), workshop.sessions.activity('ffffff').then(() => 'ok', (e) => e.message)])`)) as string[]
  check('activity: only a session\'s, by its id', bad.every((m) => /no such session/.test(m)), JSON.stringify(bad))
  const refused = (await wiki.executeJavaScript(`workshop.sessions.activity(${JSON.stringify(id)}).then(() => 'read it', (e) => e.message)`)) as string
  check('activity: a tile without the permission is refused', /activity/.test(refused), refused)
  const noWatch = (await wiki.executeJavaScript(`(() => { try { workshop.sessions.watchActivity(${JSON.stringify(id)}, () => 0); return 'watching' } catch (e) { return e.message } })()`)) as string
  check('activity: nor can it watch one', /activity/.test(noWatch), noWatch)
}
