// Point-and-tell mode. The host window turns it on; this runs inside the workspace frame. While
// it is on, the page stops reacting to the mouse: hovering outlines an element and clicking one picks
// it. The pick and where it sits are posted to the host, which draws the note box over the frame, in
// its own window: workspace code shares this page, so nothing typed or ticked here could be told
// from what that code fakes. Here are only the outline and the numbered markers.
// Plain DOM in a shadow root: it must keep working whatever the workspace's React and CSS do.
import { getTransport } from './core'

export interface Pointed {
  id: string
  /** What the user wrote about the element; empty when they only pointed at it. */
  note: string
  tag: string
  classes: string
  text: string
  selector: string
  /** React components around the element, outermost first. */
  components: string[]
  label?: string
}

/** What a note can @ mention, sent by the host with its icon drawn: an SVG of its own, or a site's icon. */
export interface PointMention {
  kind: 'workspace' | 'connector'
  id: string
  name: string
  svg?: string
  img?: string
}

const STYLE = `
:host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font: 13px/1.4 var(--sb-font, system-ui, sans-serif); }
* { box-sizing: border-box; }
.box { position: fixed; border: 1.5px solid var(--sb-blue, #2563eb); background: color-mix(in srgb, var(--sb-blue, #2563eb) 9%, transparent); border-radius: 4px; }
.tag { position: fixed; font-size: 11px; font-weight: 500; line-height: 1; color: #fff; background: var(--sb-blue, #2563eb); padding: 4px 6px; border-radius: 4px; white-space: nowrap; max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
.mark { position: fixed; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: var(--sb-blue, #2563eb); color: #fff; font-size: 11px; font-weight: 600; line-height: 20px; text-align: center; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); }
`

export function components(el: Element): string[] {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  const out: string[] = []
  for (let f: any = key ? (el as any)[key] : null; f; f = f.return) {
    const t = f.type
    const name = typeof t === 'function' ? t.displayName || t.name : t && typeof t === 'object' ? t.displayName || t.render?.name : null
    if (name && name !== 'Boundary' && out[out.length - 1] !== name) out.push(name)
  }
  return out.slice(0, 6).reverse()
}

export function selector(el: Element): string {
  const parts: string[] = []
  for (let e: Element | null = el; e && e !== document.body && parts.length < 5; e = e.parentElement) {
    if (e.id && e.id !== 'root') {
      parts.unshift(`#${CSS.escape(e.id)}`)
      break
    }
    const tag = e.tagName.toLowerCase()
    const cls = [...e.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('')
    const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e!.tagName) : []
    parts.unshift(tag + cls + (same.length > 1 ? `:nth-of-type(${same.indexOf(e) + 1})` : ''))
  }
  return parts.join(' > ')
}

export const describe = (el: Element): Omit<Pointed, 'id' | 'note'> => ({
  tag: el.tagName.toLowerCase(),
  classes: typeof el.className === 'string' ? el.className.trim() : '',
  text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
  selector: selector(el),
  components: components(el),
  label: el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('placeholder') ?? undefined,
})

const name = (el: Element) => {
  const c = components(el).at(-1)
  const cls = typeof el.className === 'string' && el.classList[0] ? `.${el.classList[0]}` : ''
  return `${c ? `${c} · ` : ''}${el.tagName.toLowerCase()}${cls}`
}

