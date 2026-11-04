// Messages written to the agent while its conversation works, waiting to go once it is done.
// The queue lives here rather than in the panel: the panel is made again for each workspace and
// goes away when it closes, and neither should stop a waiting message or lose it. App keeps
// QueueRunner mounted while anything waits, asking the engine how each conversation is doing;
// the panel reads the queue and adds to it.
import { useEffect, useSyncExternalStore } from 'react'
import { agents, isBusy, type PermissionMode } from '@kit/agents'
import type { Attachment } from '@kit/core'

export interface Queued {
  id: string
  /** What the user wrote, as the queue shows it. */
  text: string
  /** The message as the agent gets it, with what was pointed at and the workspaces as they were when it was written. */
  prompt: string
  /** What the panel added to the prompt after what was written: what was pointed at, the workspaces. An edit keeps it. */
  context?: string
  files: Attachment[]
  /** The model, effort and permission mode picked when it was written, which it goes with whatever was picked since. */
  model?: string
  effort?: string
  permission?: PermissionMode
  /** Sent to steer: the agent was stopped for it, so it goes even though the conversation was stopped. */
  now?: boolean
  /** Going to the engine right now. It stays in the queue until the engine has taken it. */
  sending?: boolean
  /** Why the engine turned it down. It, and the ones after it, wait until the user tries it again or takes it off. */
  failed?: string
  /** Being edited: it, and the ones after it, wait until the edit is saved or put down. */
  editing?: boolean
}

const KEY = 'sb.agent.queue'
type Queues = Record<string, Queued[]>

const stored = (): Queues => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    // A send cut off by the app closing did not finish here, so it goes again; a steer cut off
    // waits for the user like the rest, since the stop it was for is long over, and so does an
    // edit left open, with its last saved words.
    return Object.fromEntries(Object.entries(saved as Queues).filter(([, q]) => Array.isArray(q)).map(([id, q]) => [id, q.map(({ sending: _, now: __, editing: ___, ...x }) => x)]))
  } catch {
    // Something unreadable in storage loses the queue, not the app.
    return {}
  }
}
let queues = stored()
const listeners = new Set<() => void>()
const set = (f: (q: Queues) => Queues) => {
  queues = Object.fromEntries(Object.entries(f(queues)).filter(([, q]) => q.length))
  // What was heard about a conversation with nothing waiting is out of date by the time something
  // waits again: the runner asks afresh then.
  for (const session of known.keys()) if (!queues[session]) known.delete(session)
  // A draft goes with its edit: saved, put down, or its message gone.
  for (const key of drafts.keys()) if (!Object.entries(queues).some(([session, q]) => q.some((x) => x.editing && key === draftKey(session, x.id)))) drafts.delete(key)
  try {
    localStorage.setItem(KEY, JSON.stringify(queues))
  } catch {
    // Storage full: the queue still works, it just does not outlive the app.
  }
  for (const l of listeners) l()
  pump()
}
/**
 * What is typed into a message being edited, kept here rather than in the editor: the panel's
 * editor goes away with History, another tab or another workspace, and the edit is still open
 * (and the queue held) when it comes back. Not stored: an edit left open does not outlive the app.
 */
const drafts = new Map<string, string>()
const draftKey = (session: string, item: string) => `${session} ${item}`
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

/** Every conversation's waiting messages, oldest first. */
export const useQueues = () => useSyncExternalStore(subscribe, () => queues)
/** Whether anything waits at all, without following every change to the queue. */
export const useAnyQueued = () => useSyncExternalStore(subscribe, () => Object.keys(queues).length > 0)

/** How each conversation is doing, as the engine last said. Only the engine: what a panel has read may be an older turn's. */
const known = new Map<string, string>()
/** Conversations that took a message a moment ago, before what is heard about them can show it. */
const holding = new Set<string>()
let toast: (text: string) => void = () => {}

export const queue = {
  add: (session: string, item: Queued) => set((q) => ({ ...q, [session]: [...(q[session] ?? []), item] })),
  remove: (session: string, item: string) => set((q) => ({ ...q, [session]: (q[session] ?? []).filter((x) => x.id !== item || x.sending) })),
  /** Lets a message the engine turned down go again. */
  retry: (session: string, item: string) => set((q) => ({ ...q, [session]: (q[session] ?? []).map((x) => (x.id === item ? { ...x, failed: undefined } : x)) })),
  /** Holds a message while it is edited, or lets it go again unchanged. Not one already on its way. */
  editing: (session: string, item: string, editing: boolean) =>
    set((q) => ({ ...q, [session]: (q[session] ?? []).map((x) => (x.id === item && !x.sending ? { ...x, editing: editing || undefined } : x)) })),
  /** What was typed into a message being edited, if anything yet. */
  draft: (session: string, item: string) => drafts.get(draftKey(session, item)),
  /** Keeps what is typed into a message being edited, without telling anyone: only its editor shows it. */
  setDraft: (session: string, item: string, text: string) => void drafts.set(draftKey(session, item), text),
  /** Puts new words in a message and lets it go again; what the panel added to it stays as it was. */
  rewrite: (session: string, item: string, text: string) =>
    set((q) => ({ ...q, [session]: (q[session] ?? []).map((x) => (x.id === item && !x.sending ? { ...x, text, prompt: text + contextOf(x), editing: undefined } : x)) })),
  /** Takes back a steer whose stop did not go through: the message waits its turn like the others. */
  unsteer: (session: string, item: string) => set((q) => ({ ...q, [session]: (q[session] ?? []).map((x) => (x.id === item ? { ...x, now: undefined } : x)) })),
  /** Puts a message first and lets it through a stop; the caller stops the agent. */
  steer: (session: string, item: string) =>
    set((q) => {
      const all = q[session] ?? []
      const it = all.find((x) => x.id === item)
      return it ? { ...q, [session]: [{ ...it, now: true }, ...all.filter((x) => x !== it)] } : q
    }),
  /** What a conversation is doing, as the engine says. */
  heard: (session: string, status: string) => {
    if (known.get(session) === status) return
    known.set(session, status)
    pump()
  },
  /** Sends the next message of a conversation that is done. `force` sends it after a stop, too. */
  next: (session: string, force = false) => void dispatch(session, force),
}

