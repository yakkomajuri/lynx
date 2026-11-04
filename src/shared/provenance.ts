// Where a conversation came from, read back from the labels the app put on it as it started
// (BY_LABEL and the rest, in types.ts). Conversations from before those labels, or from outside the
// app, still say what they can: the agent panel's own, and a workspace's by its ownership label.
import { BY_LABEL, CRON_LABEL, OWNER_LABEL, SCHEDULE_LABEL, VIA_LABEL } from './types'

/** What ran a custom tool that started an agent. */
export type Via = { kind: 'schedule'; id: string } | { kind: 'workspace'; workspace: string } | { kind: 'tool'; tool: string } | { kind: 'agent' } | { kind: 'you' } | { kind: 'unknown' }

export type Origin =
  /** A conversation in the agent panel. */
  | { kind: 'panel' }
  /** A workspace's page, through the kit. */
  | { kind: 'workspace'; workspace: string }
  | { kind: 'tool'; tool: string; via: Via }
  /** An agent, through the agents connector. */
  | { kind: 'agent' }
  /** An agent schedule, in the engine. */
  | { kind: 'schedule'; name?: string; cron?: string }
  /** The app on the user's behalf, outside the panel (a security review, say). */
  | { kind: 'you' }
  | { kind: 'unknown' }

const after = (s: string, prefix: string) => (s.startsWith(prefix) ? s.slice(prefix.length) : null)
/** The workspace id in an ownership label, `<id>@<created at>`. */
const owner = (label: string | undefined) => {
  if (!label) return null
  const at = label.lastIndexOf('@')
  return at > 0 ? label.slice(0, at) : label
}

const viaOf = (by: string | undefined): Via => {
  if (!by) return { kind: 'unknown' }
  const schedule = after(by, 'schedule:')
  if (schedule) return { kind: 'schedule', id: schedule }
  const workspace = after(by, 'workspace:')
  if (workspace) return { kind: 'workspace', workspace }
  const tool = after(by, 'tool:')
  if (tool) return { kind: 'tool', tool }
  if (by === 'agent') return { kind: 'agent' }
  if (by === 'user' || by === 'app') return { kind: 'you' }
  return { kind: 'unknown' }
}

export function originOf(labels: Record<string, string>): Origin {
  // The panel labels its own conversations; it is where the user talks to the agent.
  if (labels.kind === 'agent' && labels.conversation) return { kind: 'panel' }
  const by = labels[BY_LABEL]
  if (!by) {
    const ws = owner(labels[OWNER_LABEL])
    return ws ? { kind: 'workspace', workspace: ws } : { kind: 'unknown' }
  }
  if (by === 'schedule') return { kind: 'schedule', ...(labels[SCHEDULE_LABEL] ? { name: labels[SCHEDULE_LABEL] } : {}), ...(labels[CRON_LABEL] ? { cron: labels[CRON_LABEL] } : {}) }
  const tool = after(by, 'tool:')
  if (tool) return { kind: 'tool', tool, via: viaOf(labels[VIA_LABEL]) }
  const via = viaOf(by)
  if (via.kind === 'workspace') return via
  if (via.kind === 'agent' || via.kind === 'you') return via
  return { kind: 'unknown' }
}

/** The workspace a conversation belongs to: the one it is about, the one that started it, or the one whose page ran the tool that did. */
export function workspaceOf(labels: Record<string, string>): string | null {
  if (labels.workspace) return labels.workspace
  const o = originOf(labels)
  if (o.kind === 'workspace') return o.workspace
  if (o.kind === 'tool' && o.via.kind === 'workspace') return o.via.workspace
  return owner(labels[OWNER_LABEL])
}