export function installAnnotate() {
  const t = getTransport()
  let on = false
  let seq = 0
  let hover: Element | null = null
  let popFor: Element | null = null
  let raf = 0
  const marks = new Map<string, { el: Element; dot: HTMLElement }>()
  // Notes made before the last reload: their elements are looked up again by selector.
  let lost: { id: string; selector: string; n: number }[] = []

  const host = document.createElement('div')
  host.id = 'sb-annotate'
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = STYLE
  const box = document.createElement('div')
  box.className = 'box'
  const tag = document.createElement('div')
  tag.className = 'tag'
  root.append(style, box, tag)

  const mine = (e: Event) => e.composedPath().includes(host)
  const place = (node: HTMLElement, x: number, y: number) => {
    node.style.left = `${Math.round(x)}px`
    node.style.top = `${Math.round(y)}px`
  }

  const frame = () => {
    raf = on ? requestAnimationFrame(frame) : 0
    const target = popFor ?? hover
    const show = !!target && target.isConnected
    box.style.display = tag.style.display = show ? '' : 'none'
    if (show) {
      const r = target!.getBoundingClientRect()
      place(box, r.left - 2, r.top - 2)
      box.style.width = `${r.width + 4}px`
      box.style.height = `${r.height + 4}px`
      tag.textContent = name(target!)
      place(tag, Math.max(4, r.left - 2), r.top > 28 ? r.top - 24 : r.bottom + 6)
    }
    if (popFor) {
      const at = JSON.stringify(popFor.isConnected ? rectOf(popFor) : null)
      if (at !== lastAt) {
        lastAt = at
        if (popFor.isConnected) t.post('annotate-at', { rect: rectOf(popFor) })
        else closePop(true)
      }
    }
    lost = lost.filter((l) => {
      const el = document.querySelector(l.selector)
      if (el) mark(l.id, el).textContent = String(l.n)
      return !el
    })
    for (const m of marks.values()) {
      m.dot.style.display = m.el.isConnected && m.dot.textContent ? '' : 'none'
      const r = m.el.getBoundingClientRect()
      place(m.dot, r.right - 10, r.top - 10)
    }
  }

  const mark = (id: string, el: Element) => {
    const dot = document.createElement('div')
    dot.className = 'mark'
    root.append(dot)
    marks.set(id, { el, dot })
    return dot
  }

  // The element the host's note box is open for: its outline stays, and the host hears where it is as it moves.
  // Picks wait in `picked` until the host lists them, to put their marker on that very element.
  const picked = new Map<string, Element>()
  let lastAt = ''
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }
  const closePop = (tell = false) => {
    if (popFor && tell) t.post('annotate-close')
    popFor = null
    lastAt = ''
  }
  const openPop = (el: Element) => {
    popFor = el
    const id = `p${Date.now().toString(36)}${++seq}`
    picked.clear()
    picked.set(id, el)
    const rect = rectOf(el)
    lastAt = JSON.stringify(rect)
    t.post('annotate-pick', { item: { id, ...describe(el) }, what: name(el), rect })
  }

  const swallow = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  }
  const target = (e: Event) => {
    const el = e.target instanceof Element ? e.target : null
    return el && el !== document.documentElement && el !== document.body && el.id !== 'root' ? el : null
  }
  // Pointer events, not mouse events: swallowing pointerdown stops the browser sending mouse moves during a drag.
  // Dragging from one element to another picks whatever holds both. The outline follows the drag,
  // so what will be picked is on screen before the button is released.
  let from: { el: Element; x: number; y: number } | null = null
  const drop = () => {
    from = null
  }
  const onMove = (e: MouseEvent) => {
    if (mine(e)) return
    const el = target(e)
    if (!from || !(e.buttons & 1)) {
      drop()
      hover = el
      return
    }
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < 5) return
    let both: Element | null = from.el
    while (both && el && !both.contains(el)) both = both.parentElement
    hover = both && el && both !== document.documentElement && both !== document.body && both.id !== 'root' ? both : null
  }
  const onPress = (e: Event) => {
    if (mine(e)) return
    swallow(e)
    const el = target(e)
    if (e.type === 'pointerdown' && el && (e as MouseEvent).button === 0) from = { el, x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY }
    else if (e.type === 'pointerup' || e.type === 'click') drop()
    if (el && e.type === 'click') openPop(el)
  }
  const onKey = (e: KeyboardEvent) => {
    if (mine(e)) return
    if (e.key === 'Escape') {
      swallow(e)
      if (popFor) closePop(true)
      else t.post('annotate-exit')
    }
  }
  const PRESS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu'] as const

  const set = (next: boolean) => {
    if (next === on) return
    on = next
    if (on) {
      document.documentElement.append(host)
      window.addEventListener('pointermove', onMove, true)
      PRESS.forEach((p) => window.addEventListener(p, onPress, true))
      window.addEventListener('keydown', onKey, true)
      raf = requestAnimationFrame(frame)
    } else {
      closePop()
      drop()
      hover = null
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove, true)
      PRESS.forEach((p) => window.removeEventListener(p, onPress, true))
      window.removeEventListener('keydown', onKey, true)
      host.remove()
    }
    document.documentElement.style.cursor = on ? 'crosshair' : ''
  }

  window.addEventListener('message', (e) => {
    const m = e.data
    if (e.source !== window.parent || !m || m.sb !== 1) return
    if (m.type === 'annotate') set(!!m.on)
    // The host's note box closed: added, or put away.
    else if (m.type === 'annotate-close') closePop()
    else if (m.type === 'annotate-sync') {
      // The host owns the list; markers follow it, numbered in its order.
      const ids: string[] = Array.isArray(m.ids) ? m.ids : []
      for (const [id, el] of picked)
        if (ids.includes(id)) {
          if (!marks.has(id)) mark(id, el)
          picked.delete(id)
        }
      for (const [id, m2] of marks) {
        const n = ids.indexOf(id)
        if (n < 0) {
          m2.dot.remove()
          marks.delete(id)
        } else m2.dot.textContent = String(n + 1)
      }
      const here: { id: string; selector: string }[] = Array.isArray(m.here) ? m.here : []
      lost = here.filter((h) => !marks.has(h.id)).map((h) => ({ ...h, n: ids.indexOf(h.id) + 1 }))
    }
  })
}
