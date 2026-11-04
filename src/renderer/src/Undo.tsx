// A toast in the bottom right corner that offers to take back what was just done (archiving a workspace),
// with a ring that runs down the time left to take it back. Hovering it stops the clock.
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

export interface UndoOffer {
  id: number
  text: string
  undo: () => void
}

/** How long the offer stands. */
export const UNDO_MS = 8000

export function UndoToast({ offer, onDone }: { offer: UndoOffer; /** The offer is gone: taken, dismissed or run out. */ onDone: () => void }) {
  const [left, setLeft] = useState(UNDO_MS)
  const [held, setHeld] = useState(false)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (held) return
    let last = performance.now()
    const t = setInterval(() => {
      // Taken now: the update runs later, after last has moved on.
      const now = performance.now()
      const gone = now - last
      last = now
      setLeft((l) => Math.max(0, l - gone))
    }, 100)
    return () => clearInterval(t)
  }, [held])
  useEffect(() => {
    if (left <= 0) done.current()
  }, [left])
  const R = 7
  const round = 2 * Math.PI * R
  return (
    <div className="h-undo" role="status" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}>
      <svg className="h-undo-clock" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={R} className="track" />
        <circle cx="9" cy="9" r={R} className="run" strokeDasharray={round} strokeDashoffset={round * (1 - left / UNDO_MS)} />
      </svg>
      <span className="h-undo-text">{offer.text}</span>
      <button
        className="h-undo-btn"
        onClick={() => {
          offer.undo()
          onDone()
        }}
      >
        Undo
      </button>
      <span className="h-undo-left" aria-label="seconds left">
        {Math.ceil(left / 1000)}s
      </span>
      <button className="h-undo-close" aria-label="Dismiss" onClick={onDone}>
        <X size={13} strokeWidth={1.8} />
      </button>
    </div>
  )
}
