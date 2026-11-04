// What workspace code may do without the user. Workspace UIs are code an agent or a stranger
// wrote; the user is the person at the keyboard. So calls coming from a workspace frame are
// allowed silently only when they are on a short list of harmless ones. Everything else is put
// to the user in a prompt whose wording belongs to the app, never to the workspace.
import type { ConnectorState } from '@shared/types'

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | {
      kind: 'ask'
      /** App-authored sentence completing "This workspace wants to …". */
      action: string
      /** Values supplied by the workspace, shown verbatim-but-escaped under a label. */
      details: [label: string, value: unknown][]
      /** A grant the user may keep for this workspace; absent means ask every single time. */
      scope?: string
    }

const allow: Verdict = { kind: 'allow' }

/** On the `app` connector: listings that reveal nothing private, and things about the caller itself. */
const APP_SILENT = new Set(['connector_list', 'connector_icon', 'connector_tools', 'connector_reconnect', 'workspace_list', 'marketplace_list', 'marketplace_refresh', 'marketplace_files', 'kit_guide', 'design_system_get', 'notify'])
/** On the `app` connector: fine for the caller's own workspace, a question for anyone else's. */
const APP_OWN = new Set(['workspace_get', 'workspace_files', 'workspace_build', 'workspace_open'])
/** On the `app` connector: the store. It is shared by every workspace, tool and agent, so using it is one grant per workspace. */
const APP_STORE = /^(db|files)_/
/** On the `agents` connector: engine status, and reads or stops of conversations. Which conversations is decided by `Context.sessions`. */
const AGENTS_SILENT = new Set(['server_status', 'connection_list', 'session_list', 'session_get', 'session_history', 'session_search', 'run_get', 'run_wait', 'run_cancel', 'session_archive', 'event_payload', 'payload_read', 'input_list', 'provider_sign_in_get'])
/** Starting and steering agents: the point of many workspaces, and as powerful as a shell. One grant per workspace. */
const AGENTS_STEER = new Set(['session_start', 'session_send', 'input_respond', 'session_connections_set'])

export const SCOPE_AGENTS = 'agents'
export const SCOPE_ALL_SESSIONS = 'sessions:all'
export const SCOPE_STORE = 'store'
export const SCOPE_TOOLS = 'tools'
/** A grant to use a connector belongs to that connector as added, not to whatever later takes its name. */
export const scopeUse = (connector: Pick<ConnectorState, 'id' | 'createdAt'>) => `use:${connector.id}@${connector.createdAt}`

export interface Context {
  /** The workspace whose code is calling. */
  caller: string
  /** Connector ids the user bound to that workspace. */
  bound: readonly string[]
  /** Whether the conversation(s) this call touches were started by the caller: 'own', or 'other' when any is not. */
  sessions: 'own' | 'other'
}

