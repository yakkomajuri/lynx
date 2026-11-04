// ⌘F over the workspace on screen: the browser's own find, kept to the workspace's frame. The bar is a page of its
// own over the window (src/main/find.ts), as a find would count the text typed in a field of this page. The rest of
// the window is made inert while each find runs, which the browser's find passes over, and back right after.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { FindColors } from '@shared/types'
import { bridge } from './api'

export interface FindHandle {
  /** Opens the bar, or gives it the keyboard back with its text selected. */
  open: () => void
  /** The next or previous match; opens the bar when it is closed. */
  step: (forward: boolean) => void
}

/** What sits over the window for a while (menus, dialogs, the command bar): the bar, being on top of the page, steps aside. */
const OVER = '[role="dialog"], [role="menu"], .h-menu, .sb-modal'

const frameOf = (workspace: string) => document.querySelector<HTMLIFrameElement>(`iframe.h-frame[data-workspace="${CSS.escape(workspace)}"]`)

/** Makes everything in the page inert but this element and what holds it, until the function it returns is called. */
function isolate(el: Element) {
  const made: HTMLElement[] = []
  const focused = document.activeElement
  for (let at = el; at.parentElement && at !== document.body; at = at.parentElement)
    for (const other of at.parentElement.children)
      if (other !== at && other instanceof HTMLElement && !other.inert) {
        other.inert = true
        made.push(other)
      }
  return () => {
    for (const e of made) e.inert = false
    // Whatever had the keyboard lost it on going inert: it has it back.
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true })
  }
}

/** The app theme's colours as they are now, worked out to values the bar's page can use. */
function colors(): FindColors {
  const probe = document.createElement('div')
  probe.style.display = 'none'
  document.body.append(probe)
  const read = (name: string, prop = 'color') => {
    probe.style.setProperty(prop, `var(${name})`)
    return getComputedStyle(probe).getPropertyValue(prop)
  }
  const c: FindColors = {
    scheme: getComputedStyle(document.documentElement).getPropertyValue('--sb-dark').trim() === '1' ? 'dark' : 'light',
    surface: read('--sb-surface'),
    text: read('--sb-text'),
    muted: read('--sb-muted'),
    line: read('--sb-line'),
    hover: read('--sb-hover'),
    shadow: read('--sb-shadow', 'box-shadow'),
  }
  probe.remove()
  return c
}

type Req = { text: string; step?: boolean; forward?: boolean }

/** Finds in `workspace`, the one on screen (or the focused one of two); none closes the bar. Draws nothing in this page. */
export const FindInPage = forwardRef<FindHandle, { workspace: string | null }>(function FindInPage({ workspace }, ref) {
  // The workspace the bar is open over.
  const [open, setOpen] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  // The text in the bar, kept after it closes for the next time it opens.
  const text = useRef('')
  const queue = useRef<Req[]>([])
  const running = useRef(false)

  // One find at a time, each with the rest of the window inert until its matches are counted. New text drops what was waiting.
  const run = (req: Req) => {
    if (!req.step) queue.current = []
    queue.current.push(req)
    void pump()
  }
  const pump = async () => {
    if (running.current) return
    running.current = true
    try {
      for (let req = queue.current.shift(); req; req = queue.current.shift()) {
        const el = openRef.current && frameOf(openRef.current)
        if (!el) break
        const undo = isolate(el)
        try {
          await bridge.find(req)
        } catch (e) {
          console.warn('[find]', e)
        } finally {
          undo()
        }
      }
    } finally {
      queue.current = []
      running.current = false
    }
  }
  const place = (on: string, focus: boolean) => {
    const el = frameOf(on)
    // Not for a bar closed meanwhile (a resize can land after it closes), nor over a frame that is hidden.
    if (!el || openRef.current !== on || !el.getClientRects().length) return
    const r = el.getBoundingClientRect()
    void bridge.placeFind({ frame: { x: r.x, y: r.y, width: r.width, height: r.height }, colors: colors(), focus, text: focus ? text.current : undefined })
  }
  /** Closes the bar; closed by the user, the keyboard goes back to the workspace. */
  const close = (refocus = false) => {
    const was = openRef.current
    if (!was) return
    openRef.current = null
    setOpen(null)
    queue.current = []
    void bridge.stopFind().then(() => refocus && frameOf(was)?.focus())
  }
  const show = () => {
    if (!workspace) return
    const again = openRef.current === workspace
    openRef.current = workspace
    setOpen(workspace)
    place(workspace, true)
    if (!again && text.current) run({ text: text.current })
  }
  useImperativeHandle(ref, () => ({ open: show, step: (forward) => (openRef.current && text.current ? run({ text: text.current, step: true, forward }) : show()) }))

  // What the bar says: its text, a step, or closing.
  useEffect(
    () =>
      bridge.onEvent((e) => {
        if (!openRef.current) return
        if (e.t === 'find') run({ text: (text.current = e.text) })
        else if (e.t === 'find-step') text.current && run({ text: text.current, step: true, forward: e.forward })
        else if (e.t === 'find-close') close(true)
      }),
    [],
  )

  // Another workspace on screen, or none to find in: the bar closes.
  useEffect(() => {
    if (open && open !== workspace) close()
  }, [workspace, open])

  // While open, the bar follows its frame around, steps aside for whatever comes over the window, and wears the theme.
  useEffect(() => {
    if (!open) return
    const el = frameOf(open)
    if (!el) return
    let covered = false
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        covered = !!document.querySelector(OVER)
        if (covered) void bridge.placeFind(null)
        else place(open, false)
      })
    }
    // Only when it changes: the page changes all the time (an agent writing, say).
    const watch = () => {
      if (!!document.querySelector(OVER) !== covered) update()
    }
    const sizes = new ResizeObserver(update)
    sizes.observe(el)
    const page = new MutationObserver(watch)
    page.observe(document.body, { childList: true, subtree: true })
    const theme = new MutationObserver(update)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sb-theme'] })
    const scheme = matchMedia('(prefers-color-scheme: dark)')
    window.addEventListener('resize', update)
    scheme.addEventListener('change', update)
    return () => {
      cancelAnimationFrame(frame)
      sizes.disconnect()
      page.disconnect()
      theme.disconnect()
      window.removeEventListener('resize', update)
      scheme.removeEventListener('change', update)
    }
  }, [open])

  return null
})
