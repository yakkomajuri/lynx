// Messages said aloud, shown in their conversation from the moment they go until that conversation has them. They are
// kept here, not in the agent panel: the panel is drawn anew when the workspace on screen changes, and what is on its
// way goes on across that.
import { useSyncExternalStore } from 'react'
import type { SessionEvent } from '@kit/agents'

export interface Outgoing {
  key: string
  /** The tab it went from: a conversation's id, or a new conversation's key until the conversation it starts has one. */
  tab: string
  text: string
  /** The turn it started, once the agent has taken it: the conversation has the message when its history has that turn's. */
  run?: string
}

let all: Outgoing[] = []
const listeners = new Set<() => void>()
const put = (next: Outgoing[]) => {
  all = next
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

/** Whether these events (one conversation's own) hold the message: the user's message of the turn it started. */
export const delivered = (o: Outgoing, events: SessionEvent[]) => !!o.run && events.some((e) => e.type === 'user_message' && e.execution_id === o.run)

export const outgoing = {
  /** It goes from this tab now. */
  add: (tab: string, text: string) => {
    const key = Math.random().toString(36).slice(2, 10)
    put([...all, { key, tab, text }])
    return key
  },
  /** The agent took it, as this turn. With no turn to know it by, it is not shown any longer: the conversation's history has it. */
  sent: (key: string, run?: string) => put(run ? all.map((o) => (o.key === key ? { ...o, run } : o)) : all.filter((o) => o.key !== key)),
  /** It did not go. */
  drop: (key: string) => put(all.filter((o) => o.key !== key)),
  /** A new conversation started from the tab: what was on its way from there is on its way to that conversation. */
  move: (from: string, to: string) => all.some((o) => o.tab === from) && put(all.map((o) => (o.tab === from ? { ...o, tab: to } : o))),
  /** The conversation's own events, as read: the messages they hold are no longer on their way. */
  settle: (sessionId: string | null, events: SessionEvent[]) => {
    const left = all.filter((o) => o.tab !== sessionId || !delivered(o, events))
    if (left.length !== all.length) put(left)
  },
  list: () => all,
}

export const useOutgoing = () => useSyncExternalStore(subscribe, () => all)
