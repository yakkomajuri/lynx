// The list of workspaces as a column down the left, for those who chose it in Appearance over the list
// under the title bar's carets. Under Go to…, the workspaces in their order (drag to rearrange, or out onto
// the window to open beside), a new workspace and the archive. Near the foot, by name, what the title bar
// has at its end otherwise: the running agents, notifications and settings. Its right edge drags to make it wider or narrower.
import { useRef, useState } from 'react'
import type React from 'react'
import { Archive, Bell, Columns2, Search, Settings as Gear, Trash2 } from 'lucide-react'
import { Icon } from '@kit/icons'
import type { AppState, WorkspaceInfo } from '@shared/types'
import { Keys, titled } from './CommandBar'
import { comboFor } from './keymap'
import { IconAction } from './IconAction'
import { Count } from './Notifications'
import { WORKSPACE_DRAG } from './Switcher'
import { WorkspaceIcon } from './WorkspaceIcon'
import { dockedAgentWidth, useRoom, WORKSPACE_ROOM } from './room'

const WIDTH = 'sb.side.width'
const WIDE = 232
const NARROWEST = 180
// Narrow enough to leave the names a little room; no wider than 480, half the window, or what the docked agent leaves the workspace.
const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, NARROWEST), Math.max(NARROWEST, Math.min(480, window.innerWidth / 2, window.innerWidth - dockedAgentWidth() - WORKSPACE_ROOM))))

