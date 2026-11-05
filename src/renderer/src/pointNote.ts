// Point's note box. The workspace's frame outlines what is hovered and says what was clicked and where it
// sits; the box itself is drawn here, in the app's window, over the frame. Workspace code runs on its own
// origin and cannot reach this page, so it cannot type in the box, tick "Trigger agent right away" or press
// Send: a note that sends itself is always the user's.
// Plain DOM in a shadow root, as it was in the frame: the same look, the same keys.
import type { PointMention } from '@kit/annotate'
import { markRanges, typedMention } from '@kit/marks'

const STYLE = `
:host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font: 13px/1.4 var(--sb-font, system-ui, sans-serif); }
* { box-sizing: border-box; }
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
.pop label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--sb-muted, #666); cursor: pointer; user-select: none; }
.pop input[type=checkbox] { margin: 0; accent-color: var(--sb-blue, #2563eb); cursor: pointer; }
.pop button { height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--sb-line, #ddd); background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.pop button.go { margin-left: auto; background: var(--sb-text, #111); color: var(--sb-bg, #fff); border-color: transparent; }
.pop button:disabled { opacity: 0.4; cursor: default; }
`

/** Whether a note goes straight to the agent instead of onto its list. Remembered for the next note. */
const SEND = 'sb.point.send'
const sendStored = () => {
  try {
    return localStorage.getItem(SEND) === '1'
  } catch {
    return false
  }
}

/** The box's width, and the least it narrows to in a narrow frame. */
const WIDTH = 290
const MIN_W = 220

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PointNoteOptions {
  /** What was picked, as the frame names it. */
  what: string
  /** Where the picked element is, in the window. */
  at: Rect
  /** The part of the window the box keeps inside: the workspace's frame. */
  within: Rect
  mentions: PointMention[]
  /** Add (or, ticked, send) was pressed, by the user: this box is only in the app's window. */
  onAdd: (note: string, send: boolean) => void
  /** Closed without a note: Escape, or a box opened for another pane. Not called when closed by `close()`. */
  onCancel: () => void
}

export interface PointNote {
  /** The picked element moved (the workspace scrolled, say): the box follows. */
  move: (at: Rect, within: Rect) => void
  close: () => void
}

/** A mention's icon, as the app drew it for the list. */
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

/** Opens the note box by a picked element. One at a time: a new one puts the one before away. */
let current: { note: PointNote; cancel: () => void } | null = null
export function openPointNote(o: PointNoteOptions): PointNote {
  if (current) {
    const before = current
    before.note.close()
    before.cancel()
  }
  const mentions = o.mentions
  const host = document.createElement('div')
  host.id = 'sb-point-note'
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = STYLE
  const pop = document.createElement('div')
  pop.className = 'pop'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', 'Point note')
  const what = document.createElement('div')
  what.className = 'what'
  what.textContent = o.what
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
    parts.push(document.createTextNode(`${area.value.slice(at)}​`))
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
    // Under the field when there is room in the frame, else over it.
    const f = field.getBoundingClientRect()
    menu.classList.toggle('up', f.bottom + 4 + menu.offsetHeight > within.bottom - 8 && f.top - within.top > within.bottom - f.bottom)
  }
  /** The @ and what was typed after it become the mention, with a space after it unless one is there. */
  const choose = (m: PointMention) => {
    const t = typed()
    if (!t) return
    const end = area.selectionStart
    const put = area.value[end] === ' ' ? `@${m.name}` : `@${m.name} `
    area.setRangeText(put, end - t[2]!.length - 1, end, 'end')
    pick = 0
    sync()
    draw()
    area.focus()
  }
  const bar = document.createElement('div')
  bar.className = 'bar'
  const add = document.createElement('button')
  add.className = 'go'
  // Ticked, the note goes to the agent right away: Add becomes Send. Sending needs a note to say what to do.
  const toAgent = document.createElement('label')
  const check = document.createElement('input')
  check.type = 'checkbox'
  check.checked = sendStored()
  toAgent.append(check, 'Trigger agent right away')
  const sync = () => {
    add.textContent = check.checked ? 'Send' : 'Add'
    add.disabled = check.checked && !area.value.trim()
  }
  check.addEventListener('change', () => {
    try {
      localStorage.setItem(SEND, check.checked ? '1' : '0')
    } catch {}
    sync()
    area.focus()
  })
  area.addEventListener('input', () => (sync(), draw()))
  for (const ev of ['keyup', 'click', 'focus'] as const) area.addEventListener(ev, draw)
  area.addEventListener('scroll', () => (shown.scrollTop = area.scrollTop))
  const submit = () => {
    if (add.disabled) return
    const note = area.value.trim()
    const send = check.checked
    close()
    o.onAdd(note, send)
  }
  area.addEventListener('keydown', (e) => {
    // Escape is the box's: the app's own (Point off) sees this box's host, not a text field, and must not hear it.
    if (e.key === 'Escape') e.stopPropagation()
    // A mention goes as a whole: Backspace at its end (or in it) takes it all, and so does Delete at its start.
    if ((e.key === 'Backspace' || e.key === 'Delete') && area.selectionStart === area.selectionEnd && !e.metaKey && !e.altKey && !e.ctrlKey) {
      const at = area.selectionStart
      const hit = ranges().find((r) => (e.key === 'Backspace' ? at > r.start && at <= r.end : at >= r.start && at < r.end))
      if (hit) {
        e.preventDefault()
        area.setRangeText('', hit.start, hit.end, 'end')
        sync()
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
        e.preventDefault()
        off = area.value
        return draw()
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
      o.onCancel()
    }
  })
  add.addEventListener('click', submit)
  bar.append(toAgent, add)
  pop.append(what, field, bar)
  root.append(style, pop)
  document.body.append(host)
  sync()
  draw()

  let within = o.within
  // Under the element when it fits in the frame, else over it; kept inside the frame either way, so a draft
  // whose element scrolled out of sight stays on screen at the frame's edge. A frame out of sight (the code
  // inspector or the agent full screen in its place) hides the box until it is back; the draft waits.
  // In a frame too narrow for the box, it narrows to fit, down to MIN_W, and past that keeps inside the window.
  const place = (at: Rect) => {
    const fw = within.right - within.left
    const fh = within.bottom - within.top
    host.style.display = fw < 1 || fh < 1 ? 'none' : ''
    if (host.style.display === 'none') return
    const w = Math.max(MIN_W, Math.min(WIDTH, fw - 16))
    pop.style.width = `${w}px`
    const h = pop.offsetHeight
    const inFrame = Math.max(within.left + 8, Math.min(at.left, within.right - w - 8))
    const left = Math.max(8, Math.min(inFrame, innerWidth - w - 8))
    const want = at.bottom + 8 + h < within.bottom ? at.bottom + 8 : at.top - h - 8
    const top = Math.max(within.top + 8, Math.min(want, within.bottom - h - 8))
    pop.style.left = `${Math.round(left)}px`
    pop.style.top = `${Math.round(top)}px`
  }
  place(o.at)
  area.focus()

  const close = () => {
    host.remove()
    if (current?.note === me) current = null
  }
  const me: PointNote = {
    move: (at, w) => {
      within = w
      if (host.isConnected) place(at)
    },
    close,
  }
  current = { note: me, cancel: o.onCancel }
  return me
}
