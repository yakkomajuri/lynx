// The command bar (⌘K): every place and action in the app, searchable, with its shortcut beside it.
// The same list drives the keyboard shortcuts, so the two cannot drift apart.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Columns2 } from 'lucide-react'
import { Icon } from '@kit/icons'
import { comboLabel, type Combo } from '@kit/keys'
import { bridge } from './api'
import { comboFor, useShortcuts } from './keymap'

export type { Combo }

export interface Command {
  id: string
  group: 'Go to' | 'Open beside' | 'Agent' | 'This workspace' | 'App'
  title: string
  icon?: ReactNode
  combo?: Combo
  /** Other words it is found by. */
  keywords?: string
  run: () => void
  /** What ⇧↵ does instead, where the command has a second way to go (opening on the left rather than the right). */
  alt?: () => void
  /** Asks for something in the field before it runs: picking it puts the bar on the question, with `run` unused. */
  ask?: Ask
}

export interface Ask {
  placeholder: string
  /** What Enter does with the text typed, as a row to pick; or, for text that is no answer, the words that say what is wanted. */
  answer: (text: string) => { title: string; run: () => void } | string
}

const mac = bridge.platform === 'darwin'
export const keys = (c: Combo) => comboLabel(c, mac)
/** A shortcut as a key cap; nothing for none. */
export const Keys = ({ combo }: { combo?: Combo }) => (combo ? <kbd className="h-kbd">{keys(combo)}</kbd> : null)
/** "Title (⌘T)", or the title alone when the shortcut has no keys. */
export const titled = (title: string, combo?: Combo) => (combo ? `${title} (${keys(combo)})` : title)

const GROUPS: Command['group'][] = ['Go to', 'Open beside', 'Agent', 'This workspace', 'App']

/** `beside` (the name of the workspace on screen) opens it on the workspaces that can go beside it (⌘\), and nothing else; a tag in the field says so, and Backspace takes it off. */
export function CommandBar({ commands, beside, onClose, onAll }: { commands: Command[]; beside?: string; onClose: () => void; /** Back to every command, from opening beside. */ onAll: () => void }) {
  useShortcuts()
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  // The command picked that asks for something first, while the field answers it.
  const [asking, setAsking] = useState<Command | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  // Opening beside repeats every workspace, so it has a mode of its own; the rest reach it by one command.
  const groups = beside ? (['Open beside'] as const) : GROUPS.filter((g) => g !== 'Open beside')
  const answer = asking?.ask?.answer(q)
  const shown: Command[] = asking
    ? typeof answer === 'object'
      ? [{ id: `${asking.id}:answer`, group: asking.group, title: answer.title, icon: asking.icon, run: answer.run }]
      : []
    : groups.flatMap((g) => commands.filter((c) => c.group === g && words.every((w) => `${beside ? '' : c.group} ${c.title} ${c.keywords ?? ''}`.toLowerCase().includes(w))))
  const pick = Math.min(at, shown.length - 1)

  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [pick, q])

  const run = (c: Command | undefined, alt = false) => {
    if (!c) return
    if (c.ask) {
      setAsking(c)
      setQ('')
      // Picked with the mouse, the focus went to its row, which the question takes away: the answer is typed in the field.
      field.current?.focus()
      return
    }
    onClose()
    if (alt && c.alt) c.alt()
    else c.run()
  }
  return (
    <div className="h-cmd-scrim" onMouseDown={onClose}>
      <div className="h-cmd" role="dialog" aria-label="Command bar" onMouseDown={(e) => e.stopPropagation()}>
        <div className="h-cmd-input">
          <Icon name="search" size={18} />
          {asking && <span className="h-cmd-tag">{asking.title}</span>}
          {beside && !asking && (
            <span className="h-cmd-tag">
              <Columns2 size={13} strokeWidth={2} />
              Open beside {beside}
            </span>
          )}
          <input
            ref={field}
            autoFocus
            value={q}
            placeholder={asking?.ask ? asking.ask.placeholder : beside ? 'Search workspaces' : 'Go to a workspace or run a command'}
            aria-label="Search commands"
            onChange={(e) => {
              setQ(e.target.value)
              setAt(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (shown.length) setAt((pick + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(shown[pick], e.shiftKey)
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                onClose()
              } else if (e.key === 'Backspace' && asking && !q) {
                e.preventDefault()
                setAsking(null)
              } else if (e.key === 'Backspace' && beside && !q) onAll()
            }}
          />
          <Keys combo={comboFor(beside ? 'beside' : 'command-bar')} />
        </div>
        <div className="h-cmd-list" ref={list}>
          {asking && typeof answer === 'string' && <div className="h-cmd-none">{answer}</div>}
          {!asking && shown.length === 0 && <div className="h-cmd-none">Nothing matches “{q}”</div>}
          {shown.map((c, i) => (
            <div key={c.id}>
              {!asking && c.group !== shown[i - 1]?.group && <div className="h-cmd-group">{c.group}</div>}
              <button className={`h-cmd-row${i === pick ? ' on' : ''}`} onMouseMove={() => setAt(i)} onClick={(e) => run(c, e.shiftKey)}>
                <span className="h-icon">{c.icon}</span>
                <span className="h-cmd-title">{c.title}</span>
                {c.combo && <Keys combo={c.combo} />}
                {c.alt && i === pick && <span className="h-cmd-hint">↵ right · ⇧↵ left</span>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
