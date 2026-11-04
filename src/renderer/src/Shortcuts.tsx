// Settings › Shortcuts: every shortcut, and the keys for it. Click one and press the keys you want in its place.
import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { comboOf } from '@kit/keys'
import { bridge } from './api'
import { keys } from './CommandBar'
import { comboFor, isDefault, reserved, resetAll, resetCombo, setCombo, SHORTCUTS, useShortcuts, type Shortcut } from './keymap'

const GROUPS: Shortcut['group'][] = ['App', 'Workspaces', 'Agent', 'This workspace']
const MODIFIERS = ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn']
const held = bridge.platform === 'darwin' ? 'Hold ⌘ (or ⌃) with the key' : 'Hold Ctrl with the key'

export function ShortcutsView() {
  useShortcuts()
  // The shortcut taking keys now, and what to say under one (why the keys were not taken, or whose they were).
  const [recording, setRecording] = useState<string | null>(null)
  const [note, setNote] = useState<{ id: string; text: string; tone: 'bad' | 'info' } | null>(null)

  // While keys are being taken, each press comes from the app rather than the page, so ⌘W or ⌘M can be had and nothing else runs.
  useEffect(() => {
    if (!recording) return
    bridge.recordKeys(true)
    const off = bridge.onEvent((e) => {
      if (e.t !== 'key') return
      const p = e.press
      if (MODIFIERS.includes(p.key)) return
      const bare = !p.metaKey && !p.ctrlKey && !p.altKey && !p.shiftKey
      if (bare && p.key === 'Escape') return setRecording(null)
      if (bare && (p.key === 'Backspace' || p.key === 'Delete')) {
        setCombo(recording, null)
        return setRecording(null)
      }
      const combo = comboOf(p, bridge.platform === 'darwin')
      if (!combo) return setNote({ id: recording, text: held, tone: 'bad' })
      const why = reserved(recording, combo)
      if (why) return setNote({ id: recording, text: `${keys(combo)} ${why}, so it cannot be a shortcut`, tone: 'bad' })
      took(recording, setCombo(recording, combo))
    })
    return () => {
      off()
      bridge.recordKeys(false)
    }
  }, [recording])
  const took = (id: string, from: Shortcut | undefined) => {
    setRecording(null)
    setNote(from ? { id, text: `Taken from “${from.title}”, which has none now`, tone: 'info' } : null)
  }
  const start = (id: string) => {
    setNote(null)
    setRecording(recording === id ? null : id)
  }
  const changed = SHORTCUTS.some((s) => !isDefault(s.id))

  return (
    <div className="h-scroll">
      <div className="sb-page">
        <header className="sb-page-head">
          <div>
            <h1>Shortcuts</h1>
            <p>Click a shortcut and press the keys you want for it. Esc leaves it as it was; ⌫ takes its keys away.</p>
          </div>
          {changed && (
            <button className="sb-btn sm" onClick={() => (setRecording(null), setNote(null), resetAll())}>
              <RotateCcw size={14} strokeWidth={1.8} />
              Reset all
            </button>
          )}
        </header>
        {GROUPS.map((g) => (
          <section key={g} className="sb-card">
            <div className="sb-card-head">
              <h2>{g}</h2>
            </div>
            <div className="h-keys" role="list">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => {
                const combo = comboFor(s.id)
                const on = recording === s.id
                return (
                  <div key={s.id} className="h-keys-row" role="listitem">
                    <span className="h-keys-name">
                      {s.title}
                      {note?.id === s.id && <span className={`h-keys-note ${note.tone}`}>{note.text}</span>}
                    </span>
                    {!isDefault(s.id) && (
                      <button className="sb-btn sm ghost h-keys-reset" onClick={() => took(s.id, resetCombo(s.id))} aria-label={`Put back ${keys(s.default)} for ${s.title}`} title={`Put back ${keys(s.default)}`}>
                        <RotateCcw size={13} strokeWidth={1.8} />
                      </button>
                    )}
                    <button
                      className={`h-keys-cap${on ? ' on' : ''}${combo ? '' : ' none'}`}
                      onClick={() => start(s.id)}
                      onBlur={() => on && setRecording(null)}
                      aria-label={`${s.title}: ${on ? 'press the keys' : combo ? keys(combo) : 'no shortcut'}. Click to change.`}
                      aria-pressed={on}
                    >
                      {on ? 'Press keys…' : combo ? keys(combo) : 'None'}
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
