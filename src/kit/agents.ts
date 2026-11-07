// Agents, through the native `agents` connector (agentd, in the app).
// Nothing here is privileged: these are plain tool calls any workspace UI could write by hand.
import { useCallback, useEffect, useRef, useState } from 'react'
import { call, useTool, workspace, type Attachment, type ConnectorInfo } from './core'
import { fullPayload } from './toolviews'

export interface SessionSummary {
  id: string
  harness: string
  cwd: string
  labels: Record<string, string>
  status: string
  preview: string | null
  archived_at: string | null
  created_at: string
}
export interface SessionEvent {
  seq: string
  execution_id: string | null
  type: string
  payload: any
}
export interface PendingInput {
  id: string
  kind: 'approval' | 'questions'
  payload: { provider?: string; /** Codex: what it asks, e.g. item/commandExecution/requestApproval. */ method?: string; tool_name?: string; tool_input?: unknown; detail?: unknown; questions?: { id: string; question: string; options?: string[] }[] }
}
const isPendingInput = (p: any): p is PendingInput => typeof p?.id === 'string' && (p.kind === 'approval' || p.kind === 'questions') && !!p.payload && typeof p.payload === 'object'
export interface SessionInfo {
  session: { id: string; harness: string; cwd: string; labels: Record<string, string>; model: string | null; effort?: string | null; permission_mode: PermissionMode | null; archived_at: string | null }
  latest_run: { id: string; status: string } | null
  /** Engine connection ids; match against `agent_connection_id` from useConnectors(). */
  connection_ids?: string[]
}
export interface ProviderModel {
  id: string
  name: string
  description?: string
  default?: boolean
  /** The effort levels this model takes, lowest first. Absent when it has none. */
  efforts?: string[]
  /** The level the agent uses for this model when none is given, when it says. */
  default_effort?: string
}
/** What an agent can do. Decide by these, not by which agent it is. */
export interface ProviderCapabilities {
  /** A conversation goes on from the agent's own session, in a new process. */
  resume: boolean
  /** One process serves the conversation's later messages too. */
  warm: boolean
  interactive_input: boolean
  connections: boolean
  permission_modes: PermissionMode[]
}
export interface Provider {
  /** The agent's id, used as `harness`. */
  name: string
  /** What people call it, e.g. "Claude Code". */
  display_name?: string
  available: boolean
  version: string | null
  /** Whether it is signed in to an account it can run with; null or missing when that could not be told. */
  signed_in?: boolean | null
  models?: ProviderModel[]
  capabilities?: ProviderCapabilities
  /** The CLI command that goes on with a conversation, before its provider session id. */
  resume_command?: string[]
  /** The CLI command that signs in to the agent's account. */
  login_command?: string[]
  /** `browser`: the engine signs in to the agent through the browser (`provider_sign_in`), no terminal needed. */
  sign_in?: 'browser'
}
// Filled from server_status as it arrives, so names read right wherever they are shown.
const names = new Map<string, string>([
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['pi', 'Pi'],
])
export const harnessName = (h: string) => names.get(h) ?? h
const EFFORTS: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
export const effortName = (e: string) => EFFORTS[e] ?? e
export type PermissionMode = 'allow' | 'auto' | 'ask' | 'deny'
/**
 * What each permission mode lets the agent do, as the user picks it, most free first. Outside full
 * access, reading goes on without asking, and so may commands that only read; what the mode governs
 * is changing things. In auto the agent's own reviewer decides that (Claude Code's classifier,
 * Codex's auto review, which also lets it write in its own folder).
 */
export const PERMISSIONS: Record<PermissionMode, { name: string; description: string }> = {
  allow: { name: 'Full access', description: 'Never asks' },
  auto: { name: 'Auto', description: 'Asks when unsure' },
  ask: { name: 'Ask first', description: 'Asks before changes' },
  deny: { name: 'Read only', description: 'Changes nothing' },
}

export interface ModelChoice {
  /** The model to run, always one the agent offers unless `picked.model` named another on purpose. Empty only when the agent lists none. */
  model: string
  /** The effort level for that model; empty when the model takes none. */
  effort: string
  models: ProviderModel[]
  /** The levels `model` takes. */
  efforts: string[]
}
/**
 * What to run for an agent, so that a model and an effort level are always named: what was picked
 * if the agent still offers it, else what the conversation already uses (`session`, from
 * useSessionInfo), else the agent's default model and that model's default effort.
 */
