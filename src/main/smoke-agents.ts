// Smoke checks for the wolfpack and the `transcripts` permission (called from smoke.ts's sessions
// run). The stand-in CLI (test/fixtures/fake-claude/claude) runs subagents the way Claude Code
// 2.1.322 does: the hooks with the parent's session id, the agent's own transcript under
// <session id>/subagents/ with its meta sidecar. Here: a subagent's tile appears under its session,
// working, in the worker coat; it finishes by its stop hook and by its sidecar alone; a Workflow's
// is found two folders down by looking; an internal fork gets no tile; kill takes the tile and
// tells the parent; pause waits for the leash, and the seam the leash calls holds and releases.
// Then a tile reads a session's conversation with the permission, and is refused without it.

import type { BrowserWindow, WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
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

  // One that never ends: pause waits for the leash; kill takes it and tells the session.
  await turn('agent hold')
  const hid = await idOf('hold')
  await waitFor(() => !!agent(hid)?.found)
  const noLeash = (await js(`window.core.agents.pause(${JSON.stringify(hid)}).then(() => 'paused', (e) => e.message)`)) as string
  check('wolfpack: pause says it needs the leash when there is none', /leash/.test(noLeash), noLeash)
  check('wolfpack: no pause button without the leash', (await js(`!document.querySelector('.pack-tile .pack-pause')`)) === true)
  // The seam the leash calls: with it wired, a paused agent's next tool call waits until resume.
  const rec = core.sessions.find(id)!
  core.agents.setLeash(true)
  await waitFor(async () => (await js(`!!document.querySelector('.pack-tile .pack-pause')`)) === true, 3000)
  check('wolfpack: with the leash, each running agent has a pause button', (await js(`!!document.querySelector('.pack-tile .pack-pause')`)) === true)
  await js(`window.core.agents.pause(${JSON.stringify(hid)})`)
  let answer: unknown = 'waiting'
  const held = core.agents.preTool(rec, { session_id: rec.claudeSessionId, agent_id: hid, tool_name: 'Read' }, () => undefined).then((d) => (answer = d))
  await sleep(200)
  check('wolfpack: a paused agent\'s tool call is held at the seam', answer === 'waiting' && agent(hid)?.held === true, JSON.stringify(agent(hid)))
  await js(`window.core.agents.resume(${JSON.stringify(hid)})`)
  await held
  check('wolfpack: resume lets it through', answer === null && agent(hid)?.held === false)
  core.agents.setLeash(false)
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
  const refused = await core.agents.preTool(rec, { session_id: rec.claudeSessionId, agent_id: hid, tool_name: 'Read' }, () => undefined)
  check('wolfpack: a killed agent\'s later calls are refused at the seam', refused?.hookSpecificOutput.permissionDecision === 'deny')

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
  check('transcripts: a tile with the permission reads a session\'s conversation, parsed', !!t && t.id === id && t.found && t.blocks.some((b) => b.kind === 'user' && b.text === 'hello') && t.blocks.some((b) => b.kind === 'tool'), JSON.stringify(t).slice(0, 300))
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
