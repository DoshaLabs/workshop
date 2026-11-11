// The wolfpack: a session's subagents (what it runs through the Agent tool or a Workflow) and its
// helper sessions (background sessions it started through workshop), as core keeps them and the
// left column shows them, under their parent session. Main tracks them (main/agents.ts,
// main/helpers.ts); this is the shape and the few pure rules both sides use.

import type { SessionStatus } from './sessions'

export type AgentKind = 'subagent' | 'helper'

export interface AgentView {
  /** The CLI's agent id (a subagent), or core's id for a helper session ("h" + 6 hex). */
  id: string
  kind: AgentKind
  /** Core's id of the session it works for. */
  parent: string
  /** The agent's type (`general-purpose`, `Explore`, `workflow-subagent`…), or `helper`. */
  type: string
  /** What the parent called it: the Agent call's description, a Workflow agent's label, a helper's name. */
  description: string
  /** The first line of its brief, once its transcript shows it. */
  task: string
  model: string
  /** A Workflow agent's phase. */
  phase: string
  /** Started in the background (the parent carried on without waiting). */
  background: boolean
  startedAt: number
  /** When it finished, or null while it runs. */
  endedAt: number | null
  /** What it said last, once it finished (the stop hook's word). */
  lastText: string | null
  /** Paused by the user: its next tool call waits (needs the leash; see AgentsState.leash). */
  paused: boolean
  /** Paused, and a tool call of its is being held now. */
  held: boolean
  /** Its transcript has been found on disk (never guessed). */
  found: boolean
}

export interface AgentsState {
  agents: AgentView[]
  /**
   * Whether a tool call can be held or refused (the leash: a PreToolUse hook answered by core).
   * Without it, pause cannot bite and kill can only take the tile away and tell the parent.
   */
  leash: boolean
}

/** The transcript id an agent's conversation goes by (the window's transcripts store, ChatView). */
export const agentTranscriptId = (id: string): string => `agent:${id}`

/** The name a tile shows. */
export function agentName(a: Pick<AgentView, 'description' | 'task' | 'type'>): string {
  return a.description || a.task || a.type || 'agent'
}

/** The status the mark shows: working, paused (needs you), finished (resting). */
export function agentStatus(a: Pick<AgentView, 'endedAt' | 'paused' | 'found'>): SessionStatus {
  if (a.endedAt !== null) return 'idle'
  if (a.paused) return 'blocked'
  return a.found ? 'busy' : 'starting'
}

/** "general-purpose · haiku", "workflow · Build", "helper · sonnet": what kind of agent, in a few words. */
export function agentKind(a: Pick<AgentView, 'kind' | 'type' | 'model' | 'phase'>): string {
  const type = a.kind === 'helper' ? 'helper' : a.type === 'workflow-subagent' ? 'workflow' : a.type
  const model = a.model.replace(/^claude-/, '').replace(/-\d[\d-]*$/, '')
  return [type, a.phase || model].filter(Boolean).join(' · ')
}

/** The first line of a prompt, as a name. */
export function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim()) ?? ''
  return line.trim().replace(/^#+\s*/, '').slice(0, 120)
}

/**
 * A finished agent stays until its parent's next prompt that you typed. The CLI also fires
 * UserPromptSubmit when a background agent's result comes back (`<task-notification>…`): that one
 * is not a new turn of yours and must not clear the pack.
 */
export const typedPrompt = (prompt: unknown): boolean => !/^\s*</.test(String(prompt ?? ''))
