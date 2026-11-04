import { Component, type ReactNode } from 'react'

/** Keeps an error to the part of the screen it happened in: that part says so, with a way to try again, and the rest carries on.
 *  Saved data one part cannot draw (an event, a setting) would otherwise blank the whole window, and again on every start. */
export class Guard extends Component<
  {
    children: ReactNode
    /** What this part is, for the message: "the agent panel", "this part of the conversation". */
    name: string
    /** In place of the children once they fail. Without it, a short note with Try again. */
    fallback?: (error: Error, retry: () => void) => ReactNode
    /** Told when the children fail, as to close what they were in. */
    onError?: (error: Error) => void
    /** The children are drawn afresh when this changes: another session, another page. */
    reset?: unknown
  },
  { error: Error | null; reset: unknown }
> {
  state = { error: null as Error | null, reset: this.props.reset }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
  static getDerivedStateFromProps(props: { reset?: unknown }, state: { reset: unknown }) {
    return Object.is(props.reset, state.reset) ? null : { error: null, reset: props.reset }
  }
  componentDidCatch(error: Error) {
    this.props.onError?.(error)
  }
  retry = () => this.setState({ error: null })
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return this.props.fallback ? this.props.fallback(error, this.retry) : <GuardNote name={this.props.name} error={error} retry={this.retry} />
  }
}

/** A Guard's own fallback: what failed, and Try again. */
export function GuardNote({ name, error, retry }: { name: string; error: Error; retry: () => void }) {
  return (
    <div className="sb-note bad sb-guard" role="alert">
      <span>
        Something went wrong showing {name}. <span className="sb-guard-why">{error.message}</span>
      </span>
      <button className="sb-btn sm" onClick={retry}>
        Try again
      </button>
    </div>
  )
}
