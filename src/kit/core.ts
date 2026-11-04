// The whole surface a workspace UI has: call a tool on a connector. Everything else in the kit is
// convenience built on that one function. Inside a workspace frame calls travel to the host window
// by postMessage; the host's own panels use the same kit with a direct transport.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReadRequest } from '../shared/reads'

export interface WorkspaceMeta {
  id: string
  name: string
  dir: string
  /** alias -> connector id */
  connectors: Record<string, string>
}

/** A file on this machine, ready to go to an agent with a message (`attachments` in agents.start and send). */
export interface Attachment {
  path: string
  name: string
  size: number
}

export interface Transport {
  call: (connector: string, tool: string, args: Record<string, unknown>, read?: ReadRequest) => Promise<unknown>
  post: (type: string, payload?: Record<string, unknown>) => void
  /** Turn a file the user dropped, pasted or picked into one an agent can be given. */
  stage?: (file: File) => Promise<Attachment>
  workspace: WorkspaceMeta | null
}

declare global {
  interface Window {
    __SB_WORKSPACE__?: WorkspaceMeta
  }
}

export interface AppChange { connector?: string; errorsOnly?: boolean }
const changeListeners = new Set<(change: AppChange) => void>()
/** App state refreshes native reads; connector-scoped changes refresh that connector's data. */
export const onAppChange = (f: (change: AppChange) => void) => {
  changeListeners.add(f)
  return () => void changeListeners.delete(f)
}
export const emitAppChange = (change: AppChange = {}) => changeListeners.forEach((f) => f(change))

function frameTransport(): Transport {
  let seq = 0
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  window.addEventListener('message', (e) => {
    const m = e.data
    if (e.source !== window.parent || !m || m.sb !== 1) return
    if (m.type === 'result') {
      const w = waiting.get(m.id)
      waiting.delete(m.id)
      if (m.ok) w?.resolve(m.data)
      else w?.reject(new Error(m.error))
    } else if (m.type === 'changed') emitAppChange({ connector: typeof m.connector === 'string' ? m.connector : undefined, errorsOnly: m.errorsOnly === true })
    // Only Home is sent one: it is the app's own page, and wears the app's theme.
    else if (m.type === 'theme') document.documentElement.dataset.sbTheme = String(m.theme)
  })
  const post = (type: string, payload: Record<string, unknown> = {}) => window.parent.postMessage({ sb: 1, type, ...payload }, '*')
  const ask = (type: string, payload: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++seq
      waiting.set(id, { resolve, reject })
      post(type, { id, ...payload })
    })
  return {
    workspace: window.__SB_WORKSPACE__ ?? null,
    post,
    call: (connector, tool, args, read) => ask('call', { connector, tool, args, read }),
    // Files cross to the host window as they are; it does the staging.
    stage: (file) => ask('stage', { file }) as Promise<Attachment>,
  }
}

let transport: Transport | undefined
export const setTransport = (t: Transport) => (transport = t)
export const getTransport = () => (transport ??= frameTransport())

/** The workspace this UI runs in. */
export const workspace = (): WorkspaceMeta => getTransport().workspace ?? { id: '', name: '', dir: '', connectors: {} }

/**
 * Call a tool on a connector. `connector` is an alias bound to this workspace, or a connector id.
 * Resolves with the tool's data (structured content or parsed JSON; plain text otherwise) and
 * rejects with an Error when the tool reports one.
 */
export const call = <T = any>(connector: string, tool: string, args: Record<string, unknown> = {}): Promise<T> => getTransport().call(connector, tool, args) as Promise<T>

/**
 * Make a file the user dropped, pasted or picked available to agents: resolves with the
 * attachment to pass to agents.start or send. Files elsewhere than the home folder, and ones with
 * no file behind them (a pasted screenshot), are copied into the app's data first.
 */
export const stageFile = (file: File): Promise<Attachment> => {
  const t = getTransport()
  return t.stage ? t.stage(file) : Promise.reject(new Error('Files cannot be attached here.'))
}

