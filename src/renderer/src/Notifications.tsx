// The notifications drawer: what tools, agents and workspaces had to say while you were
// elsewhere, newest first. Clicking one goes to the page it is about.
import { useEffect, useState } from 'react'
import { Icon } from '@kit/icons'
import { rel } from '@kit/ui'
import type { AppNotification, AppState } from '@shared/types'
import { app } from './api'
import { who } from './Runs'
import { WorkspaceIcon } from './WorkspaceIcon'

/** Unread notifications per workspace id. */
export const unreadBy = (state: AppState) => {
  const out: Record<string, number> = {}
  for (const n of state.notifications) if (!n.read) out[n.workspace] = (out[n.workspace] ?? 0) + 1
  return out
}
/** A count as a badge shows it: nothing for zero, 99+ past that. */
export const Count = ({ n, title }: { n: number; title?: string }) =>
  n > 0 ? (
    <span className="h-unread" title={title ?? `${n} unread ${n === 1 ? 'notification' : 'notifications'}`}>
      {n > 99 ? '99+' : n}
    </span>
  ) : null

export function NotificationsDrawer({ state, only, onClose, onGo, onError }: { state: AppState; /** Start filtered to this workspace. */ only?: string; onClose: () => void; onGo: (n: AppNotification) => void; onError: (e: unknown) => void }) {
  const [scope, setScope] = useState<string | null>(only ?? null)
  const act = (f: () => Promise<unknown>) => void f().catch(onError)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const scoped = scope ? state.workspaces.find((w) => w.id === scope) : undefined
  const shown = state.notifications.filter((n) => !scoped || n.workspace === scoped.id)
  const unread = shown.filter((n) => !n.read).length
  const which = scoped ? { workspace: scoped.id } : {}
  return (
    <>
      <div className="h-scrim h-drawer-scrim" onClick={onClose} />
      <aside className="h-drawer" role="dialog" aria-label="Notifications">
        <header className="h-drawer-head">
          <strong>Notifications</strong>
          {scoped && (
            <button className="h-drawer-scope" onClick={() => setScope(null)} title="Show every workspace">
              <span>{scoped.name}</span>
              <Icon name="x" size={12} />
            </button>
          )}
          <span className="sb-row" style={{ marginLeft: 'auto', gap: 2 }}>
            {unread > 0 && (
              <button className="sb-btn sm ghost" onClick={() => act(() => app('notification_read', which))}>
                Mark all read
              </button>
            )}
            {shown.length > 0 && (
              <button className="sb-btn sm ghost" onClick={() => confirm(`Remove ${shown.length === 1 ? 'this notification' : `these ${shown.length} notifications`}?`) && act(() => app('notification_delete', which))}>
                Clear
              </button>
            )}
            <button className="sb-btn sm ghost" style={{ width: 30, padding: 0 }} onClick={onClose} aria-label="Close notifications">
              <Icon name="x" size={16} />
            </button>
          </span>
        </header>
        <div className="h-drawer-list">
          {shown.map((n) => {
            const w = state.workspaces.find((x) => x.id === n.workspace)
            return (
              <div key={n.id} className={`h-notification${n.read ? '' : ' unread'}`}>
                <button
                  className="h-notification-main"
                  onClick={() => {
                    if (!n.read) act(() => app('notification_read', { id: n.id }))
                    onGo(n)
                  }}
                  title={n.link ? (/^https?:/i.test(n.link) ? `Opens ${n.link}` : `Opens ${w?.name ?? n.workspace} at ${n.link}`) : `Opens ${w?.name ?? n.workspace}`}
                >
                  <span className="h-icon">
                    <WorkspaceIcon icon={w?.icon} color={w?.color} />
                  </span>
                  <span className="h-notification-text">
                    <span>{n.text}</span>
                    <small>
                      {w?.name ?? n.workspace} · {rel(n.at)} · from {who(n.by)}
                      {n.link ? ` · ${/^https?:/i.test(n.link) ? n.link.replace(/^https?:\/\//i, '').split('/')[0] : n.link}` : ''}
                    </small>
                  </span>
                  {!n.read && <i className="sb-dot accent" aria-label="Unread" />}
                </button>
                <button className="h-notification-x" onClick={() => act(() => app('notification_delete', { id: n.id }))} aria-label="Remove" title="Remove">
                  <Icon name="x" size={14} />
                </button>
              </div>
            )
          })}
          {!shown.length && (
            <div className="sb-empty">
              <strong>{scoped ? `Nothing from ${scoped.name}` : 'No notifications'}</strong>
              <p>Tools, schedules and agents can send one about a workspace with notification_send, with a link to the page it concerns.</p>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
