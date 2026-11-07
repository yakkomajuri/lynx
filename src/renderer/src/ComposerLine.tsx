// The agent panel's message box, in its line layout: the settings written out in a line under the
// box, each opening its choices above it.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@kit/icons'

/** The mark of a coding agent, by its harness name; nothing for one without a mark. */
export function AgentMark({ harness, size = 13 }: { harness: string; size?: number }) {
  if (harness === 'claude')
    return (
      <svg className="h-agent-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path fillRule="evenodd" clipRule="evenodd" fill="#D97757" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
      </svg>
    )
  if (harness === 'codex')
    return (
      <svg className="h-agent-mark" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    )
  if (harness === 'opencode')
    return (
      <svg className="h-agent-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </svg>
    )
  return null
}

/** A menu open above the button it belongs to, until a click elsewhere or Escape. */
function usePop() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    // The keyboard goes to what is picked, or else the first choice.
    ;(menu.current?.querySelector<HTMLButtonElement>('[aria-checked=true]') ?? menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus()
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  // Arrows move among the choices; Escape closes the menu and not the panel behind it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }
  return { open, setOpen, close, root, button, menu, onKeyDown }
}

export interface Choice<T extends string> {
  value: T
  name: string
  description?: string
  /** A few words at the end of the row, for choices told apart at a glance. */
  hint?: string
  icon?: ReactNode
  className?: string
}

/** One setting in the line under the box: what it is set to, in words, opening the choices above it. */
export function Pick<T extends string>({ label, heading, value, choices, onPick, locked, title, className, align = 'start' }: { label: string; heading?: string; value: T; choices: Choice<T>[]; onPick: (value: T) => void; /** Shown, but not to be changed. */ locked?: boolean; title?: string; className?: string; align?: 'start' | 'end' }) {
  const pop = usePop()
  const current = choices.find((c) => c.value === value)
  return (
    <span ref={pop.root} className={`h-line-pick${className ? ` ${className}` : ''}`}>
      <button ref={pop.button} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={pop.open} data-value={value} disabled={locked} title={title} onClick={() => pop.setOpen(!pop.open)}>
        {current?.icon}
        {current?.name ?? value}
      </button>
      {pop.open && (
        <div ref={pop.menu} className={`h-pop ${align}`} role="menu" aria-label={label} onKeyDown={pop.onKeyDown}>
          {heading && <h6>{heading}</h6>}
          {choices.map((c) => (
            <button
              key={c.value}
              type="button"
              role="menuitemradio"
              aria-checked={c.value === value}
              data-value={c.value}
              className={c.className}
              onClick={() => {
                onPick(c.value)
                pop.close()
              }}
            >
              <span className="h-pop-check">{c.value === value && <Icon name="check" size={14} />}</span>
              {c.icon && <span className="h-pop-icon">{c.icon}</span>}
              <span className="h-pop-text">
                {c.name}
                {c.description && <small>{c.description}</small>}
              </span>
              {c.hint && <span className="h-pop-hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