export function chooseModel(provider: Provider | undefined, picked: { model?: string | null; effort?: string | null } = {}, session: { model?: string | null; effort?: string | null } = {}): ModelChoice {
  const models = provider?.models ?? []
  const listed = (id?: string | null) => models.find((m) => m.id === id)
  const usual = models.find((m) => m.default) ?? models[0]
  // A conversation on a model that is not listed (an exact id someone asked for) stays on it.
  const model = listed(picked.model)?.id ?? session.model ?? usual?.id ?? ''
  const of = listed(model) ?? usual
  const efforts = of?.efforts ?? []
  const has = (e?: string | null): e is string => !!e && efforts.includes(e)
  const effort = has(picked.effort) ? picked.effort : has(session.effort) ? session.effort : has(of?.default_effort) ? of.default_effort : has('high') ? 'high' : (efforts[Math.floor(efforts.length / 2)] ?? '')
  return { model, effort, models, efforts }
}

export interface StartOptions {
  prompt: string
  /** A provider's `name`; Claude Code when absent. */
  harness?: string
  /** Ignored: agents can always use every connector. Kept so older workspace code still runs. */
  connectors?: string[]
  cwd?: string
  labels?: Record<string, string>
  /** allow: act freely · ask: approvals come back as pending inputs · deny: read-only */
  permission?: PermissionMode
  instructions?: string
  model?: string
  /** How hard the model thinks: one of the model's `efforts`. */
  effort?: string
  /** Files for the agent to read, from stageFile. It gets read-only copies under .agent-attachments/ in its working directory. */
  attachments?: Attachment[]
}
export interface SendOptions {
  model?: string
  effort?: string
  /** Switches the session to this permission mode from this turn on. */
  permission?: PermissionMode
  attachments?: Attachment[]
}
/** At most 20 files go with one message. */
export const MAX_ATTACHMENTS = 20
const attachmentsArg = (files?: Attachment[]) => (files?.length ? { attachments: files.map((f) => ({ path: f.path, name: f.name })) } : {})

const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted', 'unknown']
export const isTerminal = (status: string) => TERMINAL.includes(status)
export const isBusy = (status: string | undefined) => !!status && status !== 'idle' && !isTerminal(status)

/** Aliases/ids -> the engine connection ids an agent session is granted, plus a note telling the agent which is which. */
export async function resolveGrants(names?: string[]) {
  const { connectors } = await call<{ connectors: ConnectorInfo[] }>('app', 'connector_list')
  const bound = workspace().connectors
  // Agents always have every connector; `names` only matters to callers that want a subset listed.
  const picked = (names ? [...new Set(names.map((n) => bound[n] ?? n))].map((id) => connectors.find((c) => c.id === id)) : connectors).filter((c): c is ConnectorInfo => !!c?.agent_connection_id)
  const note = picked.length
    ? `\n\nYour MCP servers are named by connection id. They are:\n${picked.map((c) => `- mcp__connection_${c.agent_connection_id!.replaceAll('-', '')}__* is the "${c.id}" connector (${c.name}${c.url && !c.native ? `, ${c.url}` : ''})`).join('\n')}`
    : ''
  return { connection_ids: picked.map((c) => c.agent_connection_id!), note }
}