/** Draft meta help (onboarding or workspace repair) in the sidebar. Operational tasks use agents in the workspace UI. */
export const askAgent = (prompt: string) => getTransport().post('ask-agent', { prompt })
/** Switch the window to another workspace, optionally at one of its pages. */
export const openWorkspace = (id: string, path?: string) => getTransport().post('open-workspace', { workspace: id, path })
export const openExternal = (url: string) => getTransport().post('open-external', { url })
/** Open the app's "add a connector" dialog, optionally prefilled. */
export const openConnectorDialog = (preset: { name?: string; url?: string; reason?: string; connector?: string } = {}) => getTransport().post('connector-dialog', { preset })
/** Turn Point on or off: the user clicks parts of the page to send them to the agent. Same as ⌘E. */
export const togglePoint = () => getTransport().post('command', { id: 'point' })
/** Open (or close) the agent panel beside the workspace. Same as its shortcut (⌘D, or ⌘T in installs from before ⌘D). */
export const toggleAgent = () => getTransport().post('command', { id: 'agent' })
/** Go to the user's connectors in settings. */
export const showConnectors = () => getTransport().post('command', { id: 'connectors' })
/** Go to the templates a new workspace can start from. */
export const showTemplates = () => getTransport().post('command', { id: 'new' })
/** Open the command bar (⌘K): every place and action, searchable. */
export const openCommandBar = () => getTransport().post('command', { id: 'command-bar' })
/** Go to the schedules in settings: everything that runs on its own. */
export const showSchedules = () => getTransport().post('command', { id: 'schedules' })
export const toast = (text: string, tone: 'info' | 'good' | 'bad' = 'info') => getTransport().post('toast', { text, tone })

// ── cached reads ────────────────────────────────────────────────────────────
interface Entry {
  data?: unknown
  error?: Error
  at: number
  promise?: Promise<unknown>
  listeners: Set<() => void>
}
const cache = new Map<string, Entry>()
const entry = (key: string) => {
  let e = cache.get(key)
  if (!e) cache.set(key, (e = { at: 0, listeners: new Set() }))
  return e
}
const fetchInto = (e: Entry, connector: string, tool: string, args: Record<string, unknown>, read: ReadRequest) => {
  if (e.promise) return e.promise
  e.promise = getTransport().call(connector, tool, args, read)
    .then(
      (data) => {
        e.data = data
        e.error = undefined
      },
      (error) => {
        e.error = error
      },
    )
    .finally(() => {
      e.at = Date.now()
      e.promise = undefined
      e.listeners.forEach((l) => l())
    })
  e.listeners.forEach((l) => l())
  return e.promise
}

export interface ToolQuery<T> {
  data: T | undefined
  error: Error | undefined
  /** true until the first answer */
  loading: boolean
  /** true whenever a request is in flight */
  fetching: boolean
  reload: () => Promise<unknown>
}

/**
 * Read from a connector and keep the answer fresh. Results are cached by (connector, tool, args),
 * shared between components, and shown immediately on remount while a refetch runs.
 * `refresh` polls every N ms; `enabled: false` skips the call (e.g. while an argument is missing).
 */
export function useTool<T = any>(connector: string, tool: string, args: Record<string, unknown> = {}, opts: { refresh?: number; enabled?: boolean; staleMs?: number } = {}): ToolQuery<T> {
  const enabled = opts.enabled !== false
  const argsKey = JSON.stringify(args)
  const key = `${connector}\n${tool}\n${argsKey}`
  const e = entry(key)
  const subscribe = useCallback(
    (l: () => void) => {
      e.listeners.add(l)
      return () => void e.listeners.delete(l)
    },
    [e],
  )
  const snap = useSyncExternalStore(subscribe, () => `${e.at}:${e.promise ? 1 : 0}`)
  void snap
  // JSON cannot carry Infinity; the service bounds the requested age independently.
  const staleMs = Number.isFinite(opts.staleMs ?? 2000) ? Math.max(0, opts.staleMs ?? 2000) : Number.MAX_SAFE_INTEGER
  const load = useCallback((fresh = false) => fetchInto(e, connector, tool, JSON.parse(argsKey), { staleMs, fresh }), [key, e, connector, tool, argsKey, staleMs])
  const reload = useCallback(() => load(true), [load])
  useEffect(() => {
    if (!enabled) return
    // Never fetched, or older than the caller tolerates.
    if (e.at === 0 || Date.now() - e.at > (opts.staleMs ?? 2000)) void load()
    const off = onAppChange((change) => {
      const id = workspace().connectors[connector] ?? connector
      // Custom tools receive scoped definition/recovery events, avoiding a loop on run completion.
      if (change.connector) {
        if (change.connector === id && (!change.errorsOnly || e.error)) void load(true)
      } else if (['app', 'agents'].includes(id)) void load(true)
    })
    const timer = opts.refresh ? setInterval(() => document.visibilityState === 'visible' && void reload(), opts.refresh) : undefined
    return () => {
      off()
      clearInterval(timer)
    }
  }, [enabled, load, reload, opts.refresh, opts.staleMs, e, connector])
  return { data: e.data as T | undefined, error: e.error, loading: enabled && e.at === 0, fetching: !!e.promise, reload }
}