export function Sidebar({ state, onScreen, page, unread, busy, onOpen, onBeside, onDragOut, onArchive, onDelete, onReorder, onNew, onArchived, onFind, running, unreadAll, notifications, onNotifications, settings, onSettings, hidden }: { state: AppState; /** The workspaces on screen: two when the window is split. */ onScreen: string[]; /** The app's own page on screen, when it is not a workspace. */ page?: 'marketplace' | 'archived'; unread: Record<string, number>; busy: Record<string, boolean>; onOpen: (id: string) => void; /** Opens a workspace beside the one on screen; absent where there is nothing to open beside. */ onBeside?: (id: string) => void; /** A workspace was picked up (its id) or put down (null): the window shows where it can go. */ onDragOut?: (id: string | null) => void; onArchive: (w: WorkspaceInfo) => void; onDelete: (w: WorkspaceInfo) => void; /** The ids of the workspaces that are not archived, in their new order. */ onReorder: (ids: string[]) => void; onNew: () => void; onArchived: () => void; /** Opens the command bar. */ onFind: () => void; /** The agents running, as a row (Running.tsx). */ running: React.ReactNode; unreadAll: number; /** The notifications drawer is open. */ notifications: boolean; onNotifications: () => void; /** Settings are open. */ settings: boolean; onSettings: () => void; /** Collapsed (⌘B, or the button by the window's buttons): out of the way, and out of reach of the keyboard. */ hidden?: boolean }) {
  const active = state.workspaces.filter((w) => !w.archived)
  const archived = state.workspaces.length - active.length
  // The row being dragged and where it would land.
  const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null)
  const dragged = useRef<string | null>(null)
  // Where it lands is read from the drop itself: the line drawn while dragging may be a render behind.
  const drop = (over: string, after: boolean) => {
    const id = dragged.current
    dragged.current = null
    setDrag(null)
    if (!id || over === id) return
    const ids = active.map((w) => w.id).filter((x) => x !== id)
    ids.splice(ids.indexOf(over) + (after ? 1 : 0), 0, id)
    if (ids.join() !== active.map((w) => w.id).join()) onReorder(ids)
  }
  // The width is the same for every window and workspace, kept from one launch to the next.
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH)) || WIDE)
  // While the edge is dragged: where the pointer would be at no width, so the edge stays under it rather than jumping to it.
  const [sizing, setSizing] = useState<number | null>(null)
  // Drawn again as the window or the docked agent changes, it takes only the room there is.
  useRoom([width, hidden])
  const startSizing = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    // The second press of a double-click puts the width back.
    if (e.detail >= 2) return localStorage.removeItem(WIDTH), setWidth(WIDE)
    setSizing(e.clientX - e.currentTarget.parentElement!.getBoundingClientRect().width)
  }
  const size = (e: React.PointerEvent) => {
    if (sizing === null) return
    const w = clampWidth(e.clientX - sizing)
    localStorage.setItem(WIDTH, String(w))
    setWidth(w)
  }
  const half = (e: React.DragEvent) => {
    const box = e.currentTarget.getBoundingClientRect()
    return e.clientY > box.top + box.height / 2
  }
  return (
    <aside className={`h-side${hidden ? ' gone' : ''}`} aria-label="Workspaces" inert={hidden} style={{ width: clampWidth(width) }}>
      {/* Room for the window's buttons, and a place to drag the window by. */}
      <div className="h-side-top h-drag" />
      <button className="h-item h-side-find" onClick={onFind} title={titled('Go anywhere', comboFor('command-bar'))}>
        <span className="h-icon">
          <Search size={16} strokeWidth={1.7} />
        </span>
        <span className="h-name">Go to…</span>
        <Keys combo={comboFor('command-bar')} />
      </button>
      <div className="h-label">Workspaces</div>
      <nav className="h-side-list">
        {active.map((w, i) => {
          const beside = onBeside && !onScreen.includes(w.id)
          const here = onScreen.includes(w.id)
          return (
            <div
              key={w.id}
              className={`h-row${drag?.id === w.id ? ' dragging' : ''}${drag?.over === w.id && drag.id !== w.id ? (drag.after ? ' drop-after' : ' drop-before') : ''}`}
              // How many buttons the row shows under the pointer, for the room the name leaves them.
              style={{ '--acts': (beside ? 1 : 0) + (w.home ? 1 : 2) } as React.CSSProperties}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', w.name)
                e.dataTransfer.setData(WORKSPACE_DRAG, w.id)
                dragged.current = w.id
                setDrag({ id: w.id })
                onDragOut?.(w.id)
              }}
              onDragOver={(e) => {
                if (!dragged.current) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const after = half(e)
                if (drag?.over !== w.id || drag.after !== after) setDrag({ id: dragged.current, over: w.id, after })
              }}
              onDrop={(e) => {
                e.preventDefault()
                drop(w.id, half(e))
              }}
              onDragEnd={() => {
                dragged.current = null
                setDrag(null)
                onDragOut?.(null)
              }}
            >
              {/* ⌥-click opens it beside the one on screen. */}
              <button className={`h-item${here ? ' on' : ''}`} aria-current={here ? 'page' : undefined} onClick={(e) => (e.altKey && beside ? onBeside(w.id) : onOpen(w.id))} title={titled(w.description || w.name, i < 9 ? comboFor(`workspace-${i + 1}`) : undefined)}>
                <span className="h-icon">
                  <WorkspaceIcon icon={w.icon} color={w.color} />
                </span>
                <span className="h-name">{w.name}</span>
                {busy[w.id] ? <i className="sb-dot live" /> : w.build.status === 'error' || w.build.runtimeError ? <i className="sb-dot bad" /> : null}
                <Count n={unread[w.id] ?? 0} />
              </button>
              <span className="h-row-acts">
                {beside && (
                  <IconAction label={`Open ${w.name} beside`} onClick={() => onBeside(w.id)}>
                    <Columns2 size={14} strokeWidth={1.7} />
                  </IconAction>
                )}
                <IconAction label={`Archive ${w.name}`} onClick={() => onArchive(w)}>
                  <Archive size={14} strokeWidth={1.7} />
                </IconAction>
                {/* Home stays: it has no delete. */}
                {!w.home && (
                  <IconAction label={`Delete ${w.name}`} danger onClick={() => onDelete(w)}>
                    <Trash2 size={14} strokeWidth={1.7} />
                  </IconAction>
                )}
              </span>
            </div>
          )
        })}
        <button className={`h-item new${page === 'marketplace' ? ' on' : ''}`} onClick={onNew} title={titled('New workspace', comboFor('new'))}>
          <span className="h-icon">
            <Icon name="plus" size={18} />
          </span>
          <span className="h-name">New workspace</span>
        </button>
        {archived > 0 && (
          <button className={`h-item h-archived-link${page === 'archived' ? ' on' : ''}`} onClick={onArchived}>
            <span className="h-icon">
              <Archive size={16} strokeWidth={1.6} />
            </span>
            <span className="h-name">Archived</span>
            <span className="h-count">{archived}</span>
          </button>
        )}
      </nav>
      <div className="h-side-foot">
        {running}
        <button className={`h-item${notifications ? ' on' : ''}`} onClick={onNotifications} aria-label={unreadAll ? `Notifications, ${unreadAll} unread` : 'Notifications'}>
          <span className="h-icon">
            <Bell size={16} strokeWidth={1.7} />
          </span>
          <span className="h-name">Notifications</span>
          <Count n={unreadAll} />
        </button>
        <button className={`h-item${settings ? ' on' : ''}`} onClick={onSettings} title={titled('Settings', comboFor('settings'))}>
          <span className="h-icon">
            <Gear size={16} strokeWidth={1.7} />
          </span>
          <span className="h-name">Settings</span>
          <Keys combo={comboFor('settings')} />
        </button>
      </div>
      <div className="h-side-resize" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" title="Drag to resize. Double-click to reset." onMouseDown={startSizing} />
      {/* While dragging, a sheet over the whole window keeps the pointer from falling into a frame. */}
      {sizing !== null && <div className="h-resize-sheet" onPointerMove={size} onPointerUp={() => setSizing(null)} onPointerLeave={() => setSizing(null)} />}
    </aside>
  )
}
