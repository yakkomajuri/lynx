// Connectors are MCP servers, and they are the only way anything in the app reaches data or causes
// an effect. This service keeps one warm client per connector (so a UI call is one round trip, not
// a handshake), runs OAuth when a server asks for it, and mirrors every connector into the engine
// so agents can be granted the same ones.
import { readFileSync, renameSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Effect, Layer } from 'effect'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BY_LABEL, CRON_LABEL, NATIVE_AGENTS, NATIVE_APP, NATIVE_TOOLS, normUrl, SCHEDULE_LABEL, VIA_LABEL, type ApiCredentials, type ConnectorSpec, type ConnectorState, type ConnectorStatus, type ToolInfo } from '@shared/types'
import { Config } from './Config'
import { Engine } from './Engine'
import { Events } from './Events'
import { openUrl } from '../env'
import { toolInfo } from '../readOnly'
import { refreshOnce } from '../oauthRefresh'
import { consentScope, scopeAwareFetch, ScopeRequiredError } from '../oauthScope'
import { oauthProvider, type OAuthData } from '../oauthProvider'
import { apiCheck, apiConfig, apiHasKey, apiRequest, apiTools, type ApiInput } from '../apiConnector'
import { apiTraceSummary, connectorTrace, isRateLimited } from '../connectorTrace'
import { externalRequests, retryDelay } from '../externalRequests'
import type { ReadRequest } from '../../shared/reads'

export interface ConnectorInput {
  id?: string
  name: string
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  /** false: the server takes no authentication at all, so it is never offered a browser sign-in. Unset or true: OAuth when the server asks. */
  oauth?: boolean
  /** Makes it an API connector: `url` is the API's base URL. */
  api?: ApiInput
  /** An API connector's key, or username and password. An empty value keeps what is stored. */
  credentials?: ApiCredentials
}

/** Who is making a call: a workspace's UI, an agent, a custom tool, a schedule or the app itself. Recorded with writes; `depth` counts custom tools calling tools. */
export interface Caller {
  by: string
  /** For a call a custom tool makes: who ran the tool (`schedule:<id>`, `workspace:<id>`, …). */
  via?: string
  depth: number
  /** UI query metadata; never forwarded to a connector as tool arguments. */
  read?: ReadRequest
  /** What is left of the outermost custom tool run's limits; carried through tools calling tools. */
  budget?: { calls: number; cpuMs: number; until: number }
}
export const APP_CALLER: Caller = { by: 'app', depth: 0 }

const PROVENANCE = [BY_LABEL, VIA_LABEL, SCHEDULE_LABEL, CRON_LABEL]
const ownLabels = (labels: unknown) => Object.fromEntries(Object.entries(labels && typeof labels === 'object' && !Array.isArray(labels) ? (labels as Record<string, unknown>) : {}).filter(([k]) => !PROVENANCE.includes(k)))
/**
 * Where a conversation came from, put on it as it starts (see BY_LABEL): who called, and for a custom
 * tool what ran it. An agent schedule's conversations start later, in the engine; the schedule's
 * launch carries the labels they will have. Anything the caller sent under these names is dropped.
 */
export const withProvenance = (tool: string, args: Record<string, unknown>, caller: Caller): Record<string, unknown> => {
  if (tool === 'session_start') return { ...args, labels: { ...ownLabels(args.labels), [BY_LABEL]: caller.by, ...(caller.via ? { [VIA_LABEL]: caller.via } : {}) } }
  const launch = args.launch as Record<string, unknown> | undefined
  if ((tool === 'schedule_create' || tool === 'schedule_update') && launch && typeof launch === 'object' && !('session_id' in launch)) {
    const when = typeof args.cron === 'string' ? { [CRON_LABEL]: args.cron } : {}
    const name = typeof args.name === 'string' ? { [SCHEDULE_LABEL]: args.name } : {}
    return { ...args, launch: { ...launch, labels: { ...ownLabels(launch.labels), [BY_LABEL]: 'schedule', ...name, ...when } } }
  }
  return args
}

/** A connector served from inside this process (the native `app` and `tools` connectors). */
export interface InternalConnector {
  tools: () => ToolInfo[]
  call: (tool: string, args: Record<string, unknown>, caller: Caller) => Promise<unknown>
}

export interface RawResult {
  content: { type: string; text?: string; [k: string]: unknown }[]
  structuredContent?: unknown
  isError?: boolean
}

