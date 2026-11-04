// A workspace's icon: one of Lucide's line icons in one of a few colours, chosen by the user.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { icons, type LucideIcon } from 'lucide-react'

export const COLORS: { id: string; name: string; value: string }[] = [
  { id: '', name: 'Default', value: 'var(--sb-muted)' },
  { id: 'red', name: 'Red', value: '#e5484d' },
  { id: 'orange', name: 'Orange', value: '#f76b15' },
  { id: 'yellow', name: 'Yellow', value: '#d9a11f' },
  { id: 'green', name: 'Green', value: '#30a46c' },
  { id: 'teal', name: 'Teal', value: '#12a594' },
  { id: 'blue', name: 'Blue', value: '#3e7bfa' },
  { id: 'purple', name: 'Purple', value: '#8e5bd9' },
  { id: 'pink', name: 'Pink', value: '#d6409f' },
  { id: 'brown', name: 'Brown', value: '#ad7f58' },
]
const colorOf = (id?: string) => (COLORS.find((c) => c.id === id) ?? COLORS[0]!).value

const DEFAULT = 'AppWindow'
// Workspaces made before icons existed carry an emoji; the ones the app shipped map to an icon.
const LEGACY: Record<string, string> = { '💬': 'MessageCircle', '🛰️': 'SquareKanban', '📚': 'BookOpen', '🦔': 'ChartLine', '🔀': 'GitPullRequest' }
const lib = icons as Record<string, LucideIcon>
/** Accepts Lucide's own names ("chart-line") as well as the component names ("ChartLine"). */
const resolve = (name?: string): string => {
  if (!name) return DEFAULT
  if (lib[name]) return name
  const pascal = name.split(/[-_\s]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return lib[pascal] ? pascal : (LEGACY[name] ?? DEFAULT)
}
const words = (key: string) => key.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Z])/g, '$1 $2').toLowerCase()

export function WorkspaceIcon({ icon, color, size = 14 }: { icon?: string; color?: string; size?: number }) {
  const C = lib[resolve(icon)]!
  return <C size={size} strokeWidth={1.6} color={colorOf(color)} aria-hidden />
}

const ALL = Object.keys(lib).map((key) => ({ key, text: words(key) }))
const SHOWN = 280

export function IconPicker({ icon, color, onChange, onClose, style }: { icon?: string; color?: string; onChange: (next: { icon?: string; color?: string }) => void; onClose: () => void; /** Overrides where the picker sits (it hangs below its anchor by default). */ style?: CSSProperties }) {
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const current = resolve(icon)
  const found = useMemo(() => {
    const ws = q.toLowerCase().split(/\s+/).filter(Boolean)
    return ws.length ? ALL.filter((i) => ws.every((w) => i.text.includes(w))) : ALL
  }, [q])
  useEffect(() => input.current?.focus(), [])
  return (
    <>
      <div className="h-scrim" onClick={onClose} />
      <div className="h-picker" style={style} role="dialog" aria-label="Choose an icon" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
        <div className="h-picker-colors">
          {COLORS.map((c) => (
            <button key={c.id} className={(color ?? '') === c.id ? 'on' : ''} onClick={() => onChange({ color: c.id })} title={c.name} aria-label={c.name} aria-pressed={(color ?? '') === c.id}>
              <i style={{ background: c.value }} />
            </button>
          ))}
        </div>
        <input ref={input} className="h-picker-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${ALL.length.toLocaleString()} icons`} aria-label="Search icons" />
        <div className="h-picker-grid" style={{ color: colorOf(color) }}>
          {found.slice(0, SHOWN).map(({ key, text }) => {
            const C = lib[key]!
            return (
              <button
                key={key}
                className={key === current ? 'on' : ''}
                title={text}
                aria-label={text}
                onClick={() => {
                  onChange({ icon: key })
                  onClose()
                }}
              >
                <C size={15} strokeWidth={1.6} />
              </button>
            )
          })}
          {found.length === 0 && <p>No icon matches “{q}”</p>}
          {found.length > SHOWN && <p>{(found.length - SHOWN).toLocaleString()} more. Search to narrow down.</p>}
        </div>
      </div>
    </>
  )
}