export const agents = {
  /** Start a session and its first run. Returns { session, run }. */
  async start(o: StartOptions) {
    const { providers } = await call<{ providers: Provider[] }>('agents', 'server_status')
    const supportsConnectors = providers.find((p) => p.name === (o.harness ?? 'claude'))?.capabilities?.connections !== false
    const grants = supportsConnectors ? await resolveGrants() : { connection_ids: [], note: '\nThis agent has no Lynx connector access. Work with local files and explain when a task needs connectors.' }
    const aliases = Object.entries(workspace().connectors)
    if (supportsConnectors && aliases.length) grants.note += `\nIn this workspace: ${aliases.map(([alias, id]) => `"${alias}" means the "${id}" connector`).join('; ')}.`
    if (supportsConnectors && grants.note) grants.note += '\nConnectors added later are available too; the app connector\'s connector_list gives each one\'s agent_connection_id, and its server is named mcp__connection_<that id without dashes>.'
    const instructions = `${o.instructions ?? ''}${grants.note}`.trim()
    return call<{ session: { id: string }; run: { id: string; status: string } | null }>('agents', 'session_start', {
      harness: o.harness ?? 'claude',
      prompt: o.prompt,
      ...attachmentsArg(o.attachments),
      ...(o.cwd ? { cwd: o.cwd } : {}),
      connection_ids: grants.connection_ids,
      labels: { title: o.prompt.replace(/\s+/g, ' ').slice(0, 80), ...o.labels },
      config: { permission_mode: o.permission ?? 'allow', ...(instructions ? { instructions } : {}), ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) },
    })
  },
  /** Continue a session. `model`, `effort` and `permission` switch the session to that model, effort level or permission mode from this turn on; `attachments` go with this message. */
  send: (sessionId: string, prompt: string, opts: SendOptions = {}) => call<{ id: string; status: string }>('agents', 'session_send', { id: sessionId, prompt, ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}), ...(opts.permission ? { permission_mode: opts.permission } : {}), ...attachmentsArg(opts.attachments) }),
  /** Harness, model and granted connectors of a session. */
  info: (sessionId: string) => call<SessionInfo>('agents', 'session_get', { id: sessionId }),
  /** The agent's own id for a session (the Claude Code session, the Codex thread), once it has run; with it the session can go on in that agent's CLI. */
  providerSession: (sessionId: string) => call<{ session: { harness: string; cwd: string; provider_session_id: string | null } }>('agents', 'session_get', { id: sessionId, view: 'full' }).then((r) => r.session),
  /** Replace the connectors a session may use (aliases or ids). Applies from its next run. */
  async setConnectors(sessionId: string, names: string[]) {
    const grants = await resolveGrants(names)
    return call('agents', 'session_connections_set', { id: sessionId, connection_ids: grants.connection_ids })
  },
  /** Let a session use one more connector, keeping the ones it has. */
  async grant(sessionId: string, name: string) {
    const [info, grants] = await Promise.all([agents.info(sessionId), resolveGrants([name])])
    const ids = [...new Set([...(info.connection_ids ?? []), ...grants.connection_ids])]
    if (ids.length === (info.connection_ids ?? []).length) return
    await call('agents', 'session_connections_set', { id: sessionId, connection_ids: ids })
  },
  cancel: (runId: string) => call('agents', 'run_cancel', { id: runId }),
  archive: (sessionId: string, archived = true) => call('agents', 'session_archive', { id: sessionId, archived }),
  respond: (inputId: string, response: { decision?: 'allow' | 'deny'; message?: string; answers?: Record<string, string[]> }) => call('agents', 'input_respond', { id: inputId, response }),
  /**
   * A workspace sees the conversations it started. Call this to ask the user for every
   * conversation on the machine (an overview board needs it); it resolves once they agree.
   */
  requestAll: () => call('app', 'request_access', { scope: 'all-sessions' }),
  /** Every session matching the labels, newest first. */
  async list(labels: Record<string, string> = {}) {
    const items: SessionSummary[] = []
    let after: string | undefined
    for (let page = 0; page < 20; page++) {
      const r = await call<{ items: SessionSummary[]; next_cursor: string | null; has_more: boolean }>('agents', 'session_list', { labels, limit: 500, ...(after ? { after } : {}) })
      items.push(...r.items)
      if (!r.has_more || !r.next_cursor) break
      after = r.next_cursor
    }
    return items.reverse()
  },
}

/** Sessions matching the labels, newest first, refreshed while anything is running. */
export function useSessions(labels: Record<string, string> = {}, opts: { refresh?: number } = {}) {
  const [sessions, setSessions] = useState<SessionSummary[]>()
  const [error, setError] = useState<Error>()
  const key = JSON.stringify(labels)
  const reload = useCallback(
    () =>
      agents.list(JSON.parse(key)).then(
        (s) => {
          setSessions(s)
          setError(undefined)
        },
        (e) => setError(e),
      ),
    [key],
  )
  const anyBusy = !!sessions?.some((s) => isBusy(s.status))
  useEffect(() => {
    void reload()
    const t = setInterval(() => document.visibilityState === 'visible' && void reload(), anyBusy ? 1500 : (opts.refresh ?? 8000))
    return () => clearInterval(t)
  }, [reload, anyBusy, opts.refresh])
  return { sessions, error, reload }
}

