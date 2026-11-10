// A render error in one piece of core's window stays in that piece: React unmounts the whole tree
// on an uncaught error, and core's window must never go blank because one conversation held
// something a tile could not draw. The piece shows a line saying so, and tries again when `reset`
// changes (a session's next transcript, say).

import { Component, type ReactNode } from 'react'

export class Guard extends Component<{ what: string; reset?: unknown; children: ReactNode }, { error: string | null; reset?: unknown }> {
  state: { error: string | null; reset?: unknown } = { error: null }

  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: String((err as Error)?.message ?? err) }
  }

  static getDerivedStateFromProps(props: { reset?: unknown }, state: { error: string | null; reset?: unknown }) {
    if (props.reset !== state.reset) return { error: null, reset: props.reset }
    return null
  }

  componentDidCatch(err: unknown): void {
    console.error(`[window] ${this.props.what} failed to draw:`, err)
  }

  render(): ReactNode {
    if (this.state.error)
      return (
        <div className="guard-error" title={this.state.error}>
          {this.props.what} could not be drawn.
        </div>
      )
    return this.props.children
  }
}
