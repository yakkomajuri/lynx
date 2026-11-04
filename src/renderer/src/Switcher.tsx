// The list of workspaces that opens from the title bar: under the carets beside a workspace's name,
// and under "Back to workspace" on every other page. A search field, the workspaces in their order
// (drag to rearrange), then a new workspace and the archive. A workspace can also open beside the one
// on screen: from its row's button, with ⌥-click, or dragged out of the list onto the window.
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Archive, Check, Columns2, Trash2 } from 'lucide-react'
import { Icon } from '@kit/icons'
import type { AppState, WorkspaceInfo } from '@shared/types'
import { Keys } from './CommandBar'
import { comboFor } from './keymap'
import { IconAction } from './IconAction'
import { Count } from './Notifications'
import { WorkspaceIcon } from './WorkspaceIcon'

const WIDTH = 300

/** Where the list goes for the button that opened it: under it and centred on it, kept on screen. */
export const under = (el: HTMLElement) => {
  const box = el.getBoundingClientRect()
  return { top: box.bottom + 6, left: Math.max(8, Math.min(box.left + box.width / 2 - WIDTH / 2, window.innerWidth - WIDTH - 8)) }
}

/** What a workspace dragged out of the list carries, so the window knows it is one. */
export const WORKSPACE_DRAG = 'application/x-lynx-workspace'

