// Key combinations for the app's shortcuts, the same in the host window and inside workspace frames:
// reading one off a key press, comparing two, and writing one the way the platform does (⌥⌘N, Ctrl+Alt+N).

/** A shortcut: the shortcut key (⌘ on a Mac, Ctrl elsewhere) with a key, and any of ⇧ and ⌥ as well. */
export interface Combo {
  /** Lowercase: a letter, a digit, punctuation, or a name (arrowleft, tab). */
  key: string
  shift?: boolean
  /** ⌥ (Alt) as well. */
  option?: boolean
  /** ⌃ in place of ⌘, on a Mac. Elsewhere Ctrl is the shortcut key anyway, and this changes nothing. */
  ctrl?: boolean
}

export interface KeyPress {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

// Where a key is on the keyboard, for when ⇧ or ⌥ have turned it into another character (⌥N is a dead key on a Mac, ⇧[ is {).
const CODES: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'space',
}
const fromCode = (code: string) => (/^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : CODES[code])

/** The shortcut a key press makes, or null for one without the shortcut key (or a bare modifier). */
export function comboOf(e: KeyPress, mac = isMac()): Combo | null {
  // On a Mac the shortcut key is ⌘, or ⌃ for a combo that says so; never both. Elsewhere it is Ctrl.
  const ctrl = mac && e.ctrlKey && !e.metaKey
  if (mac ? !(e.metaKey !== e.ctrlKey) : !e.ctrlKey || e.metaKey) return null
  if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn'].includes(e.key)) return null
  const typed = e.key.toLowerCase()
  // A letter as typed follows the keyboard's layout; anything ⇧ or ⌥ may have changed goes by its place.
  const key = /^[a-z]$/.test(typed) ? typed : (fromCode(e.code) ?? typed)
  return { key, ...(e.shiftKey ? { shift: true } : {}), ...(e.altKey ? { option: true } : {}), ...(ctrl ? { ctrl: true } : {}) }
}

/** The same shortcut. Off a Mac, ⌃ is the shortcut key, so a combo with it is the same as one without. */
export const sameCombo = (a: Combo, b: Combo, mac = isMac()) => a.key === b.key && !!a.shift === !!b.shift && !!a.option === !!b.option && (!mac || !!a.ctrl === !!b.ctrl)

const NAMES: Record<string, [mac: string, other: string]> = {
  arrowleft: ['←', 'Left'],
  arrowright: ['→', 'Right'],
  arrowup: ['↑', 'Up'],
  arrowdown: ['↓', 'Down'],
  tab: ['Tab', 'Tab'],
  enter: ['↩', 'Enter'],
  space: ['Space', 'Space'],
  backspace: ['⌫', 'Backspace'],
  delete: ['⌦', 'Delete'],
}
const keyName = (key: string, mac: boolean) => NAMES[key]?.[mac ? 0 : 1] ?? (key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1))

/** The shortcut as the platform writes it: ⌃⌥⇧⌘ in that order on a Mac, Ctrl+Alt+Shift+ elsewhere. */
export const comboLabel = (c: Combo, mac = isMac()) =>
  mac ? `${c.ctrl ? '⌃' : ''}${c.option ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.ctrl ? '' : '⌘'}${keyName(c.key, mac)}` : `Ctrl+${c.option ? 'Alt+' : ''}${c.shift ? 'Shift+' : ''}${keyName(c.key, mac)}`
