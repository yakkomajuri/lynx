import { createRoot } from 'react-dom/client'
import '@kit/kit.css'
import '@kit/themes.css'
import './host.css'
import { Guard } from '@kit/guard'
import { DEFAULT_THEME } from '@shared/themes'
import { App } from './App'

// The theme as it was last time, so the window does not open in one and change to another.
document.documentElement.dataset.sbTheme = localStorage.getItem('sb.theme') ?? DEFAULT_THEME

// Every error React meets while drawing, with where: the window writes the page's errors to lynx.log.
const report = (how: string) => (error: unknown, info: { componentStack?: string }) =>
  console.error(`${how} while drawing: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n${(info.componentStack ?? '').split('\n').slice(0, 10).join('\n')}`)

createRoot(document.getElementById('root')!, { onCaughtError: report('caught'), onUncaughtError: report('uncaught') }).render(
  // The last resort, for an error no part of the window kept to itself: never a blank window.
  <Guard name="Lynx" fallback={(error) => <WindowFailed error={error} />}>
    <App />
  </Guard>,
)

function WindowFailed({ error }: { error: Error }) {
  return (
    <div className="sb-crash h-window-failed" role="alert">
      <strong>Lynx hit an error it could not recover from.</strong>
      <pre className="sb-code bad">{error.stack ?? error.message}</pre>
      <div className="sb-row">
        <button className="sb-btn primary" onClick={() => location.reload()}>
          Reload
        </button>
        <button className="sb-btn" onClick={() => void navigator.clipboard.writeText(`${error.stack ?? error.message}`)}>
          Copy the details
        </button>
      </div>
    </div>
  )
}