export function Switcher({ state, current, onScreen = [], at, unread, busy, onOpen, onBeside, onDragOut, onArchive, onDelete, onReorder, onNew, onArchived, onClose }: { state: AppState; /** The workspace on screen, if one is; both, when two are side by side (picking either then shows it alone). */ current?: string | string[]; /** Every workspace on screen: two when the window is split. */ onScreen?: string[]; at: { top: number; left: number }; unread: Record<string, number>; busy: Record<string, boolean>; onOpen: (id: string) => void; /** Opens a workspace beside the one on screen; absent where there is nothing to open beside. */ onBeside?: (id: string) => void; /** A workspace was picked up (its id) or put down (null): the window shows where it can go. */ onDragOut?: (id: string | null) => void; onArchive: (w: WorkspaceInfo) => void; onDelete: (w: WorkspaceInfo) => void; /** The ids of the workspaces that are not archived, in their new order. */ onReorder: (ids: string[]) => void; onNew: () => void; onArchived: () => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const active = state.workspaces.filter((w) => !w.archived)
  const archived = state.workspaces.length - active.length
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = active.filter((w) => words.every((x) => w.name.toLowerCase().includes(x)))
  // What the arrow keys move through: the workspaces, then the two rows under them.
  const rows = shown.length + 2
  const isCurrent = (id: string) => (Array.isArray(current) ? current.includes(id) : id === current)
  const [sel, setSel] = useState(() => Math.max(0, active.findIndex((w) => isCurrent(w.id))))
  const pick = Math.min(sel, rows - 1)
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' })
  }, [pick, q])
  // Escape closes it wherever the focus is: a row that was just archived takes the focus away with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // The row's own buttons leave the list open, with the keys still on the search field.
  const keep = (f: () => void) => () => {
    f()
    search.current?.focus()
  }

  // The row being dragged and where it would land. Only the whole list can be rearranged, not what a search left of it.
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

  const go = (f: () => void) => {
    onClose()
    f()
  }
  const run = (i: number, beside = false) => {
    const w = shown[i]
    if (w && beside && onBeside && !onScreen.includes(w.id)) go(() => onBeside(w.id))
    else if (w) go(() => (w.id === current ? undefined : onOpen(w.id)))
    else go(i === shown.length ? onNew : onArchived)
  }
  return (
    <>
      <div className="h-scrim" onClick={onClose} />
      <div className="h-menu h-switch-menu" role="dialog" aria-label="Switch workspace" style={{ top: at.top, left: at.left, width: WIDTH }}>
        <div className="h-switch-search">
          <Icon name="search" size={16} />
          <input
            ref={search}
            autoFocus
            type="search"
            value={q}
            placeholder="Search workspaces"
            aria-label="Search workspaces"
            spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((pick + (e.key === 'ArrowDown' ? 1 : rows - 1)) % rows)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(pick, e.altKey)
              }
            }}
          />
        </div>
        <div className="h-switch-list" ref={list}>
          {shown.map((w, i) => {
            const beside = onBeside && !onScreen.includes(w.id)
            return (
            <div
              key={w.id}
              className={`h-row${i === pick ? ' sel' : ''}${drag?.id === w.id ? ' dragging' : ''}${drag?.over === w.id && drag.id !== w.id ? (drag.after ? ' drop-after' : ' drop-before') : ''}`}
              // How many buttons the row shows under the pointer, for the room the name leaves them.
              style={{ '--acts': (beside ? 1 : 0) + (w.home ? 1 : 2) } as React.CSSProperties}
              draggable={!q}
              onMouseMove={() => setSel(i)}
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
                const box = e.currentTarget.getBoundingClientRect()
                const after = e.clientY > box.top + box.height / 2
                if (drag?.over !== w.id || drag.after !== after) setDrag({ id: dragged.current, over: w.id, after })
              }}
              onDrop={(e) => {
                e.preventDefault()
                const box = e.currentTarget.getBoundingClientRect()
                drop(w.id, e.clientY > box.top + box.height / 2)
              }}
              onDragEnd={() => {
                dragged.current = null
                setDrag(null)
                onDragOut?.(null)
              }}
            >
              <button className="h-item" tabIndex={-1} aria-current={isCurrent(w.id)} onClick={(e) => run(i, e.altKey)} title={w.description}>
                <span className="h-icon">
                  <WorkspaceIcon icon={w.icon} color={w.color} />
                </span>
                <span className="h-name">{w.name}</span>
                {busy[w.id] ? <i className="sb-dot live" /> : w.build.status === 'error' || w.build.runtimeError ? <i className="sb-dot bad" /> : null}
                <Count n={unread[w.id] ?? 0} />
                {isCurrent(w.id) ? <Check size={14} strokeWidth={2} /> : !q && i < 9 ? <Keys combo={comboFor(`workspace-${i + 1}`)} /> : null}
              </button>
              <span className="h-row-acts">
                {beside && (
                  <IconAction label={`Open ${w.name} beside`} onClick={() => run(i, true)}>
                    <Columns2 size={14} strokeWidth={1.7} />
                  </IconAction>
                )}
                <IconAction label={`Archive ${w.name}`} onClick={keep(() => onArchive(w))}>
                  <Archive size={14} strokeWidth={1.7} />
                </IconAction>
                {/* Home stays: it has no delete. */}
                {!w.home && (
                  <IconAction label={`Delete ${w.name}`} danger onClick={keep(() => onDelete(w))}>
                    <Trash2 size={14} strokeWidth={1.7} />
                  </IconAction>
                )}
              </span>
            </div>
            )
          })}
          {!shown.length && <div className="h-switch-none">{active.length ? `No workspace matches “${q}”` : 'No workspaces yet'}</div>}
        </div>
        <div className="h-switch-foot">
          <button className={`h-item new${pick === shown.length ? ' sel' : ''}`} tabIndex={-1} onMouseMove={() => setSel(shown.length)} onClick={() => run(shown.length)}>
            <span className="h-icon">
              <Icon name="plus" size={18} />
            </span>
            <span className="h-name">New workspace</span>
            <Keys combo={comboFor('new')} />
          </button>
          <button className={`h-item h-archived-link${pick === shown.length + 1 ? ' sel' : ''}`} tabIndex={-1} onMouseMove={() => setSel(shown.length + 1)} onClick={() => run(shown.length + 1)}>
            <span className="h-icon">
              <Archive size={16} strokeWidth={1.6} />
            </span>
            <span className="h-name">Archived workspaces</span>
            {archived > 0 && <span className="h-count">{archived}</span>}
          </button>
        </div>
      </div>
    </>
  )
}
