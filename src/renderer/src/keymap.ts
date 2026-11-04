// Every shortcut the app has, with the keys it comes with and the ones the user set in its place (Settings ›
// Shortcuts). The commands, their hints and the keys the workspace frames hand over all read them from here.
import { useSyncExternalStore } from 'react'
import { sameCombo, type Combo } from '@kit/keys'
import { bridge } from './api'

export interface Shortcut {
  id: string
  group: 'App' | 'Workspaces' | 'Agent' | 'This workspace'
  title: string
  default: Combo
}

const mac = bridge.platform === 'darwin'

// The agent's keys changed: ⌘D opens it and ⌘T is a new conversation, where it was ⌘T and ⌘N. Installs from before keep
// theirs. Which a window has is decided once, the first time it runs this, and kept: a window that has something of the
// app's stored already is from before.
const EDITION = 'sb.shortcuts.edition'
const edition = (() => {
  const kept = localStorage.getItem(EDITION)
  if (kept === '1' || kept === '2') return kept
  const before = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).some((k) => k?.startsWith('sb.'))
  const next = before ? '1' : '2'
  localStorage.setItem(EDITION, next)
  return next
})()
const legacy = edition === '1'
const nine = (f: (n: number) => Shortcut) => Array.from({ length: 9 }, (_, i) => f(i + 1))

export const SHORTCUTS: Shortcut[] = [
  { id: 'command-bar', group: 'App', title: 'Command bar', default: { key: 'k' } },
  { id: 'settings', group: 'App', title: 'Settings', default: { key: ',' } },
  { id: 'sidebar', group: 'App', title: 'Show or hide the sidebar', default: { key: 'b' } },
  { id: 'connectors', group: 'App', title: 'Connectors', default: { key: 'c', shift: true } },
  { id: 'tools', group: 'App', title: 'Tools', default: { key: 't', shift: true } },
  { id: 'new', group: 'Workspaces', title: 'New workspace', default: { key: 'n', option: true } },
  ...nine((n) => ({ id: `workspace-${n}`, group: 'Workspaces', title: `Workspace ${n} in the list`, default: { key: String(n), option: true } })),
  { id: 'agent', group: 'Agent', title: 'Open or close the agent', default: { key: legacy ? 't' : 'd' } },
  { id: 'agent-new', group: 'Agent', title: 'New conversation', default: { key: legacy ? 'n' : 't' } },
  { id: 'agent-full', group: 'Agent', title: 'Agent full screen, or back beside the workspace', default: { key: 'f', shift: true } },
  { id: 'agent-tab-next', group: 'Agent', title: 'Next tab', default: { key: 'tab', ctrl: true } },
  { id: 'agent-tab-prev', group: 'Agent', title: 'Previous tab', default: { key: 'tab', ctrl: true, shift: true } },
  ...nine((n) => ({ id: `agent-tab-${n}`, group: 'Agent', title: n === 9 ? 'Last tab' : `Tab ${n}`, default: { key: String(n) } })),
  { id: 'point', group: 'Agent', title: 'Point at things for the agent', default: { key: 'e' } },
  { id: 'voice', group: 'Agent', title: 'Voice mode: talk to the agent', default: { key: 'm', shift: true } },
  { id: 'find', group: 'This workspace', title: 'Find in the workspace', default: { key: 'f' } },
  { id: 'find-next', group: 'This workspace', title: 'Next match', default: { key: 'g' } },
  { id: 'find-prev', group: 'This workspace', title: 'Previous match', default: { key: 'g', shift: true } },
  { id: 'back', group: 'This workspace', title: 'Back', default: { key: '[' } },
  { id: 'beside', group: 'This workspace', title: 'Open a workspace to the side', default: { key: '\\' } },
  { id: 'focus-prev', group: 'This workspace', title: 'Focus the previous pane or the agent', default: { key: 'arrowleft', option: true } },
  { id: 'focus-next', group: 'This workspace', title: 'Focus the next pane or the agent', default: { key: 'arrowright', option: true } },
  { id: 'close', group: 'This workspace', title: 'Close the agent tab, or the pane, with the keyboard in it', default: { key: 'w' } },
]

/** Keys that belong to the window or to editing text, which a shortcut cannot take; what they do, to say so. */
const RESERVED: [Combo, string][] = [
  [{ key: 'q' }, 'quits the app'],
  [{ key: 'c' }, 'copies'],
  [{ key: 'v' }, 'pastes'],
  [{ key: 'x' }, 'cuts'],
  [{ key: 'a' }, 'selects all'],
  [{ key: 'z' }, 'undoes'],
  [{ key: 'z', shift: true }, 'redoes'],
  [{ key: 'r' }, 'reloads the window'],
  ...(mac
    ? ([
        [{ key: 'h' }, 'hides the app'],
        [{ key: 'm' }, 'minimises the window'],
        [{ key: 'f', ctrl: true }, 'makes the window full screen'],
      ] satisfies [Combo, string][])
    : ([[{ key: 'y' }, 'redoes']] satisfies [Combo, string][])),
]
/** Why a shortcut cannot have these keys, or null when it can. ⌘W closes the window, unless it is the close shortcut. */
export const reserved = (id: string, c: Combo) => RESERVED.find(([r]) => sameCombo(r, c))?.[1] ?? (id !== 'close' && sameCombo(c, { key: 'w' }) ? 'closes the window' : null)

// What the user set: keys in place of a shortcut's own, or null for none at all.
const STORE = 'sb.shortcuts'
type Overrides = Record<string, Combo | null>
const read = (): Overrides => {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}
let overrides = read()
let version = 0
const listeners = new Set<() => void>()
const save = (next: Overrides) => {
  overrides = next
  if (Object.keys(next).length) localStorage.setItem(STORE, JSON.stringify(next))
  else localStorage.removeItem(STORE)
  version++
  listeners.forEach((f) => f())
}
export const onShortcuts = (f: () => void) => {
  listeners.add(f)
  return () => void listeners.delete(f)
}
/** Rerenders when a shortcut changes. */
export const useShortcuts = () => useSyncExternalStore(onShortcuts, () => version)

const byId = new Map(SHORTCUTS.map((s) => [s.id, s]))
/** The keys for a shortcut now, or undefined when it has none. */
export const comboFor = (id: string): Combo | undefined => (id in overrides ? (overrides[id] ?? undefined) : byId.get(id)?.default)
export const isDefault = (id: string) => !(id in overrides)
/** The shortcut that has these keys now. */
export const holderOf = (c: Combo) => SHORTCUTS.find((s) => {
  const mine = comboFor(s.id)
  return mine && sameCombo(mine, c)
})
/** Gives a shortcut these keys (null: none), taking them from any other that had them. Says which that was. */
export const setCombo = (id: string, c: Combo | null): Shortcut | undefined => {
  const from = c ? holderOf(c) : undefined
  const next = { ...overrides }
  if (from && from.id !== id) next[from.id] = null
  const own = byId.get(id)!.default
  if (c && sameCombo(c, own)) delete next[id]
  else next[id] = c
  save(next)
  return from?.id === id ? undefined : from
}
export const resetCombo = (id: string) => {
  // Its own keys back, taken from whatever has them meanwhile.
  const own = byId.get(id)!.default
  const from = holderOf(own)
  const { [id]: _, ...next } = overrides
  if (from && from.id !== id) next[from.id] = null
  save(next)
  return from?.id === id ? undefined : from
}
export const resetAll = () => save({})
/** Every combo that is some shortcut's now: what the workspace frames hand over to the window. */
export const boundCombos = () => SHORTCUTS.map((s) => comboFor(s.id)).filter((c): c is Combo => !!c)