export interface ConnectorsShape {
  readonly list: () => ConnectorState[]
  readonly get: (id: string) => ConnectorState | undefined
  /** `signIn` opens the browser when the server wants OAuth; without it the connector waits for a user's click. */
  readonly add: (input: ConnectorInput, signIn?: boolean) => Effect.Effect<ConnectorState, Error>
  readonly update: (id: string, patch: Partial<ConnectorInput>, signIn?: boolean) => Effect.Effect<ConnectorState, Error>
  readonly remove: (id: string) => Effect.Effect<boolean, Error>
  readonly connect: (id: string, signIn?: boolean) => Effect.Effect<ConnectorState, Error>
  /** Call a tool and get plain data back: structured content, parsed JSON, or text. */
  readonly call: (id: string, tool: string, args?: Record<string, unknown>, caller?: Caller) => Effect.Effect<unknown, Error>
  /** Call a tool and get the MCP result untouched (what the agent-facing proxy returns). */
  readonly callRaw: (id: string, tool: string, args?: Record<string, unknown>, caller?: Caller) => Effect.Effect<RawResult, Error>
  readonly finishAuth: (state: string, code: string) => Effect.Effect<ConnectorState, Error>
  readonly findByUrl: (url: string) => ConnectorState[]
  readonly registerInternal: (id: string, name: string, impl: InternalConnector) => void
}

export class Connectors extends Context.Service<Connectors, ConnectorsShape>()('Connectors') {}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'connector'
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Local MCP servers run with the same environment a terminal would give them, so they work as they do there. */
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE')) as Record<string, string>
const originOf = (u?: string) => {
  try {
    return new URL(u ?? '').origin
  } catch {
    return ''
  }
}

interface Live {
  client: Client
  tools: ToolInfo[]
}
interface Store {
  connectors: ConnectorSpec[]
  oauth: Record<string, OAuthData>
}

/** How many times a failed sign-in step is tried again (after 1, 2 and 4 minutes) before asking. */
const STEP_RETRIES = 3

