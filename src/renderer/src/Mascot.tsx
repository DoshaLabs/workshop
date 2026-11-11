// A session's status mark (CLAUDE.md §8): an installed sprite pack's mascot if there is one (the
// pose is the status, a call for attention is a Leap played once), else the Knot (Knot.tsx). Anywhere a status
// is drawn can use this in place of `<span className={`dot ${status}`} />`; the dot itself is
// left only as the Knot's fallback when no 2D canvas can be had.
//
// A sprite is one element whose background is the sheet, moved a frame at a time by the shared
// clock (mascot-store.ts). No canvas and no WebGL: terminals need the WebGL contexts.

import { useEffect, useRef, type CSSProperties } from 'react'
import { STATE_LABEL, fitScale, poseFor, runFor, spriteAt, type MascotPack, type MascotState } from '@shared/mascot'
import type { SessionStatus } from '@shared/sessions'
import { animate, leapingSince, reducedMotion, useActiveMascot } from './mascot-store'
import { SessionKnot } from './Knot'

const LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  busy: 'working',
  idle: 'waiting for you',
  blocked: 'needs you',
  dead: 'exited',
  unknown: 'unknown'
}

export function Mascot({ id, status, attention = false, coat }: { id?: string; status: SessionStatus; attention?: boolean; /** The worker coat: a subagent's or a helper session's (the wolfpack). */ coat?: 'worker' }) {
  const m = useActiveMascot()
  if (!m) return <SessionKnot id={id} status={status} attention={attention} coat={coat === 'worker' ? 'worker' : 'own'} />
  const pose = poseFor(status, attention)
  const needs = pose === 'look' && status !== 'blocked' ? ' (needs you)' : ''
  return (
    <Sprite
      pack={m.pack}
      sheet={coat === 'worker' ? 'var(--mascot-sheet-worker)' : 'var(--mascot-sheet)'}
      state={pose}
      attentionOf={id}
      className={`mascot ${status}${coat === 'worker' ? ' worker' : ''}`}
      title={`${m.pack.name}: ${LABEL[status]}${needs}`}
    />
  )
}

/**
 * One animated sprite. `sheet` is a CSS image (a `var(--…)` or `url(…)`); `state` its pose. With
 * `attentionOf`, it plays the Leap once whenever that session calls for attention. `scale` defaults to fitting the
 * art into the head's 22 × 18.
 */
export function Sprite({ pack, sheet, state, attentionOf, scale, className = '', title }: { pack: MascotPack; sheet: string; state: MascotState; attentionOf?: string; scale?: number; className?: string; title?: string }) {
  const el = useRef<HTMLSpanElement>(null)
  const s = scale ?? fitScale(pack)
  const box = pack.box ?? { x: 0, y: 0, w: pack.frame.w, h: pack.frame.h }

  useEffect(() => {
    const node = el.current
    const run = runFor(pack, state)
    const leap = runFor(pack, 'leap')
    if (!node || !run) return
    const t0 = performance.now()
    let last = ''
    return animate((now) => {
      const leapAt = leapingSince(attentionOf, now)
      const playing = leapAt !== null && leap ? leap : run
      const i = reducedMotion() && leapAt === null ? 0 : Math.floor((now - (leapAt ?? t0)) / playing.ms)
      const { size, pos } = spriteAt(pack, playing, i, s)
      const key = `${size[0]} ${size[1]} ${pos[0]} ${pos[1]}`
      if (key === last) return
      last = key
      node.style.backgroundSize = `${size[0]}px ${size[1]}px`
      node.style.backgroundPosition = `${pos[0]}px ${pos[1]}px`
      node.dataset.pose = leapAt !== null ? 'leap' : state
    })
  }, [pack, state, attentionOf, s])

  const style: CSSProperties = { width: box.w * s, height: box.h * s, backgroundImage: sheet }
  return <span ref={el} className={`sprite ${className}`} style={style} data-pose={state} title={title ?? STATE_LABEL[state]} role="img" aria-label={title ?? STATE_LABEL[state]} />
}