export function classify(ctx: Context, connector: ConnectorState | undefined, tool: string, args: Record<string, unknown>): Verdict {
  const { caller } = ctx
  if (!connector) return { kind: 'deny', reason: 'No such connector' }

  if (connector.id === 'app') {
    // The bridge unwraps connector_call before judging and runs exactly what was judged, so a
    // wrapper never reaches this point. If one does, refuse it instead of guessing what it wraps.
    if (tool === 'connector_call') return { kind: 'deny', reason: 'connector_call must be unwrapped before it is judged' }
    if (APP_SILENT.has(tool)) return allow
    // The window's own answers to the app connector: workspace code must never forge one.
    if (tool === 'window_reply') return { kind: 'deny', reason: 'Only the window answers the app connector' }
    const ask = (action: string, ...details: [string, unknown][]): Verdict => ({ kind: 'ask', action, details })
    if (APP_OWN.has(tool)) {
      if (args.workspace === caller) return allow
      return ask(tool === 'workspace_open' ? 'switch the window to another workspace' : "read another workspace's code", ['Workspace', args.workspace])
    }
    // A workspace speaks for itself: its own notifications are its business, anyone else's a question.
    // Naming no workspace means its own (AppConnector fills it in), except when sending, which must say where.
    if (/^notification_/.test(tool)) return args.workspace === caller || (args.workspace === undefined && tool !== 'notification_send') ? allow : ask(tool === 'notification_send' ? 'send a notification in the name of another workspace' : "read or clear other workspaces' notifications", ['Workspace', args.workspace ?? 'all of them'], ['Text', args.text], ['Link', args.link])
    if (APP_STORE.test(tool)) return { kind: 'ask', scope: SCOPE_STORE, action: 'read and change the data stored in Lynx', details: [['What that means', 'The store is shared: it can read, change and restore records and files that other workspaces and tools saved.']] }
    if (tool === 'request_access') return { kind: 'ask', scope: SCOPE_ALL_SESSIONS, action: 'see and control every agent conversation on this computer', details: [['What that means', 'It can read and continue conversations started in other workspaces, not only its own.']] }
    switch (tool) {
      case 'connector_add':
        if (args.api) {
          const api = args.api as Record<string, unknown>
          return ask("add a connector to an HTTP API", ['API', args.url], ['Name', args.name], ['Sends a key', api.auth_type && api.auth_type !== 'none' ? `${api.auth_type}${api.auth_name ? ` (${api.auth_name})` : ''}` : undefined], ['Stores a key', args.credentials ? 'yes' : undefined])
        }
        return args.command ? ask('add a connector that runs a program on this computer', ['Program', [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ')], ['Environment', args.env], ['Name', args.name]) : ask('add a connector to a server', ['Server', args.url], ['Name', args.name], ['Sends headers', args.headers ? Object.keys(args.headers as object).join(', ') : undefined])
      case 'connector_update':
        return ask('change a connector', ['Connector', args.connector], ['New server', args.url], ['New name', args.name], ['Replaces its credentials', args.headers || args.credentials ? 'yes' : undefined], ['Changes how it sends its key', (args.api as Record<string, unknown> | undefined)?.auth_type])
      case 'connector_remove':
        return ask('remove a connector', ['Connector', args.connector])
      case 'workspace_create':
        return ask('create a workspace', ['Name', args.name], ['Bound connectors', args.connectors])
      case 'workspace_update':
        return ask('change a workspace', ['Workspace', args.workspace], ['New name', args.name], ['New connector bindings', args.connectors], ['Archive', args.archived === undefined ? undefined : args.archived ? 'put it away' : 'bring it back'])
      case 'workspace_reorder':
        return ask('rearrange the workspaces in the sidebar', ['New order', args.order])
      case 'workspace_fork':
        return ask('copy a workspace', ['Workspace', args.workspace], ['Name', args.name])
      case 'workspace_delete':
        return ask('delete a workspace and its folder', ['Workspace', args.workspace])
      case 'marketplace_fork':
        return ask('fork a marketplace item into a new workspace', ['Item', args.item], ['Bound connectors', args.connectors])
      case 'marketplace_restore':
        return ask("overwrite a workspace's code", ['Workspace', args.workspace])
      case 'marketplace_publish':
        return ask('publish a workspace to your marketplace shelf', ['Workspace', args.workspace])
      case 'marketplace_stage':
        return ask('copy a workspace to get it ready for the public marketplace', ['Workspace', args.workspace])
      case 'marketplace_submit':
        return ask('ask you to publish a template to the public marketplace', ['Stage', args.stage])
      case 'marketplace_discard':
        return ask('throw away a template on its way to the marketplace', ['Stage', args.stage])
      case 'tool_save':
        return ask('create or change a custom tool, which can then use every connector and start agents', ['Tool', args.name], ['Code', args.source])
      case 'design_system_set':
        return ask('replace the design system every workspace follows', ['New text', String(args.markdown ?? '').slice(0, 400)])
      case 'theme_set':
        return ask("change the app's theme", ['Theme', args.theme])
      case 'mode_set':
        return ask('switch the app between light and dark', ['Mode', args.mode])
      case 'layout_set':
        return ask("change where the app's window puts things", ['Workspaces', args.workspaces], ['Agent', args.agent])
      case 'schedule_save':
        return ask('run a custom tool on a schedule, without you', ['Tool', args.tool], ['When', args.cron], ['With', args.args])
      default:
        return ask('use an app function', ['Function', tool], ['With', args])
    }
  }

  if (connector.id === 'agents') {
    const foreign: Verdict = { kind: 'ask', scope: SCOPE_ALL_SESSIONS, action: 'see and control every agent conversation on this computer', details: [['What that means', 'It can read and continue conversations started in other workspaces, not only its own.']] }
    if (AGENTS_SILENT.has(tool)) return ctx.sessions === 'own' ? allow : foreign
    if (AGENTS_STEER.has(tool) && ctx.sessions !== 'own') return foreign
    if (AGENTS_STEER.has(tool)) return { kind: 'ask', scope: SCOPE_AGENTS, action: 'start and direct agents on this computer', details: [['What that means', 'Agents it starts can run commands, read and change files, and use the connectors it gives them.']] }
    const ask = (action: string, ...details: [string, unknown][]): Verdict => ({ kind: 'ask', action, details })
    switch (tool) {
      case 'exec':
        return ask('run a shell command on this computer', ['Command', args.command], ['In folder', args.cwd], ['Environment', args.env])
      case 'process_input':
        return ask('type into a running shell command', ['Input', args.data])
      case 'file_read':
      case 'files_list':
        return ask('read files on this computer', ['Path', args.path])
      case 'file_write':
      case 'file_patch':
        return ask('change a file on this computer', ['Path', args.path])
      case 'provider_sign_in':
        return ask("sign in to an agent's account on this computer", ['Agent', args.harness])
      case 'schedule_create':
      case 'schedule_update':
      case 'schedule_delete':
        return ask('change when agents run on a schedule', ['Schedule', args])
      default:
        // Transfers, connection setup, recovery, and anything added to the engine later.
        return ask('use an agent engine function', ['Function', tool], ['With', args])
    }
  }

  // Custom tools run with the app's own reach, not the workspace's: one can call any connector and
  // start agents. Running them is therefore a grant of that, said in those words.
  if (connector.id === 'tools') return { kind: 'ask', scope: SCOPE_TOOLS, action: 'run custom tools on this computer', details: [['Tool it is running now', tool], ['What that means', 'A custom tool can use every connector, change stored data and start agents, whatever this workspace itself is allowed to do.']] }

  // Someone else's server. Silent only when the user bound this workspace to it AND the server
  // itself declares the tool read-only. A tool's name is not evidence; neither is our own guess.
  const info = connector.tools.find((t) => t.name === tool)
  if (ctx.bound.includes(connector.id) && info?.declaredReadOnly === true) return allow
  return {
    kind: 'ask',
    scope: scopeUse(connector),
    action: ctx.bound.includes(connector.id) ? 'use every tool of a connector it is bound to, including ones that change things' : 'use a connector it is not bound to, including tools that change things',
    details: [
      ['Connector', `${connector.id}${connector.url ? ` (${connector.url})` : ''}`],
      ['Tool it is calling now', tool],
      ['What that means', 'If you choose "Always allow", this workspace can call any tool on this connector without asking again.'],
    ],
  }
}

const MAX = 1200
// Characters that could reorder or hide text: C1 controls, soft hyphen, zero-width and bidi marks, line separators.
const HIDDEN = new RegExp('[' + [[0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x206f], [0xfeff, 0xfeff]].map(([a, b]) => `\\u${a!.toString(16).padStart(4, '0')}-\\u${b!.toString(16).padStart(4, '0')}`).join('') + ']', 'g')
/**
 * Workspace-supplied values as they appear in a prompt: one line each, control characters and
 * line breaks made visible, so a value cannot pose as the app's own wording or hide its tail.
 * Returns null when a value is too long to show in full: an unreviewable request is refused.
 */
export function describe(details: [string, unknown][]): string | null {
  const lines: string[] = []
  for (const [label, value] of details) {
    if (value === undefined || value === null || value === '') continue
    const text = JSON.stringify(typeof value === 'string' ? value : value)
      .replace(HIDDEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    if (text.length > MAX) return null
    lines.push(`${label}: ${text}`)
  }
  return lines.join('\n')
}