export interface LiveSession {
  events: SessionEvent[]
  /** The part of the answer written so far, while the agent is still writing it. */
  streaming: string
  /** queued | starting | running | waiting_for_input | completed | failed | … | idle */
  status: string
  busy: boolean
  runId: string | null
  pending: PendingInput[]
  loading: boolean
  error: Error | undefined
  /** Resolves to the turn the message started. */
  send: (prompt: string, opts?: SendOptions) => Promise<{ id: string; status: string } | undefined>
  cancel: () => Promise<void>
  respond: (inputId: string, response: Parameters<typeof agents.respond>[1]) => Promise<void>
}

const LIFECYCLE = ['queued', 'starting', 'launched', ...TERMINAL]
// Everything a transcript needs except `assistant_delta`. Deltas are a live preview of a message
// that is recorded whole afterwards, so replaying history skips them.
const RECORDED = ['session_created', 'user_message', 'assistant_message', 'tool_invocation', 'tool_result', 'input_request', 'input_delivered', 'input_stale', 'unsupported_input', ...LIFECYCLE]

/** Set once the backend turns down waiting reads; every session view polls from then on. */
let pollOnly = false

const NO_EVENTS: SessionEvent[] = []

/** Follow one session: its events as they are captured, whether it is working, and what it is waiting on. */
export function useSession(sessionId: string | null | undefined): LiveSession {
  const [held, setEvents] = useState<SessionEvent[]>([])
  const [heldLoading, setLoading] = useState(!!sessionId)
  // The session what is held is for. Just after the session changes, until it is read afresh, what is held is
  // still the last one's: none of it is given out as this one's (a caller would take another's messages for its own).
  const [of, setOf] = useState(sessionId)
  const events = of === sessionId ? held : NO_EVENTS
  const loading = of === sessionId ? heldLoading : !!sessionId
  const [error, setError] = useState<Error>()
  const state = useRef({ cursor: '0', busy: false, live: false, partial: '', failures: 0 })
  const [streaming, setStreaming] = useState('')
  const wake = useRef<() => void>(() => {})

  useEffect(() => {
    setEvents([])
    setOf(sessionId)
    setError(undefined)
    setLoading(!!sessionId)
    state.current = { cursor: '0', busy: false, live: false, partial: '', failures: 0 }
    setStreaming('')
    if (!sessionId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let inflight = false
    const tick = async () => {
      if (stopped || inflight) return
      inflight = true
      let delay = 2500
      try {
        // Catch up on recorded events first; once level with the session, follow it live, deltas included.
        // Following waits on the backend for the next event, so it arrives as soon as it is recorded.
        // After a failed read, the next one answers at once, so an error goes as soon as the backend is back.
        const waiting = state.current.live && !pollOnly && !state.current.failures
        const page = await call<{ items: SessionEvent[]; next_cursor: string; has_more: boolean }>('agents', 'session_history', { id: sessionId, after: state.current.cursor, limit: 500, ...(state.current.live ? {} : { types: RECORDED }), ...(waiting ? { wait_ms: 20000 } : {}) }).catch((e) => {
          // A backend without waiting reads (the old engine, or one older than this UI) is polled instead, straight away.
          if (!waiting || !/wait_ms/.test(String(e?.message ?? e))) throw e
          pollOnly = true
          return null
        })
        if (stopped) return
        if (!page) {
          delay = 0
          inflight = false
          timer = setTimeout(tick, delay)
          return
        }
        if (page.items.length) {
          // History shortens a long payload; a request is answered by its id and kind, so it is read whole.
          // A read that fails is tried again with the page (the agent would wait on a request left out); one that keeps failing is let go.
          const items = await Promise.all(
            page.items.map((e) =>
              (e as { payload_truncated?: boolean }).payload_truncated && e.type === 'input_request'
                ? fullPayload(sessionId, e.seq).then(
                    (payload) => ({ ...e, payload }),
                    (err) => {
                      if (state.current.failures < 2) throw err
                      return e
                    },
                  )
                : e,
            ),
          )
          if (stopped) return
          state.current.cursor = page.next_cursor
          const recorded: SessionEvent[] = []
          for (const e of items) {
            // Deltas only feed the text being written right now; the whole message replaces them.
            if (e.type === 'assistant_delta') {
              state.current.partial += String(e.payload?.text ?? '')
              continue
            }
            recorded.push(e)
            if (e.type === 'assistant_message' || e.type === 'tool_invocation' || TERMINAL.includes(e.type)) state.current.partial = ''
            if (e.type === 'user_message' || e.type === 'queued') state.current.busy = true
            else if (TERMINAL.includes(e.type)) state.current.busy = false
          }
          if (recorded.length) setEvents((prev) => [...prev, ...recorded])
          setStreaming(state.current.partial)
        }
        state.current.failures = 0
        setError(undefined)
        setLoading(false)
        if (!page.has_more) state.current.live = true
        delay = page.has_more || waiting ? 0 : state.current.busy ? 80 : 2500
      } catch (e) {
        // One failure is tried again straight away and not shown: a read cut off by the background
        // service being replaced (a new build) works the next time.
        if (++state.current.failures > 1) {
          setError(e instanceof Error ? e : new Error(String(e)))
          setLoading(false)
        } else delay = 0
      }
      inflight = false
      timer = setTimeout(tick, delay)
    }
    wake.current = () => {
      clearTimeout(timer)
      void tick()
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [sessionId])

  // Derived from the event log alone, so every viewer of a session agrees.
  let status = 'idle'
  let runId: string | null = null
  const open = new Map<string, PendingInput>()
  for (const e of events) {
    if (e.type === 'user_message') runId = e.execution_id
    if (LIFECYCLE.includes(e.type)) status = e.type === 'launched' ? 'running' : e.type
    if (e.type === 'input_request') {
      // One that cannot be answered from here (its payload could not be read) is left out rather than drawn wrong.
      if (isPendingInput(e.payload)) open.set(e.payload.id, e.payload)
      status = 'waiting_for_input'
    }
    if (e.type === 'input_delivered' || e.type === 'input_stale' || e.type === 'input_response') {
      open.delete(e.payload?.id)
      if (!open.size && status === 'waiting_for_input') status = 'running'
    }
    if (TERMINAL.includes(e.type)) open.clear()
  }
  const busy = isBusy(status)

  const send = useCallback(
    async (prompt: string, opts: SendOptions = {}) => {
      if (!sessionId) return
      const run = await agents.send(sessionId, prompt, opts)
      state.current.busy = true
      wake.current()
      return run
    },
    [sessionId],
  )
  const cancel = useCallback(async () => {
    if (runId) await agents.cancel(runId)
  }, [runId])
  const respond = useCallback<LiveSession['respond']>(async (inputId, response) => {
    await agents.respond(inputId, response)
  }, [])

  const current = of === sessionId
  return { events, streaming: busy && current ? streaming : '', status, busy, runId, pending: [...open.values()], loading, error: current ? error : undefined, send, cancel, respond }
}

/** What the engine can run on this machine: each available agent with the models it offers. */
export function useProviders() {
  const q = useTool<{ providers: Provider[]; supervisor: { healthy?: boolean } | null }>('agents', 'server_status', {}, { staleMs: 60000 })
  for (const p of q.data?.providers ?? []) if (p.display_name) names.set(p.name, p.display_name)
  return { providers: (q.data?.providers ?? []).filter((p) => p.available), healthy: !!q.data?.supervisor?.healthy, loading: q.loading, error: q.error }
}

/** Harness, model and granted connectors of one session. */
export function useSessionInfo(sessionId: string | null | undefined) {
  const q = useTool<SessionInfo>('agents', 'session_get', { id: sessionId ?? '' }, { enabled: !!sessionId, staleMs: 1000 })
  return { info: sessionId ? q.data : undefined, reload: q.reload, loading: q.loading }
}
