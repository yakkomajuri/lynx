// `import { … } from 'lynx'` in workspace code resolves here.
import { Component, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { installAnnotate } from './annotate'
import { installBusy } from './busy'
import { keepHistory } from './router'
import { installSpotlight } from './spotlight'
import { askAgent, getTransport } from './core'
import { comboOf, sameCombo, type Combo } from './keys'
import './kit.css'
import './workspace.css'
// After the workspace look: only Home wears a theme (data-sb-theme on its page), and the theme's tokens must win there.
import './themes.css'

export * from './core'
export * from './agents'
export { AgentTask } from './agentTask'
export * from './ui'
export * from './chat'
export * from './router'
export * from './mcpui'
export * from './icons'
export { highlight, splitFences } from './highlight'
export { useBusy } from './busy'

const describe = (e: unknown) => (e instanceof Error ? `${e.message}\n${(e.stack ?? '').split('\n').slice(1, 6).join('\n')}` : String(e))

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    getTransport().post('error', { error: `${error.message}\n${(info.componentStack ?? '').split('\n').slice(0, 8).join('\n')}` })
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="sb-crash">
        <strong>This workspace hit an error while rendering</strong>
        <pre className="sb-code bad">{error.message}</pre>
        <div className="sb-row">
          <button className="sb-btn primary" onClick={() => askAgent(`The workspace UI crashed while rendering with this error. Fix it.\n\n${describe(error)}`)}>
            Ask the agent to fix it
          </button>
          <button className="sb-btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}

/** Called by the generated entry point with the workspace's default export. */
export function mount(App: ComponentType) {
  const t = getTransport()
  window.addEventListener('error', (e) => t.post('error', { error: describe(e.error ?? e.message) }))
  window.addEventListener('unhandledrejection', (e) => t.post('warning', { error: describe(e.reason) }))
  // Links leave the app; the app's shortcuts (⌘K, ⌘D, …) work even while focus is inside the frame.
  window.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (a && /^https?:/.test(a.href)) {
      e.preventDefault()
      t.post('open-external', { url: a.href })
    }
  })
  // The host cannot see clicks in here; with two workspaces side by side, this tells it which one is in use.
  // `press`: the user's own, not the page taking the keyboard by itself.
  window.addEventListener('pointerdown', () => t.post('pointer', { how: 'press' }), true)
  window.addEventListener('focus', () => t.post('pointer', {}))
  // The app's shortcuts go to the window, whichever keys they have: it says which once the page is up, and again when they change.
  let bound: Combo[] = []
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && e.data?.sb === 1 && e.data.type === 'shortcuts' && Array.isArray(e.data.combos)) bound = e.data.combos
  })
  window.addEventListener('keydown', (e) => {
    const combo = comboOf(e)
    if (!combo || !bound.some((b) => sameCombo(b, combo))) return
    e.preventDefault()
    t.post('shortcut', { combo })
  })
  installAnnotate()
  installBusy(t.post)
  keepHistory()
  installSpotlight()
  if (typeof App !== 'function') {
    t.post('error', { error: 'App.jsx must default-export a React component' })
    return
  }
  createRoot(document.getElementById('root')!).render(
    <Boundary>
      <App />
    </Boundary>,
  )
  t.post('ready')
}
