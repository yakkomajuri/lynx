// Signing in to an agent, from `/login` or a turn that failed for want of it: a card above the
// message box that does nothing until it is clicked. An agent the engine can sign in through the
// browser (Codex) gets a button that does it and says how it went; one that signs in on the
// command line (Claude Code) gets a button that opens Terminal, and a few words on what to do there.
import { useEffect, useState } from 'react'
import { harnessName, type Provider } from '@kit/agents'
import { call } from '@kit/core'
import { Icon } from '@kit/icons'
import { Button } from '@kit/ui'
import { bridge } from './api'
import { AgentMark } from './ComposerLine'

/** A path or argument as one shell word. */
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

export type SignInState = { at: 'idle' } | { at: 'starting' } | { at: 'waiting'; id: string } | { at: 'done' } | { at: 'failed'; error: string } | { at: 'opened' } | { at: 'copied'; command: string }

/**
 * Signing in to an agent, as the card here and the first-run screen do it: through the browser for
 * one the engine can sign in that way (Codex), else its own login command in Terminal (Claude Code).
 */
export function useAgentSignIn(provider: Provider) {
  const browser = provider.sign_in === 'browser'
  const [state, setState] = useState<SignInState>({ at: 'idle' })

  // A browser sign-in is asked after until it ends. The engine gives up on it after ten minutes.
  const waiting = state.at === 'waiting' ? state.id : null
  useEffect(() => {
    if (!waiting) return
    let gone = false
    const timer = setInterval(async () => {
      const s = await call<{ status: string; error?: string }>('agents', 'provider_sign_in_get', { id: waiting }).catch(() => null)
      if (gone || !s || s.status === 'pending') return
      setState(s.status === 'signed_in' ? { at: 'done' } : s.status === 'failed' ? { at: 'failed', error: s.error ?? 'The sign-in did not finish' } : { at: 'idle' })
    }, 1500)
    return () => {
      gone = true
      clearInterval(timer)
    }
  }, [waiting])

  const signIn = async () => {
    setState({ at: 'starting' })
    try {
      const started = await call<{ id: string; url: string }>('agents', 'provider_sign_in', { harness: provider.name })
      await bridge.openExternal(started.url)
      setState({ at: 'waiting', id: started.id })
    } catch (e) {
      setState({ at: 'failed', error: e instanceof Error ? e.message : String(e) })
    }
  }
  const cancel = () => {
    if (waiting) void call('agents', 'provider_sign_in_cancel', { id: waiting }).catch(() => {})
    setState({ at: 'idle' })
  }
  const openTerminal = async () => {
    try {
      await bridge.agentLogin(provider.name)
      setState({ at: 'opened' })
    } catch {
      // No Terminal: the command goes on the clipboard instead.
      const command = provider.login_command?.map(shellQuote).join(' ') ?? ''
      await navigator.clipboard.writeText(command).catch(() => {})
      setState({ at: 'copied', command })
    }
  }
  return { browser, state, signIn, cancel, openTerminal, waiting }
}

export function SignInCard({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const name = harnessName(provider.name)
  const { browser, state, signIn, cancel, openTerminal, waiting } = useAgentSignIn(provider)
  const close = () => {
    if (waiting) void call('agents', 'provider_sign_in_cancel', { id: waiting }).catch(() => {})
    onClose()
  }

  const line =
    state.at === 'waiting' ? 'Finish signing in in your browser…'
    : state.at === 'done' ? 'Send your message again.'
    : state.at === 'failed' ? state.error
    : state.at === 'opened' ? 'Sign in in Terminal, then send your message again.'
    : state.at === 'copied' ? `Could not open Terminal. Copied ${state.command}`
    : browser ? 'With your ChatGPT account, in the browser'
    : 'Signs in from Terminal'
  return (
    <div className={`sb-connect h-signin${state.at === 'done' ? ' connected' : ''}`} role="group" aria-label={`Sign in to ${name}`}>
      <div className="sb-connect-row">
        <span className="sb-connect-icon">
          <AgentMark harness={provider.name} size={18} />
          {state.at === 'done' && (
            <span className="sb-connect-ok">
              <Icon name="check" size={10} />
            </span>
          )}
        </span>
        <div className="sb-connect-text">
          <strong>{state.at === 'done' ? 'Signed in to' : 'Sign in to'} {name}</strong>
          <span className={state.at === 'failed' ? 'bad' : undefined}>{line}</span>
        </div>
        {browser ? (
          state.at === 'waiting' ? (
            <Button size="sm" onClick={cancel}>
              Cancel
            </Button>
          ) : state.at !== 'done' && (
            <Button variant="primary" size="sm" busy={state.at === 'starting'} onClick={() => void signIn()}>
              {state.at === 'failed' ? 'Try again' : 'Sign in'}
            </Button>
          )
        ) : (
          <Button variant="primary" size="sm" onClick={() => void openTerminal()}>
            <Icon name="terminal" size={14} />
            {state.at === 'opened' ? 'Open again' : 'Open in Terminal'}
          </Button>
        )}
        <button className="h-signin-x" onClick={close} aria-label="Close" title={state.at === 'waiting' ? 'Close and stop the sign-in' : 'Close'}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {!browser && (
        <details className="h-signin-how">
          <summary>Instructions</summary>
          <ol>
            <li>
              Terminal runs <code>{(provider.login_command ?? []).map((w, i) => (i ? w : w.split('/').pop())).join(' ')}</code>.
            </li>
            <li>Sign in in the browser it opens.</li>
            <li>Come back and send your message.</li>
          </ol>
        </details>
      )}
    </div>
  )
}
