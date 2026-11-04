// The agent pointing back. Point mode is the user showing the agent something; this is the agent
// showing the user: it finds elements on the running page and outlines one (or a few, numbered)
// with a question such as "This card?", so the user can say yes or which. The host asks; this
// runs inside the workspace frame and answers with `ui-result`.
// Plain DOM in a shadow root, like Point: it must keep working whatever the workspace's code does.
import { components, describe } from './annotate'
import { getTransport } from './core'

const STYLE = `
:host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; font: 13px/1.4 var(--sb-font, system-ui, sans-serif); }
* { box-sizing: border-box; }
.box { position: fixed; border: 2px solid var(--sb-blue, #2563eb); background: color-mix(in srgb, var(--sb-blue, #2563eb) 10%, transparent); border-radius: 6px; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--sb-blue, #2563eb) 45%, transparent); } 50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--sb-blue, #2563eb) 0%, transparent); } }
.ask { position: fixed; font-size: 13px; font-weight: 600; line-height: 1; color: #fff; background: var(--sb-blue, #2563eb); padding: 7px 11px; border-radius: 999px; white-space: nowrap; max-width: min(70vw, 420px); overflow: hidden; text-overflow: ellipsis; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); }
.n { position: fixed; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: var(--sb-blue, #2563eb); color: #fff; font-size: 12px; font-weight: 700; line-height: 22px; text-align: center; box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(0, 0, 0, 0.3); }
@media (prefers-reduced-motion: reduce) { .box { animation: none; } }
`

/** What an element is, for the agent: as Point describes it, with a ref to highlight it by and whether it is in view. */
type Found = ReturnType<typeof describe> & { ref: string; onScreen: boolean }

const MAX = 60