/**
 * What follows the written words in a message's prompt. Messages queued before edits came along
 * did not keep it: the panel's additions start with the blocks `said` in the panel looks for.
 */
const contextOf = (x: Queued) => {
  if (x.context !== undefined) return x.context
  const at = x.prompt.search(/\n\n\[(Workspace attached: |I pointed at these parts|Said aloud in voice mode)/)
  return at < 0 ? '' : x.prompt.slice(at)
}
/** The words a message's prompt starts with: what the user wrote, or what was put in its place. */
export const leadOf = (x: Queued) => x.prompt.slice(0, x.prompt.length - contextOf(x).length)

/** A turn that ended any way but finishing: stopped, failed, cut off. The queue waits for the user after one. */
export const HOLDS = ['cancelled', 'failed', 'interrupted', 'unknown']

/**
 * A turn that did not finish (stopped, failed) holds its conversation's queue until the user
 * sends again (or sends the next one by hand), unless it was stopped to steer: the rest should not
 * pile into a broken provider, or go after the user stopped the agent. The engine refuses a message while a conversation works,
 * so one sent on a stale status stays first in line and goes the next time it is done.
 */
const dispatch = async (session: string, force = false) => {
  const next = queues[session]?.[0]
  const status = known.get(session)
  if (!next || next.sending || next.failed || next.editing || holding.has(session) || !status || isBusy(status) || (HOLDS.includes(status) && !force && !next.now)) return
  holding.add(session)
  const mark = (sending: boolean) => set((q) => ({ ...q, [session]: (q[session] ?? []).map((x) => (x.id === next.id ? { ...x, sending } : x)) }))
  mark(true)
  try {
    await agents.send(session, next.prompt, { model: next.model, effort: next.effort, permission: next.permission, attachments: next.files })
    set((q) => ({ ...q, [session]: (q[session] ?? []).filter((x) => x.id !== next.id) }))
    // It works now, whatever was last heard.
    known.set(session, 'queued')
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    // Refused while the conversation works, it goes the next time it is done. Anything else will
    // not go better by trying again on its own.
    const busy = /busy|active work/i.test(why)
    set((q) => ({ ...q, [session]: (q[session] ?? []).map((x) => (x.id === next.id ? { ...x, sending: false, ...(busy ? {} : { failed: why }) } : x)) }))
    if (!busy) toast(`A queued message did not send: ${why}`)
  } finally {
    // What is heard about the conversation takes a moment to show the message went.
    setTimeout(() => {
      holding.delete(session)
      pump()
    }, 1500)
  }
}
const pump = () => {
  for (const session of Object.keys(queues)) void dispatch(session)
}

/** How often the conversations with waiting messages are asked how they are doing. */
const EVERY = 1500

/**
 * Follows the conversations with waiting messages, panel open or not: App mounts it while anything
 * waits. A conversation archived or deleted takes its waiting messages with it, so they cannot go
 * out unannounced should it come back.
 */
export function QueueRunner({ onError }: { onError: (text: string) => void }) {
  useEffect(() => {
    toast = onError
  }, [onError])
  useEffect(() => {
    let stopped = false
    let looking = false
    const look = async () => {
      if (looking) return
      looking = true
      await Promise.all(
        Object.keys(queues).map(async (session) => {
          const info = await agents.info(session).catch((e: unknown) => (/not found/i.test(e instanceof Error ? e.message : String(e)) ? null : undefined))
          if (stopped || info === undefined) return
          if (!info || info.session.archived_at) {
            const n = queues[session]?.length ?? 0
            set(({ [session]: _, ...rest }) => rest)
            if (n) onError(`${n === 1 ? 'A queued message was' : `${n} queued messages were`} dropped: the conversation was ${info ? 'archived' : 'deleted'}.`)
            return
          }
          queue.heard(session, info.latest_run?.status ?? 'idle')
        }),
      )
      looking = false
    }
    void look()
    // Hidden or not: a minimised window still sends what waits.
    const t = setInterval(() => void look(), EVERY)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [onError])
  return null
}
