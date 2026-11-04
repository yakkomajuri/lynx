import { useLayoutEffect, useReducer } from 'react'

// The sidebar and the agent panel docked beside the workspace share the window's width with it. Each, as it is dragged or drawn,
// takes only what the other leaves, so the workspace keeps a usable width and neither is pushed past the window's edge.

/** What the workspace keeps between the sidebar and the docked agent, with the window's insets around it. */
export const WORKSPACE_ROOM = 420

/** How wide something on screen is now: 0 when it is not there, or collapsed. */
const widthOf = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? 0

/** The sidebar's width, 0 when the workspaces are in the title bar or the sidebar is collapsed. */
export const sideWidth = () => widthOf('.h-side')

/** The docked agent panel's width, 0 when it is closed, floating or filling the window. */
export const dockedAgentWidth = () => widthOf('.h-agent:not(.floating):not(.full)')

const ROOM = 'sb-room'

/** Draws a width-limited panel again whenever the window, or the room the other panel takes, changes, and tells the other when
 *  this one's changes: as it appears or goes, and whenever `deps` (what its width follows) do. */
export function useRoom(deps: unknown[]) {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useLayoutEffect(() => {
    window.addEventListener('resize', redraw)
    window.addEventListener(ROOM, redraw)
    // Drawn before the other was on screen, it measured nothing there: once more, with the other in place.
    redraw()
    return () => {
      window.removeEventListener('resize', redraw)
      window.removeEventListener(ROOM, redraw)
      window.dispatchEvent(new Event(ROOM))
    }
  }, [])
  useLayoutEffect(() => void window.dispatchEvent(new Event(ROOM)), deps)
}