export function installSpotlight() {
  const t = getTransport()
  const refs = new Map<string, WeakRef<Element>>()
  let seq = 0
  const refOf = (el: Element) => {
    for (const [r, w] of refs) if (w.deref() === el) return r
    const r = `e${++seq}`
    refs.set(r, new WeakRef(el))
    // Old refs go first once there are many.
    if (refs.size > 2000) refs.delete(refs.keys().next().value!)
    return r
  }
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.opacity !== '0'
  }
  const inView = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  }
  const found = (el: Element): Found => ({ ref: refOf(el), ...describe(el), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100), components: components(el).slice(-3), onScreen: inView(el) })
  const page = () => [...document.body.querySelectorAll('*')].filter((el) => !el.closest('#sb-annotate, #sb-spotlight') && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(el.tagName))
  const has = (el: Element, text: string) => (el.textContent ?? '').replace(/\s+/g, ' ').toLowerCase().includes(text) || (el.getAttribute('aria-label') ?? '').toLowerCase().includes(text)

  /** The nearest React component an element belongs to. */
  const owner = (el: Element) => components(el).at(-1) ?? ''

  /**
   * Elements by a CSS selector, by their text, or both (those the selector matches that hold the text).
   * Text alone finds the smallest elements holding it. Neither gives an outline of the page: the
   * outermost element of each component, so the agent can see what is where.
   */
  const find = (a: { selector?: string; text?: string; limit?: number }) => {
    const limit = Math.min(Math.max(Number(a.limit) || MAX, 1), 200)
    const text = a.text?.trim().toLowerCase().replace(/\s+/g, ' ')
    let els: Element[]
    if (a.selector) {
      els = [...document.querySelectorAll(a.selector)].filter((el) => !el.closest('#sb-annotate, #sb-spotlight'))
      if (text) els = els.filter((el) => has(el, text))
    } else if (text) {
      const holding = page().filter((el) => has(el, text))
      els = holding.filter((el) => !holding.some((other) => other !== el && el.contains(other)))
    } else {
      els = page().filter((el) => el.parentElement && owner(el) && owner(el) !== owner(el.parentElement))
    }
    els = els.filter(visible)
    // What is on screen first: it is what the user is looking at.
    els.sort((x, y) => Number(inView(y)) - Number(inView(x)))
    return { total: els.length, elements: els.slice(0, limit).map(found) }
  }

  /** The short texts the page shows (titles, buttons, labels, cells): names voice mode listens for. */
  const words = () => {
    const out = new Set<string>()
    for (const el of page()) {
      let own = ''
      for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) own += n.textContent
      own = own.replace(/\s+/g, ' ').trim()
      const label = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? ''
      for (const text of [own, label.trim()]) if (text.length >= 3 && text.length <= 60 && !out.has(text) && visible(el)) out.add(text)
      if (out.size >= 400) break
    }
    return [...out]
  }

  const host = document.createElement('div')
  host.id = 'sb-spotlight'
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = STYLE
  root.append(style)
  // Each element outlined, with its number when there are several; the question goes over the first.
  let shown: { el: Element; box: HTMLElement; n?: HTMLElement }[] = []
  let ask: HTMLElement | null = null
  let raf = 0

  const place = (node: HTMLElement, x: number, y: number) => {
    node.style.left = `${Math.round(x)}px`
    node.style.top = `${Math.round(y)}px`
  }
  const frame = () => {
    raf = shown.length ? requestAnimationFrame(frame) : 0
    for (const s of shown) {
      const on = s.el.isConnected
      s.box.style.display = on ? '' : 'none'
      if (s.n) s.n.style.display = on ? '' : 'none'
      if (!on) continue
      const r = s.el.getBoundingClientRect()
      place(s.box, r.left - 4, r.top - 4)
      s.box.style.width = `${r.width + 8}px`
      s.box.style.height = `${r.height + 8}px`
      if (s.n) place(s.n, r.left - 12, r.top - 12)
    }
    const first = shown[0]
    if (ask && first) {
      ask.style.display = first.el.isConnected ? '' : 'none'
      const r = first.el.getBoundingClientRect()
      // Above the first one, clear of its number; under it when there is no room above.
      place(ask, Math.min(Math.max(4, r.left + (shown.length > 1 ? 16 : -4)), innerWidth - ask.offsetWidth - 4), r.top > 52 ? r.top - (shown.length > 1 ? 46 : 38) : r.bottom + 10)
    }
  }
  const clear = () => {
    for (const s of shown) s.box.remove(), s.n?.remove()
    shown = []
    ask?.remove()
    ask = null
    cancelAnimationFrame(raf)
    raf = 0
    host.remove()
  }

  /** Outlines elements, by ref (from find) or by selector and text, with the question on the first, or numbers when there are several. */
  const highlight = (a: { refs?: string[]; selector?: string; text?: string; label?: string }) => {
    const els = a.refs?.length
      ? a.refs.map((r) => {
          const el = refs.get(r)?.deref()
          if (!el?.isConnected) throw new Error(`${r} is not on the page any more. Find it again with ui_find.`)
          return el
        })
      : a.selector || a.text
        ? find({ selector: a.selector, text: a.text, limit: 1 }).elements.map((f) => refs.get(f.ref)!.deref()!)
        : []
    if (!els.length) throw new Error('Nothing on the page matches. Look with ui_find first.')
    clear()
    document.documentElement.append(host)
    const many = els.length > 1
    shown = els.slice(0, 9).map((el, i) => {
      const box = document.createElement('div')
      box.className = 'box'
      root.append(box)
      if (!many) return { el, box }
      const n = document.createElement('div')
      n.className = 'n'
      n.textContent = String(i + 1)
      root.append(n)
      return { el, box, n }
    })
    if (a.label) {
      ask = document.createElement('div')
      ask.className = 'ask'
      ask.textContent = a.label
      root.append(ask)
    }
    els[0]!.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    raf = requestAnimationFrame(frame)
    return { highlighted: els.slice(0, 9).map(found) }
  }

  window.addEventListener('message', (e) => {
    const m = e.data
    if (e.source !== window.parent || !m || m.sb !== 1 || typeof m.type !== 'string' || !m.type.startsWith('ui-') || m.type === 'ui-result') return
    const answer = (f: () => unknown) => {
      try {
        t.post('ui-result', { req: m.req, ok: true, data: f() })
      } catch (err) {
        t.post('ui-result', { req: m.req, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (m.type === 'ui-find') answer(() => ({ ...find(m), route: location.hash.slice(1) || '/' }))
    else if (m.type === 'ui-highlight') answer(() => highlight(m))
    else if (m.type === 'ui-clear') answer(() => (clear(), { cleared: true }))
    else if (m.type === 'ui-words') answer(() => ({ words: words() }))
  })
}