export const ConnectorsLive = Layer.effect(Connectors)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const events = yield* Events
    const engine = yield* Engine
    const file = join(cfg.dataDir, 'connectors.json')
    const hubUrl = `http://127.0.0.1:${cfg.hubPort}`
    const trace = connectorTrace(process.env.LYNX_TRACE_CONNECTORS === '1')
    const requests = externalRequests()
    const changed = () => Effect.runSync(events.changed)

    let store: Store = { connectors: [], oauth: {} }
    try {
      store = { oauth: {}, connectors: [], ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch (e) {
      // Not there is a first launch. Unreadable is set aside rather than written over with nothing.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[connectors] unreadable, set aside', message(e))
        try {
          renameSync(file, `${file}.unreadable-${Date.now()}`)
        } catch {
          /* gone already */
        }
      }
    }
    // Written aside and moved into place, so a quit or crash mid-write cannot leave half a file (and
    // with a rotated refresh token, the only copy of a sign-in is in it).
    let writing = Promise.resolve()
    const save = () =>
      (writing = writing
        .then(async () => {
          await writeFile(`${file}.tmp`, JSON.stringify(store, null, 2), { mode: 0o600 })
          await rename(`${file}.tmp`, file)
        })
        .catch((e) => console.error('[connectors] save', e)))

    const live = new Map<string, Live>()
    // Keep declared read-only hints across transport loss, so fresh cached reads need no reconnect.
    const knownTools = new Map<string, ToolInfo[]>()
    const status = new Map<string, { status: ConnectorStatus; error?: string }>()
    const connecting = new Map<string, Promise<void>>()
    const internal = new Map<string, InternalConnector>()
    const interactive = new Set<string>()
    // A sign-in that could not be renewed for now (offline, the server down): it is retried, not given up on.
    const renewing = new Set<string>()
    const retries = new Map<string, NodeJS.Timeout>()
    // Sign-in steps that failed in a row while a refresh token is held (see doConnect).
    const stepFailures = new Map<string, number>()
    const spec = (id: string) => store.connectors.find((c) => c.id === id)

    const authOf = (s: ConnectorSpec): ConnectorState['auth'] => {
      if (s.api) return undefined
      const names = Object.keys(s.headers ?? {})
      if (!names.length) return s.oauth === false ? { kind: 'none' } : store.oauth[s.id]?.tokens ? { kind: 'oauth' } : undefined
      const only = names.length === 1 && names[0]!.toLowerCase() === 'authorization' ? s.headers![names[0]!]! : ''
      return { kind: /^bearer /i.test(only) ? 'bearer' : /^basic /i.test(only) ? 'basic' : 'header', headers: names }
    }
    const toState = (s: ConnectorSpec): ConnectorState => ({
      id: s.id,
      name: s.name,
      native: !!s.native,
      transport: s.transport,
      url: s.url,
      command: s.command,
      args: s.args,
      createdAt: s.createdAt,
      hasCredentials: !!(s.headers && Object.keys(s.headers).length) || !!store.oauth[s.id]?.tokens || !!(s.credentials?.key || s.credentials?.username),
      auth: authOf(s),
      api: s.api,
      status: internal.has(s.id) ? 'connected' : (status.get(s.id)?.status ?? 'disconnected'),
      error: status.get(s.id)?.error,
      tools: internal.get(s.id)?.tools() ?? (s.api ? apiTools(s) : (live.get(s.id)?.tools ?? [])),
      agentConnectionId: s.agentConnectionId,
    })
    const list = () => store.connectors.map(toState)
    const get = (id: string) => {
      const s = spec(id)
      return s && toState(s)
    }
    const setStatus = (id: string, s: ConnectorStatus, error?: string) => {
      const recovered = s === 'connected' && status.get(id)?.status !== 'connected'
      status.set(id, { status: s, error })
      changed()
      if (recovered) {
        Effect.runSync(events.publish({ t: 'connector-data-changed', connector: id, errorsOnly: true }))
        // Custom tools can depend on any connector; retry failed queries after recovery.
        if (id !== NATIVE_TOOLS) Effect.runSync(events.publish({ t: 'connector-data-changed', connector: NATIVE_TOOLS, errorsOnly: true }))
      }
    }

    // ── OAuth: the SDK does discovery and dynamic registration; we hold the tokens and open the browser.
    const provider = (id: string, consent = false) =>
      oauthProvider({
        id,
        consent,
        redirect: `${hubUrl}/oauth/callback`,
        data: () => (store.oauth[id] ??= {}),
        forget: () => delete store.oauth[id],
        save: () => void save(),
        interactive: () => interactive.has(id),
        redirectToAuthorization: async (url, renewable) => {
          if (renewable && !interactive.has(id)) return void renewing.add(id)
          setStatus(id, 'auth-required')
          // Only someone asking for this connector opens the browser; reconnecting at launch never does.
          if (!interactive.has(id)) return
          if (!process.env.LYNX_E2E) await openUrl(url.toString())
          else console.log(`[oauth] ${id} -> ${url.origin}${url.pathname}`)
        },
      })
    const holdsRefreshToken = (id: string) => !!(store.oauth[id]?.tokens as { refresh_token?: string } | undefined)?.refresh_token

    const guardedFetch = (id: string, inner: typeof fetch = fetch): typeof fetch => async (input, init) => {
      requests.check(id)
      const observe = requests.observe(id)
      const response = await inner(input, init)
      if (response.status === 429 || response.status === 403) {
        const delay = retryDelay(await response.clone().text(), Object.fromEntries(response.headers), response.status)
        if (delay !== undefined) observe(delay)
      }
      return response
    }

    const transports = (s: ConnectorSpec) => {
      if (s.transport === 'stdio') {
        if (!s.command) throw new Error('A local connector needs a command')
        return [() => new StdioClientTransport({ command: s.command!, args: s.args ?? [], env: { ...childEnv(), ...(s.env ?? {}) }, stderr: 'ignore' })]
      }
      if (!s.url) throw new Error('A remote connector needs a URL')
      const headers = s.headers ?? {}
      // Static credentials win; otherwise OAuth is offered and only used if the server answers 401,
      // unless the connector says the server takes no authentication.
      const authProvider = Object.keys(headers).length || s.oauth === false ? undefined : provider(s.id)
      // refreshOnce: calls that find the token expired together share one refresh (see oauthRefresh.ts).
      const refresh = guardedFetch(s.id, refreshOnce())
      const fetch = authProvider ? scopeAwareFetch(refresh, s.url, (challenge) => {
        const held = (store.oauth[s.id] ??= {})
        held.scopeChallenge = { ...challenge, scope: consentScope(held.scopeChallenge?.scope, challenge.scope) }
        void save()
        clearTimeout(retries.get(s.id))
        setStatus(s.id, 'auth-required', new ScopeRequiredError().message)
      }) : refresh
      return [() => new StreamableHTTPClientTransport(new URL(s.url!), { authProvider, requestInit: { headers }, fetch }), () => new SSEClientTransport(new URL(s.url!), { authProvider, requestInit: { headers }, fetch })]
    }

    const disconnect = async (id: string) => {
      const l = live.get(id)
      live.delete(id)
      await l?.client.close().catch(() => undefined)
    }

    type ConnectReason = 'call' | 'retry' | 'onclose' | 'startup' | 'user' | 'auth' | 'resume'
    const doConnect = async (id: string, reason: ConnectReason) => {
      let failure: unknown
      let definitions: { tools?: number; toolDefinitionChars?: number } = {}
      const run = async () => {
        if (id !== NATIVE_AGENTS) requests.check(id)
        const s = spec(id)
        if (!s) throw new Error(`No connector named ${id}`)
        if (s.transport === 'internal') return
        if (s.transport === 'api') {
          const result = await connectApi(s)
          if (result && !result.ok) failure = result.error
          return
        }
        if (s.id === NATIVE_AGENTS) await engine.ready
        await disconnect(id)
        clearTimeout(retries.get(id))
        renewing.delete(id)
        setStatus(id, 'connecting')
        const challenge = store.oauth[id]?.scopeChallenge
        if (challenge && s.url && !Object.keys(s.headers ?? {}).length) {
          setStatus(id, 'auth-required', new ScopeRequiredError().message)
          if (interactive.has(id)) await auth(provider(id, true), {
            serverUrl: s.url,
            scope: consentScope((store.oauth[id]?.tokens as { scope?: string } | undefined)?.scope, challenge.scope),
            resourceMetadataUrl: challenge.resourceMetadataUrl ? new URL(challenge.resourceMetadataUrl) : undefined,
            fetchFn: guardedFetch(id, refreshOnce()),
          })
          return
        }
        for (const make of transports(s)) {
          const client = new Client({ name: 'lynx', version: '0.1.0' })
          try {
            await client.connect(make(), { timeout: 20000 })
            const all = (await client.listTools()).tools
            if (process.env.LYNX_TRACE_CONNECTORS === '1') definitions = { tools: all.length, toolDefinitionChars: JSON.stringify(all).length }
            client.onclose = () => {
              // Closed by us, it is no longer the live one; dropped (network, sleep, server restart), it comes back.
              if (live.get(id)?.client === client) {
                live.delete(id)
                setStatus(id, 'disconnected')
                retryLater(id, 3000, 'onclose')
              }
            }
            live.set(id, { client, tools: all.map(toolInfo) })
            knownTools.set(id, all.map(toolInfo))
            setStatus(id, 'connected')
            stepFailures.delete(id)
            return
          } catch (e) {
            await client.close().catch(() => undefined)
            failure = e
            if (e instanceof UnauthorizedError) break
            // Only fall through to the legacy SSE transport when the server does not speak streamable HTTP.
            if (!/\b(404|405)\b|not found|method not allowed/i.test(message(e))) break
          }
        }
        if (failure instanceof ScopeRequiredError || (failure instanceof UnauthorizedError && status.get(id)?.status === 'auth-required')) return
        const text = message(failure)
        const credentialish = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid_token|oauth|registration|authorization/i.test(text)
        const oauth = s.transport === 'http' && !Object.keys(s.headers ?? {}).length
        if (renewing.has(id)) {
          setStatus(id, 'error', 'Could not renew the sign-in just now; trying again shortly')
          return retryLater(id, 60_000)
        }
        // Unreachable is usually passing (offline, asleep, a deploy): keep trying in the background. That
        // includes a sign-in step the server could not answer (a 5xx from its OAuth metadata), which is
        // the server being down, not a sign-in to ask for, and does not count against the retries below.
        if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network|timed out|\b5\d\d\b/i.test(text)) {
          setStatus(id, 'error', text.slice(0, 400))
          return retryLater(id, 60_000)
        }
        // A refresh token is only thrown away when the server refuses it (invalid_grant). While one is
        // held, a sign-in step that failed (the server's metadata, registration) is tried again, not asked
        // for: a few times, further apart each time. Not when the MCP server turned down tokens just
        // refreshed (a wrong audience) or wants more access than a refresh grants: that is the answer. Nor
        // when someone clicked to connect: they get what failed now, as a sign-in opens for them now.
        const refused = /after successful authentication|after trying upscoping/i.test(text)
        if (oauth && credentialish && !refused && !interactive.has(id) && holdsRefreshToken(id)) {
          const n = (stepFailures.get(id) ?? 0) + 1
          stepFailures.set(id, n)
          if (n <= STEP_RETRIES) {
            setStatus(id, 'error', 'Could not renew the sign-in just now; trying again shortly')
            return retryLater(id, 60_000 * 2 ** (n - 1))
          }
        }
        stepFailures.delete(id)
        if (oauth && credentialish) setStatus(id, 'needs-credentials', 'This server needs a token or API key')
        else setStatus(id, 'error', text.slice(0, 400))
      }
      return id === NATIVE_AGENTS ? run() : trace(id, 'connect', 'app', run, {
        operation: 'connect', reason,
        summarize: () => ({ outcome: status.get(id)?.status ?? 'error', rateLimited: isRateLimited(failure), ...definitions }),
      })
    }
    // An API connector has nothing to keep open: it is ready once it has its key, and when it has a
    // check path, once the API takes the key.
    const connectApi = async (s: ConnectorSpec) => {
      clearTimeout(retries.get(s.id))
      if (!apiHasKey(s.api!, s.credentials)) return setStatus(s.id, 'needs-credentials', s.api!.auth.type === 'basic' ? 'This API needs a username and password' : 'This API needs a key')
      if (!s.api!.checkPath) return setStatus(s.id, 'connected')
      setStatus(s.id, 'connecting')
      const r = await apiCheck(s, guardedFetch(s.id))
      if (r.ok) return setStatus(s.id, 'connected')
      setStatus(s.id, r.credentials ? 'needs-credentials' : 'error', r.error.slice(0, 400))
      if (!r.credentials) retryLater(s.id, 60_000)
      return r
    }
    const retryLater = (id: string, ms: number, reason: ConnectReason = 'retry') => {
      clearTimeout(retries.get(id))
      retries.set(id, setTimeout(() => (retries.delete(id), void connectOnce(id, false, reason).catch(() => undefined)), Math.max(ms, requests.remaining(id))))
    }
    const connectOnce = (id: string, byUser = false, reason: ConnectReason = 'call') => {
      let p = connecting.get(id)
      if (!p) {
        if (byUser) interactive.add(id)
        p = doConnect(id, byUser ? 'user' : reason).finally(() => {
          connecting.delete(id)
          interactive.delete(id)
        })
        connecting.set(id, p)
      }
      return p
    }
    const ensure = async (id: string): Promise<Live> => {
      if (store.oauth[id]?.scopeChallenge && !Object.keys(spec(id)?.headers ?? {}).length) throw new ScopeRequiredError()
      if (!live.get(id)) await connectOnce(id)
      const l = live.get(id)
      if (l) return l
      const st = status.get(id)
      throw new Error(st?.status === 'auth-required' ? `${id} is waiting for authorization in your browser` : st?.status === 'needs-credentials' ? `${id} needs credentials` : `${id}: ${st?.error ?? 'not connected'}`)
    }

    // ── mirror into the engine, so agents reach the same connector (through the hub, with our credentials)
    const syncing = new Map<string, Promise<void>>()
    const mirrorAgentConnection = async (s: ConnectorSpec) => {
      await engine.ready
      const url = `${hubUrl}/mcp/${s.id}`
      if (s.agentConnectionId && s.agentConnectionUrl === url) {
        const ok = await engine.admin('GET', `/v1/connections/${s.agentConnectionId}`).then(
          () => true,
          () => false,
        )
        if (ok) return
        s.agentConnectionId = undefined
      }
      const body = { name: s.id, spec: { transport: 'http', url }, enabled: true, credentials: { headers: { Authorization: `Bearer ${cfg.hubToken}` } } }
      const res = await engine.admin(s.agentConnectionId ? 'PUT' : 'POST', `/v1/admin/connections${s.agentConnectionId ? `/${s.agentConnectionId}` : ''}`, body)
      s.agentConnectionId = res.id
      s.agentConnectionUrl = url
      await save()
      changed()
    }
    const syncAgentConnection = (s: ConnectorSpec) => {
      let pending = syncing.get(s.id)
      if (!pending) {
        pending = mirrorAgentConnection(s).finally(() => syncing.delete(s.id))
        syncing.set(s.id, pending)
      }
      return pending
    }
    const syncLater = (s: ConnectorSpec) => void syncAgentConnection(s).catch((e) => console.error(`[connectors] engine sync ${s.id}:`, message(e)))

    const performRaw = async (id: string, tool: string, args: Record<string, unknown>, caller: Caller): Promise<RawResult> => {
      const impl = internal.get(id)
      if (impl) {
        try {
          const data = await impl.call(tool, args, caller)
          return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data ?? null) }], structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : undefined }
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: message(e) }] }
        }
      }
      const s = spec(id)
      if (s?.transport === 'api') {
        if (tool !== 'request') return { isError: true, content: [{ type: 'text', text: `${id} has one tool, request` }] }
        try {
          const data = await trace(id, tool, caller.by, () => apiRequest(s, args, guardedFetch(id)), { summarize: apiTraceSummary })
          // The key worked (or the API answered without one): whatever said otherwise is past.
          if (data.ok && status.get(id)?.status !== 'connected') setStatus(id, 'connected')
          return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: message(e) }] }
        }
      }
      // Every agent can use every connector, always: sessions are given all of them when they
      // start, and again before each message so connectors added later are there too. The exception is
      // a session started with the label connectors: none (a security review reading untrusted code),
      // which keeps none, message after message.
      if (id === NATIVE_AGENTS) args = withProvenance(tool, args, caller)
      if (id === NATIVE_AGENTS && (tool === 'session_start' || tool === 'session_send')) {
        // Native app tools must be mirrored before the session snapshots its grants.
        // Startup mirrors asynchronously; opening an agent immediately used to race that work.
        await Promise.all(store.connectors.map((s) => syncAgentConnection(s)))
        const all = store.connectors.map((c) => c.agentConnectionId).filter((c): c is string => !!c)
        const client = (await ensure(id)).client
        if (tool === 'session_start') args = { ...args, connection_ids: (args.labels as Record<string, unknown> | undefined)?.connectors === 'none' ? [] : all }
        else if (typeof args.id === 'string') {
          const got = (await client.callTool({ name: 'session_get', arguments: { id: args.id } }).catch(() => null)) as RawResult | null
          let info = got?.structuredContent as { session?: { labels?: Record<string, string> } } | undefined
          try {
            info ??= JSON.parse(got?.content?.[0]?.text ?? 'null') ?? undefined
          } catch {
            /* not JSON: the session keeps every connector */
          }
          const none = info?.session?.labels?.connectors === 'none'
          await client.callTool({ name: 'session_connections_set', arguments: { id: args.id, connection_ids: none ? [] : all } }).catch(() => undefined)
        }
      }
      // Slow answers are real (a search-and-write chat takes minutes): five minutes of silence, the
      // clock starting over whenever the server reports progress, and never more than ten in all.
      let sent = false
      let readOnly = false
      const attempt = async () => {
        const run = async () => {
          const connection = await ensure(id)
          // A display guess from a tool's name is not enough to replay it after losing its answer.
          readOnly = connection.tools.find((t) => t.name === tool)?.declaredReadOnly === true
          sent = true
          return connection.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 5 * 60000, resetTimeoutOnProgress: true, maxTotalTimeout: 10 * 60000 }) as Promise<RawResult>
        }
        return id === NATIVE_AGENTS ? run() : trace(id, tool, caller.by, run)
      }
      try {
        return await attempt()
      } catch (e) {
        // Reconnect after a dropped transport or expired sign-in. Only replay a declared read or a
        // call that never reached the client: a lost answer does not mean a write failed to happen.
        if (!(e instanceof UnauthorizedError) && !/closed|not connected|ECONNRE|fetch failed|socket|terminated|session|\b401\b/i.test(message(e))) throw e
        await disconnect(id)
        if (sent && !readOnly) {
          // disconnect intentionally suppresses onclose recovery. Restore discovery separately
          // from the failed write: the hub can reconnect now, or the timer will do it shortly.
          setStatus(id, 'disconnected')
          retryLater(id, 3000)
          throw new Error(`${id}.${tool}: the connection failed and the outcome is unknown. The call was not retried because it may already have changed data. Check its result before trying again. ${message(e)}`)
        }
        return attempt()
      }
    }
    const callRawP = async (id: string, tool: string, args: Record<string, unknown> = {}, caller: Caller = APP_CALLER): Promise<RawResult> => {
      const s = spec(id)
      if (!s || s.native || internal.has(id)) return performRaw(id, tool, args, caller)
      const api = s.transport === 'api'
      const toolInfo = (live.get(id)?.tools ?? knownTools.get(id))?.find((t) => t.name === tool)
      const readOnly = api
        ? tool === 'request' && ['GET', 'HEAD'].includes(String(args.method ?? 'GET').toUpperCase())
        : toolInfo?.declaredReadOnly === true
      const mutation = api ? !readOnly : toolInfo?.readOnly === false
      let executed = false
      try {
        return await requests.run(id, tool, args, readOnly, caller.read, () => { executed = true; return performRaw(id, tool, args, caller) }, (result) => {
          if (api && !result.isError) {
            const data = result.structuredContent as Awaited<ReturnType<typeof apiRequest>>
            return { ok: data.ok, retryMs: data.ok ? undefined : retryDelay(data.body, data.headers, data.status) }
          }
          const text = result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
          return { ok: !result.isError, retryMs: result.isError ? retryDelay(text) : undefined }
        })
      } finally {
        if (mutation && executed && !caller.read) Effect.runSync(events.publish({ t: 'connector-data-changed', connector: id }))
      }
    }
    const plain = (r: RawResult): unknown => {
      const text = (r.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n')
      if (r.isError) {
        let m = text
        try {
          m = JSON.parse(text)?.error?.message ?? text
        } catch {
          /* plain text */
        }
        throw new Error(m || 'The tool returned an error')
      }
      // Images, embedded resources and ui:// views only exist in the content blocks: keep them.
      if ((r.content ?? []).some((c) => c.type !== 'text')) return { content: r.content, ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}) }
      if (r.structuredContent !== undefined) return r.structuredContent
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    const asEffect = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

    const add: ConnectorsShape['add'] = (input, signIn = false) =>
      asEffect(async () => {
        if (input.api && !input.url) throw new Error("Give an API connector its base URL, e.g. https://api.example.com/v1")
        if (!input.url && !input.command) throw new Error('Give the connector a URL (remote MCP) or a command (local MCP)')
        if (input.url && !/^https?:\/\//.test(input.url)) throw new Error('The URL must start with http:// or https://')
        const api = input.api ? apiConfig(input.api) : undefined
        let id = slug(input.id ?? input.name)
        for (let n = 2; spec(id); n++) id = `${slug(input.id ?? input.name)}-${n}`
        const s: ConnectorSpec = api
          ? { id, name: input.name || id, transport: 'api', url: input.url!.trim(), api, credentials: keptCredentials(input.credentials), createdAt: new Date().toISOString() }
          : { id, name: input.name || id, transport: input.url ? 'http' : 'stdio', url: input.url?.trim(), command: input.command, args: input.args, env: input.env, headers: input.headers, ...(input.url && input.oauth === false ? { oauth: false as const } : {}), createdAt: new Date().toISOString() }
        store.connectors.push(s)
        await save()
        await connectOnce(id, signIn)
        syncLater(s)
        return toState(s)
      })

    const update: ConnectorsShape['update'] = (id, patch, signIn = false) =>
      asEffect(async () => {
        const s = spec(id)
        if (!s || s.native) throw new Error(s ? 'Native connectors cannot be edited' : `No connector named ${id}`)
        const connectionConfig = () => JSON.stringify({ url: s.url, command: s.command, args: s.args, env: s.env, headers: s.headers, api: s.api, credentials: s.credentials, oauth: s.oauth })
        const before = connectionConfig()
        if (patch.name) s.name = patch.name
        if (patch.url && patch.url.trim() !== s.url) {
          if (!/^https?:\/\//.test(patch.url)) throw new Error('The URL must start with http:// or https://')
          // A token belongs to the server it was issued for. Pointing the connector somewhere else
          // must not carry stored credentials along to the new address.
          if (originOf(patch.url) !== originOf(s.url)) {
            s.headers = undefined
            s.credentials = undefined
            delete store.oauth[id]
          }
          s.url = patch.url.trim()
        }
        if (patch.api) {
          if (!s.api) throw new Error(`${id} is an MCP server, not an API connector`)
          const next = apiConfig(patch.api, s.api)
          // A key meant for one place (a header, the query) is not moved to another without being given again.
          if (next.auth.type !== s.api.auth.type) s.credentials = undefined
          s.api = next
        }
        if (patch.credentials) {
          if (!s.api) throw new Error(`${id} is an MCP server: give it headers, not credentials`)
          const stored = s.credentials ?? {}
          s.credentials = keptCredentials({ key: patch.credentials.key || stored.key, username: patch.credentials.username || stored.username, password: patch.credentials.password || (patch.credentials.username ? '' : stored.password) })
        }
        if (patch.command) s.command = patch.command
        if (patch.args) s.args = patch.args
        if (patch.env) s.env = patch.env
        if (patch.headers) {
          // An empty value keeps what is stored under that name, so a form can change one header
          // (or none) without ever having been shown the others' values.
          const stored = s.headers ?? {}
          const next = Object.fromEntries(Object.entries(patch.headers).flatMap(([k, v]) => (v ? [[k, v]] : stored[k] ? [[k, stored[k]]] : [])))
          s.headers = Object.keys(next).length ? next : undefined
        }
        if (patch.oauth !== undefined && s.transport === 'http') {
          // Saying the server takes no authentication drops a sign-in it would never use again.
          if (patch.oauth) delete s.oauth
          else (s.oauth = false), delete store.oauth[id]
        }
        // Separate generations only after a validated, actual configuration change. A rename or
        // unchanged credentials must not bypass an upstream cooldown.
        const reconfigured = before !== connectionConfig()
        await save()
        if (reconfigured) {
          await connecting.get(id)?.catch(() => undefined)
          requests.reset(id)
          knownTools.delete(id)
          await disconnect(id)
        }
        await connectOnce(id, signIn)
        if (reconfigured) Effect.runSync(events.publish({ t: 'connector-data-changed', connector: id }))
        return toState(s)
      })

    const keptCredentials = (c?: ApiCredentials) => {
      const out = Object.fromEntries(Object.entries(c ?? {}).filter(([, v]) => typeof v === 'string' && v !== '').map(([k, v]) => [k, k === 'password' ? v : (v as string).trim()]))
      return Object.keys(out).length ? (out as ApiCredentials) : undefined
    }

    const remove: ConnectorsShape['remove'] = (id) =>
      asEffect(async () => {
        const s = spec(id)
        if (!s) return false
        if (s.native) throw new Error('Native connectors cannot be removed')
        await connecting.get(id)?.catch(() => undefined)
        await disconnect(id)
        requests.reset(id)
        knownTools.delete(id)
        if (s.agentConnectionId) await engine.admin('PUT', `/v1/admin/connections/${s.agentConnectionId}`, { name: `${s.id}-removed`, spec: { transport: 'http', url: s.agentConnectionUrl }, enabled: false }).catch(() => undefined)
        store.connectors = store.connectors.filter((c) => c.id !== id)
        delete store.oauth[id]
        status.delete(id)
        await save()
        changed()
        return true
      })

    const finishAuth: ConnectorsShape['finishAuth'] = (state, code) =>
      asEffect(async () => {
        const id = state.split('.')[0] ?? ''
        const s = spec(id)
        if (!s?.url || store.oauth[id]?.state !== state) throw new Error('This authorization does not match a pending connector')
        requests.reset(id)
        const transport = new StreamableHTTPClientTransport(new URL(s.url), { authProvider: provider(id) })
        await transport.finishAuth(code)
        delete store.oauth[id]?.scopeChallenge
        await save()
        await connecting.get(id)?.catch(() => undefined)
        await disconnect(id)
        requests.reset(id)
        knownTools.delete(id)
        await connectOnce(id, false, 'auth')
        Effect.runSync(events.publish({ t: 'connector-data-changed', connector: id }))
        return toState(s)
      })

    const registerInternal: ConnectorsShape['registerInternal'] = (id, name, impl) => {
      internal.set(id, impl)
      const existing = spec(id)
      if (!existing) store.connectors.unshift({ id, name, native: true, transport: 'internal', createdAt: new Date().toISOString() })
      // A built-in's name is the code's, not what was saved, so renaming one in the code renames it here.
      else if (existing.name !== name) (existing.name = name), void save()
      syncLater(spec(id)!)
      changed()
    }

    // The engine's own MCP endpoint is just another connector.
    const agents: ConnectorSpec = { id: NATIVE_AGENTS, name: 'Agents', native: true, transport: 'http', url: `${engine.url}/mcp`, headers: { Authorization: `Bearer ${cfg.engineToken}` }, createdAt: new Date().toISOString() }
    const existing = spec(NATIVE_AGENTS)
    if (existing) Object.assign(existing, { ...agents, agentConnectionId: existing.agentConnectionId, agentConnectionUrl: existing.agentConnectionUrl, createdAt: existing.createdAt })
    else store.connectors.unshift(agents)
    void save()

    for (const s of store.connectors) {
      if (s.transport === 'internal') continue
      void connectOnce(s.id, false, 'startup').catch(() => undefined)
      syncLater(s)
    }

    // After sleep every remote connection is suspect: reconnect the ones that were up or dropped.
    void import('electron')
      .then(({ powerMonitor }) =>
        powerMonitor?.on('resume', () => {
          for (const s of store.connectors) if (s.transport !== 'internal' && ['connected', 'disconnected', 'error'].includes(status.get(s.id)?.status ?? '')) retryLater(s.id, 5000, 'resume')
        }),
      )
      .catch(() => undefined)

    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        for (const t of retries.values()) clearTimeout(t)
        retries.clear()
        return Promise.all([...live.keys()].map(disconnect))
      }),
    )

    return Connectors.of({
      list,
      get,
      add,
      update,
      remove,
      connect: (id, signIn = false) => asEffect(() => connectOnce(id, signIn).then(() => toState(spec(id)!))),
      call: (id, tool, args, caller) => asEffect(() => callRawP(id, tool, args, caller).then(plain)),
      callRaw: (id, tool, args, caller) => asEffect(() => callRawP(id, tool, args, caller)),
      finishAuth,
      findByUrl: (url) => list().filter((c) => c.url && normUrl(c.url) === normUrl(url)),
      registerInternal,
    })
  }),
)

export { NATIVE_APP }
