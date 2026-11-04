// Whether the page holds something a reload would lose. When an agent publishes a new version, the host
// asks first: while the user is busy here the old version stays on screen, with a banner to update.
// The rules are strict on purpose, so an update is rarely held for nothing:
// - text the user typed into a field (not empty, not what the field started with) that still has the focus,
//   or was typed into in the last two minutes;
// - anything the workspace declares with useBusy.
// A click, a focused empty field, or text left in a field a while ago does not hold an update.
import { useEffect } from 'react'

/** How long text typed into a field that no longer has the focus still holds an update. */
export const TYPED_RECENTLY_MS = 120_000

const declared = new Set<symbol>()
// Fields the user typed into: what each held before, and when they last typed.
const typed = new Map<HTMLElement, { initial: string; at: number }>()
const before = new WeakMap<HTMLElement, string>()

const TEXT_INPUT = /^(text|search|email|url|tel|password|number|)$/
const fieldOf = (target: EventTarget | null): HTMLElement | null => {
  if (target instanceof HTMLTextAreaElement) return target
  if (target instanceof HTMLInputElement) return TEXT_INPUT.test(target.type) ? target : null
  if (target instanceof HTMLElement && target.isContentEditable) {
    let el = target
    while (el.parentElement?.isContentEditable) el = el.parentElement
    return el
  }
  return null
}
const textOf = (el: HTMLElement) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? ''))

/** Whether a reload now would lose something the user is in the middle of. */
export function busy(now = Date.now()): boolean {
  if (declared.size) return true
  const focused = document.activeElement
  for (const [el, t] of typed) {
    if (!el.isConnected) {
      typed.delete(el)
      continue
    }
    const text = textOf(el)
    if (!text.trim() || text === t.initial) continue
    if (el === focused || el.contains(focused) || now - t.at < TYPED_RECENTLY_MS) return true
  }
  return false
}

export function installBusy(post: (type: string, payload: Record<string, unknown>) => void) {
  // What a field held when the user came to it: React keeps a controlled field's default in step with
  // its value, so `defaultValue` cannot say what was typed.
  window.addEventListener(
    'focusin',
    (e) => {
      const el = fieldOf(e.target)
      if (el && !typed.has(el)) before.set(el, textOf(el))
    },
    true,
  )
  window.addEventListener(
    'input',
    (e) => {
      const el = e.isTrusted ? fieldOf(e.target) : null
      if (!el) return
      const t = typed.get(el)
      if (t) t.at = Date.now()
      else typed.set(el, { initial: before.get(el) ?? '', at: Date.now() })
    },
    true,
  )
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && e.data?.sb === 1 && e.data.type === 'busy?') post('busy', { id: e.data.id, busy: busy() })
  })
}

/**
 * Holds an agent's new version of this workspace off the screen while `on`, as typed text does: for
 * what a reload would lose that the page cannot see, such as an editor's unsaved buffer, a draft
 * kept only in state, or a drag under way. The user can still update from the banner.
 */
export function useBusy(on: boolean) {
  useEffect(() => {
    if (!on) return
    const key = Symbol()
    declared.add(key)
    return () => void declared.delete(key)
  }, [on])
}