/** Wrap something that changes the world (a tool call, starting an agent) with running/error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<Error>()
  const latest = useRef(fn)
  latest.current = fn
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setRunning(true)
    setError(undefined)
    try {
      return await latest.current(...args)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      return undefined
    } finally {
      setRunning(false)
    }
  }, [])
  return { run, running, error, clearError: () => setError(undefined) }
}

/**
 * State that survives reloads and rebuilds. It lives in the app's store under the collection
 * `ui/<workspace id>` unless `collection` names another, which is how workspaces (and tools) share.
 */
export function useStored<T>(key: string, initial: T, opts: { collection?: string } = {}): [T, (next: T | ((prev: T) => T)) => void, boolean] {
  const ws = workspace().id
  const collection = opts.collection ?? `ui/${ws}`
  const q = useTool<{ value: T | null }>('app', 'db_get', { collection, key }, { enabled: !!ws, staleMs: Infinity })
  const [local, setLocal] = useState<{ v: T } | null>(null)
  const value = local ? local.v : (q.data?.value ?? initial)
  const ref = useRef(value)
  ref.current = value
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(ref.current) : next
      ref.current = v
      setLocal({ v })
      if (!ws) return
      void (v === null || v === undefined ? call('app', 'db_delete', { collection, key }) : call('app', 'db_put', { collection, key, value: v }))
    },
    [ws, key, collection],
  )
  return [value, set, !q.loading]
}

export interface NotificationInfo {
  id: number
  workspace: string
  text: string
  link?: string
  by: string
  at: string
  read: boolean
}
/**
 * Tell the user something happened, for when they are looking elsewhere: it counts beside the
 * workspace in the sidebar and is listed in the notifications drawer. `link` is a page of the
 * workspace ("/prs/42") that clicking it opens. Defaults to this workspace.
 */
export const notifyUser = (text: string, opts: { link?: string; workspace?: string } = {}) => call<{ notification: NotificationInfo; unread: number }>('app', 'notification_send', { workspace: opts.workspace ?? workspace().id, text, link: opts.link })
/** This workspace's notifications, newest first, kept current. */
export function useNotifications(opts: { unread?: boolean } = {}) {
  const id = workspace().id
  const q = useTool<{ notifications: NotificationInfo[] }>('app', 'notification_list', { workspace: id, unread: !!opts.unread }, { enabled: !!id, staleMs: 500 })
  const notifications = q.data?.notifications ?? []
  return {
    notifications,
    unread: notifications.filter((n) => !n.read).length,
    loading: q.loading,
    /** One by id, or all of this workspace's. */
    markRead: (which?: number) => call('app', 'notification_read', which === undefined ? { workspace: id } : { workspace: id, id: which }).then(() => q.reload()),
  }
}

export interface ConnectorInfo {
  id: string
  name: string
  native: boolean
  transport: string
  url?: string
  status: string
  error?: string
  has_credentials: boolean
  /** Set for an HTTP API added as a connector: how it takes its key (never the key). */
  api?: { auth_type: 'none' | 'bearer' | 'basic' | 'header' | 'query'; auth_name: string | null; headers: Record<string, string>; methods: string[] | null; docs_url: string | null; notes: string | null; check_path: string | null }
  agent_connection_id: string | null
  tool_count: number
}
/** Every connector the user has, with live status. */
export function useConnectors() {
  const q = useTool<{ connectors: ConnectorInfo[] }>('app', 'connector_list', {}, { staleMs: 500 })
  return { connectors: q.data?.connectors ?? [], loading: q.loading, reload: q.reload }
}
/** The connector behind one of this workspace's aliases. */
export function useConnector(alias: string) {
  const { connectors, loading } = useConnectors()
  const id = workspace().connectors[alias] ?? alias
  return { connector: connectors.find((c) => c.id === id), loading }
}

export function useNow(everyMs = 30000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}
