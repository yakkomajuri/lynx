// Point-and-tell mode. The host window turns it on; this runs inside the workspace frame. While
// it is on, the page stops reacting to the mouse: hovering outlines an element and clicking one opens
// a note box. The note is optional: an element can be handed over as it is, for the user's next
// message to be about. Picks are posted to the host, which hands them to the agent.
// Plain DOM in a shadow root: it must keep working whatever the workspace's React and CSS do.
// A note can @ mention workspaces and connectors, as a message to the agent can; the host says which.
import { getTransport } from './core'
import { markRanges, typedMention } from './marks'

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
.pop { position: fixed; width: 290px; pointer-events: auto; background: var(--sb-surface, #fff); color: var(--sb-text, #111); border: 1px solid var(--sb-line, #ddd); border-radius: 14px; box-shadow: 0 10px 34px rgba(0, 0, 0, 0.2); padding: 10px; }
.pop .what { font-size: 11px; color: var(--sb-muted, #666); margin: 0 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pop textarea { display: block; width: 100%; min-height: 58px; resize: none; border: 1px solid var(--sb-line, #ddd); border-radius: 9px; padding: 7px 9px; background: var(--sb-bg, #fff); color: inherit; font: inherit; outline: none; }
.pop textarea:focus { border-color: var(--sb-faint, #999); }
.field { position: relative; }
.field textarea { position: relative; background: transparent; }
.field textarea.marked { color: transparent; caret-color: var(--sb-text, #111); }
.marks { position: absolute; inset: 0; overflow: hidden; border: 1px solid transparent; border-radius: 9px; padding: 7px 9px; background: var(--sb-bg, #fff); color: var(--sb-text, #111); white-space: pre-wrap; overflow-wrap: break-word; pointer-events: none; }
.mk { border-radius: 5px; background: var(--sb-accent-soft, rgba(16, 163, 127, 0.11)); box-shadow: -2px 0 0 var(--sb-accent-soft, rgba(16, 163, 127, 0.11)), 2px 0 0 var(--sb-accent-soft, rgba(16, 163, 127, 0.11)); -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.mk .at { position: relative; color: transparent; }
.ic { display: grid; place-items: center; color: var(--sb-muted, #666); }
.mk .ic { position: absolute; inset: 0; }
.ic svg, .ic img { display: block; width: 14px; height: 14px; border-radius: 3px; }
.mk .ic svg, .mk .ic img { width: 11px; height: 11px; }
.menu { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 1; max-height: 216px; overflow-y: auto; padding: 4px; background: var(--sb-surface, #fff); border: 1px solid var(--sb-line, #ddd); border-radius: 12px; box-shadow: 0 8px 26px rgba(0, 0, 0, 0.18); }
.menu.up { top: auto; bottom: calc(100% + 4px); }
.menu h6 { margin: 6px 8px 3px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--sb-faint, #999); }
.menu h6:first-child { margin-top: 2px; }
.opt { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.opt.hi { background: var(--sb-hover, rgba(0, 0, 0, 0.06)); }
.opt .ic { flex: none; width: 16px; height: 16px; }
.pop .bar { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.pop button { height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--sb-line, #ddd); background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.pop button.go { margin-left: auto; background: var(--sb-text, #111); color: var(--sb-bg, #fff); border-color: transparent; }
.pop button:disabled { opacity: 0.4; cursor: default; }
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
  let pop: HTMLElement | null = null
  let popFor: Element | null = null
  let raf = 0
  let mentions: PointMention[] = []
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

  /** A mention's icon, as the host drew it. */
  const iconOf = (m: PointMention) => {
    const ic = document.createElement('span')
    ic.className = 'ic'
    if (m.img) {
      const img = document.createElement('img')
      img.alt = ''
      img.src = m.img
      ic.append(img)
    } else if (m.svg) ic.innerHTML = m.svg
    return ic
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

  const closePop = () => {
    pop?.remove()
    pop = popFor = null
  }

  const openPop = (el: Element) => {
    closePop()
    popFor = el
    pop = document.createElement('div')
    pop.className = 'pop'
    const what = document.createElement('div')
    what.className = 'what'
    what.textContent = name(el)
    const area = document.createElement('textarea')
    area.placeholder = mentions.length ? 'Add a note, @ to mention, or leave it empty' : 'Add a note, or leave it empty'
    // The note's text is drawn by a copy behind the field, with its mentions as marks; the caret stays the field's.
    const field = document.createElement('div')
    field.className = 'field'
    const shown = document.createElement('div')
    shown.className = 'marks'
    field.append(shown, area)
    const menu = document.createElement('div')
    menu.className = 'menu'
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', 'Mention')
    // @ before the caret offers what can be mentioned, narrowed by what follows it; Escape puts the offer away until the text changes.
    let matches: PointMention[] = []
    let pick = 0
    let off: string | null = null
    const ranges = () => markRanges(area.value, mentions.map((m) => `@${m.name}`))
    const typed = () => (area.selectionStart === area.selectionEnd ? typedMention(area.value.slice(0, area.selectionStart)) : null)
    const draw = () => {
      const rs = ranges()
      const parts: Node[] = []
      let at = 0
      for (const r of rs) {
        const m = mentions.find((x) => `@${x.name}` === r.mark)!
        if (r.start > at) parts.push(document.createTextNode(area.value.slice(at, r.start)))
        const mk = document.createElement('span')
        mk.className = 'mk'
        const sign = document.createElement('span')
        sign.className = 'at'
        sign.append('@', iconOf(m))
        mk.append(sign, r.mark.slice(1))
        parts.push(mk)
        at = r.end
      }
      // A newline at the end takes a line in the field; the copy needs something after it to do the same.
      parts.push(document.createTextNode(`${area.value.slice(at)}\u200b`))
      shown.replaceChildren(...parts)
      shown.scrollTop = area.scrollTop
      area.classList.toggle('marked', rs.length > 0)
      const t = typed()
      const q = t?.[2]!.toLowerCase() ?? ''
      const used = new Set(rs.map((r) => r.mark))
      matches = t && area.value !== off ? mentions.filter((m) => !used.has(`@${m.name}`) && m.name.toLowerCase().includes(q)) : []
      pick = Math.min(pick, Math.max(0, matches.length - 1))
      if (!matches.length) return menu.remove()
      const rows: Node[] = []
      for (const kind of ['workspace', 'connector'] as const) {
        const group = matches.filter((m) => m.kind === kind)
        if (!group.length) continue
        const h = document.createElement('h6')
        h.textContent = kind === 'workspace' ? 'Workspaces' : 'Connectors'
        rows.push(h)
        for (const m of group) {
          const opt = document.createElement('div')
          const i = matches.indexOf(m)
          opt.className = `opt${i === pick ? ' hi' : ''}`
          opt.setAttribute('role', 'option')
          opt.setAttribute('aria-selected', String(i === pick))
          opt.append(iconOf(m), m.name)
          // A press on one leaves the keyboard in the field.
          opt.addEventListener('mousedown', (e) => e.preventDefault())
          opt.addEventListener('click', () => choose(m))
          rows.push(opt)
        }
      }
      menu.replaceChildren(...rows)
      if (!menu.isConnected) field.append(menu)
      menu.querySelector('.hi')?.scrollIntoView({ block: 'nearest' })
      // Under the field when there is room, else over it.
      const f = field.getBoundingClientRect()
      menu.classList.toggle('up', f.bottom + 4 + menu.offsetHeight > innerHeight - 8 && f.top > innerHeight - f.bottom)
    }
    /** The @ and what was typed after it become the mention, with a space after it unless one is there. */
    const choose = (m: PointMention) => {
      const t = typed()
      if (!t) return
      const end = area.selectionStart
      const put = area.value[end] === ' ' ? `@${m.name}` : `@${m.name} `
      area.setRangeText(put, end - t[2]!.length - 1, end, 'end')
      pick = 0
      draw()
      area.focus()
    }
    const bar = document.createElement('div')
    bar.className = 'bar'
    const add = document.createElement('button')
    add.className = 'go'
    add.textContent = 'Add'
    area.addEventListener('input', draw)
    for (const ev of ['keyup', 'click', 'focus'] as const) area.addEventListener(ev, draw)
    area.addEventListener('scroll', () => (shown.scrollTop = area.scrollTop))
    draw()
    const submit = () => {
      if (add.disabled) return
      const note = area.value.trim()
      const id = `p${Date.now().toString(36)}${++seq}`
      mark(id, el)
      t.post('annotate-add', { item: { id, note, ...describe(el) } })
      closePop()
    }
    area.addEventListener('keydown', (e) => {
      e.stopPropagation()
      // A mention goes as a whole: Backspace at its end (or in it) takes it all, and so does Delete at its start.
      if ((e.key === 'Backspace' || e.key === 'Delete') && area.selectionStart === area.selectionEnd && !e.metaKey && !e.altKey && !e.ctrlKey) {
        const at = area.selectionStart
        const hit = ranges().find((r) => (e.key === 'Backspace' ? at > r.start && at <= r.end : at >= r.start && at < r.end))
        if (hit) {
          e.preventDefault()
          area.setRangeText('', hit.start, hit.end, 'end')
          return draw()
        }
      }
      if (matches.length && !e.isComposing) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
          return draw()
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault()
          return choose(matches[pick]!)
        }
        if (e.key === 'Escape') {
          off = area.value
          return draw()
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        submit()
      } else if (e.key === 'Escape') closePop()
    })
    add.addEventListener('click', submit)
    bar.append(add)
    pop.append(what, field, bar)
    root.append(pop)
    const r = el.getBoundingClientRect()
    const h = pop.offsetHeight
    place(pop, Math.min(Math.max(8, r.left), innerWidth - 298), r.bottom + 8 + h < innerHeight ? r.bottom + 8 : Math.max(8, r.top - h - 8))
    area.focus()
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
      if (pop) closePop()
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
    else if (m.type === 'annotate-mentions') mentions = Array.isArray(m.list) ? m.list : []
    else if (m.type === 'annotate-sync') {
      // The host owns the list; markers follow it, numbered in its order.
      const ids: string[] = Array.isArray(m.ids) ? m.ids : []
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
