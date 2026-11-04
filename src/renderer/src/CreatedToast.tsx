// A card that slides up at the bottom of the window when an agent makes a workspace: its name, a
// button to go there, and a close button with a ring that runs down the time until the card goes.
// Hovering it stops the clock. Several stack, each with its own time.
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { WorkspaceInfo } from '@shared/types'
import { WorkspaceIcon } from './WorkspaceIcon'

export interface Created {
  workspace: string
  name: string
}

/** How long a card stays. */
export const CREATED_MS = 8000
/** How long it takes to slide away; host.css, .h-created.leaving. */
const LEAVE_MS = 260

export function CreatedToasts({ items, workspaces, floating, onGo, onDone }: { items: Created[]; workspaces: WorkspaceInfo[]; /** The agent floats, its bar along the bottom: the cards sit above it. */ floating?: boolean; onGo: (id: string) => void; onDone: (id: string) => void }) {
  if (!items.length) return null
  return (
    <div className={`h-created-stack${floating ? ' above-bar' : ''}`} aria-live="polite">
      {items.map((c) => (
        <CreatedToast key={c.workspace} created={c} ws={workspaces.find((w) => w.id === c.workspace)} onGo={() => onGo(c.workspace)} onDone={() => onDone(c.workspace)} />
      ))}
    </div>
  )
}

function CreatedToast({ created, ws, onGo, onDone }: { created: Created; ws?: WorkspaceInfo; onGo: () => void; onDone: () => void }) {
  const [left, setLeft] = useState(CREATED_MS)
  const [held, setHeld] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const done = useRef(onDone)
  done.current = onDone
  // It slides away, then goes.
  const leave = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(() => done.current(), LEAVE_MS)
  }
  useEffect(() => {
    if (held || leaving) return
    let last = performance.now()
    const t = setInterval(() => {
      const now = performance.now()
      const gone = now - last
      last = now
      setLeft((l) => Math.max(0, l - gone))
    }, 100)
    return () => clearInterval(t)
  }, [held, leaving])
  useEffect(() => {
    if (left <= 0) leave()
  }, [left])
  const R = 12
  const round = 2 * Math.PI * R
  return (
    <div className={`h-created${leaving ? ' leaving' : ''}`} role="status" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}>
      <span className="h-created-icon">
        <WorkspaceIcon icon={ws?.icon} color={ws?.color} size={18} />
      </span>
      <span className="h-created-text">
        New workspace <b>{ws?.name ?? created.name}</b> created.
      </span>
      <button
        className="h-created-go"
        onClick={() => {
          onGo()
          leave()
        }}
      >
        Go to workspace
      </button>
      <button className="h-created-close" aria-label="Dismiss" title="Dismiss" onClick={leave}>
        <svg className="h-created-clock" width="28" height="28" viewBox="0 0 28 28" aria-hidden>
          <circle cx="14" cy="14" r={R} className="track" />
          <circle cx="14" cy="14" r={R} className="run" strokeDasharray={round} strokeDashoffset={round * (1 - left / CREATED_MS)} />
        </svg>
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  )
}
