// The native `app` connector: Lynx itself, as MCP tools. The window's own dialogs, workspace
// UIs and agents all drive the application through these same tools.
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Effect, Layer } from 'effect'
import { AGENT_PLACES, MODES, THEMES, WORKSPACE_PLACES } from '@shared/themes'
import { MAX_EXECUTION } from '@shared/execution'
import { NATIVE_APP, type ToolInfo } from '@shared/types'
import { Config } from './Config'
import { Connectors, type Caller } from './Connectors'
import { Data, RETENTION_DAYS, isTextual } from './Data'
import { Drafts } from './Drafts'
import { Events } from './Events'
import { Marketplace } from './Marketplace'
import { MAX_TEXT, Notifications } from './Notifications'
import { Settings } from './Settings'
import { Tools } from './Tools'
import { Workspaces } from './Workspaces'
import { siteIcon } from '../siteIcons'
import { matches } from '@shared/templates'

export class AppConnector extends Context.Service<AppConnector, { readonly tools: ToolInfo[] }>()('AppConnector') {}

type Args = Record<string, any>
interface Tool {
  name: string
  description: string
  props: Record<string, unknown>
  required?: string[]
  readOnly?: boolean
  /** Only the person at the keyboard, through the window: refused to agents, tools and workspace code, and not listed to them. */
  userOnly?: boolean
  /** For the window's own use: callable, but not listed. */
  hidden?: boolean
  run: (a: Args, caller: Caller) => Effect.Effect<unknown, Error>
}
const str = (description: string) => ({ type: 'string', description })
const obj = (description: string, additionalProperties: unknown = { type: 'string' }) => ({ type: 'object', description, additionalProperties })

export const AppConnectorLive = Layer.effect(AppConnector)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const connectors = yield* Connectors
    const workspaces = yield* Workspaces
    const marketplace = yield* Marketplace
    const events = yield* Events
    const data = yield* Data
    const custom = yield* Tools
    const notifications = yield* Notifications
    const settings = yield* Settings
    const drafts = yield* Drafts

    // Workspaces used to keep their saved state in their own folder. It lives in the store now,
    // under the collection the kit's useStored reads.
    for (const w of workspaces.list()) {
      const old = join(w.dir, '.data', 'kv.json')
      if (!existsSync(old)) continue
      try {
        for (const [key, value] of Object.entries(JSON.parse(readFileSync(old, 'utf8')) as Record<string, unknown>)) if (value !== null && value !== undefined) data.put(`ui/${w.id}`, key, value, { ifAbsent: true, by: 'migration' })
        renameSync(old, join(w.dir, '.data', 'kv.migrated.json'))
      } catch (e) {
        console.error(`[store] could not import ${old}:`, e)
      }
    }

    /** The workspace a notification call is about. Workspace code that names none means its own, so leaving it out never reaches every workspace's. */
    const mine = (workspace: unknown, caller: { by: string }): string | undefined => (workspace !== undefined && workspace !== null ? String(workspace) : caller.by.startsWith('workspace:') ? caller.by.slice(10) : undefined)

    const connectorView = (id: string, withTools = false) => {
      const c = connectors.get(id)
      if (!c) throw new Error(`No connector named ${id}`)
      return {
        id: c.id,
        name: c.name,
        native: c.native,
        transport: c.transport,
        url: c.url,
        command: c.command,
        status: c.status,
        error: c.error,
        has_credentials: c.hasCredentials,
        ...(c.api ? { api: { auth_type: c.api.auth.type, auth_name: c.api.auth.name ?? null, headers: c.api.headers ?? {}, methods: c.api.methods ?? null, docs_url: c.api.docsUrl ?? null, notes: c.api.notes ?? null, check_path: c.api.checkPath ?? null } } : {}),
        agent_connection_id: c.agentConnectionId ?? null,
        tool_count: c.tools.length,
        ...(withTools ? { tools: c.tools } : {}),
      }
    }
    const withNext = (id: string) => {
      const c = connectorView(id)
      return { ...c, next: c.status === 'auth-required' || c.status === 'needs-credentials' ? 'The user must finish connecting. A connect card for this connector is shown to them in the conversation; ask them to use it and end your turn. Once they have connected it, the conversation carries on with a message saying so (elsewhere, continue once connector_list reports it connected).' : undefined }
    }
    const workspaceView = (id: string) => {
      const w = workspaces.get(id)
      if (!w) throw new Error(`No workspace named ${id}`)
      return { id: w.id, name: w.name, icon: w.icon, color: w.color, description: w.description, dir: w.dir, connectors: w.connectors, uses: w.uses, origin: w.origin ?? null, archived: !!w.archived, home: !!w.home, build: w.build }
    }
    /** Tells the window when an agent made a workspace, so it can offer to go there; the user's own new workspaces open by themselves. */
    const announce = (caller: Caller) => (w: { id: string; name: string }) => (caller.by === 'agent' ? events.publish({ t: 'workspace-created', workspace: w.id, name: w.name }) : Effect.void)
    const sync = <A>(f: () => A) => Effect.try({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })
    const USES = { type: 'object', description: 'The manifest: connector name as the UI code writes it (an alias, or app, agents, tools) -> "*" for every tool, or a list of tool names. Replaces the whole manifest.', additionalProperties: { anyOf: [{ type: 'string', enum: ['*'] }, { type: 'array', items: { type: 'string' } }] } }
    const WHEN = str('A past date and time, e.g. "2026-10-11T09:30:00Z"')
    const API = {
      type: 'object',
      description: 'Makes this an API connector, for an HTTP API with no MCP server: url is then its base URL, and the connector has one tool, request (method, path under the base URL, query, headers, body), which adds the key itself.',
      properties: {
        auth_type: { type: 'string', enum: ['none', 'bearer', 'basic', 'header', 'query'], description: "How the API takes its key: bearer (Authorization: Bearer <key>), basic (username and password; an API whose key is the username, like Stripe's, too), header (a header of its own, named by auth_name), query (a query parameter named by auth_name), or none" },
        auth_name: str('The header (auth_type header, e.g. "X-API-Key") or query parameter (auth_type query, e.g. "api_key") the key goes in'),
        headers: obj('Headers that are not secret, sent with every request: an API version, Accept'),
        methods: { type: 'array', items: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] }, description: 'The methods requests may use; leave out for every one. ["GET"] makes it read-only.' },
        docs_url: str("The API's documentation"),
        notes: str('What agents should know to use it: what it is for, the endpoints that matter, conventions. Shown in the request tool\'s description.'),
        check_path: str('A GET path that only works with a valid key (e.g. "/v1/me"), to check the key when the user gives it'),
      },
    }
    const CREDENTIALS = {
      type: 'object',
      description: "An API connector's key, or username and password. Only UIs set this, from what the user typed: never ask for secrets in chat. An empty value keeps the stored one.",
      properties: { key: str('Token or API key'), username: str('Basic auth username'), password: str('Basic auth password') },
    }
    const toolView = (name: string) => {
      const t = custom.list().find((x) => x.name === name)
      if (!t) throw new Error(`No tool named ${name}`)
      return { ...t, schedules: custom.schedules().filter((s) => s.tool === name) }
    }

    // What only the window can do (lay workspaces out, find and highlight what is on screen) is asked of
    // it as an event; it answers with window_reply. With no window open there is no one to answer.
    const asked = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
    let asks = 0
    const askWindow = (op: string, args: Args, ms = 12000) =>
      Effect.tryPromise({
        try: () =>
          new Promise<unknown>((resolve, reject) => {
            const id = `w${Date.now().toString(36)}${++asks}`
            const timer = setTimeout(() => {
              asked.delete(id)
              reject(new Error('The Lynx window did not answer. It may be closed; this works while it is open.'))
            }, ms)
            asked.set(id, { resolve, reject, timer })
            Effect.runSync(events.publish({ t: 'window-request', id, op, args }))
          }),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      })
    const ON_SCREEN = 'Workspace id; leave out for the one on screen (the focused one of two)'

    const tools: Tool[] = [
      // ── connectors
      {
        name: 'connector_icon',
        description: "The icon of the site a connector's server belongs to (mcp.linear.app → linear.app's icon), as a data URL; null for local connectors or a site without one. Pass url instead of connector for a server that is not added yet.",
        props: { connector: str('Connector id'), url: str('An MCP server URL, for a server not added as a connector') },
        readOnly: true,
        run: (a) => Effect.promise(() => siteIcon(a.url ? String(a.url) : connectors.get(a.connector)?.url)).pipe(Effect.map((icon) => ({ icon }))),
      },
      { name: 'connector_list', description: 'List connectors (MCP servers, and HTTP APIs added as API connectors) with status. agent_connection_id is what session_start on the agents connector takes in connection_ids.', props: {}, readOnly: true, run: () => sync(() => ({ connectors: connectors.list().map((c) => connectorView(c.id)) })) },
      {
        name: 'connector_tools',
        description: 'List the tools of one connector with their input schemas. Read this before writing UI code that calls it.',
        props: { connector: str('Connector id'), query: str('Optional filter on tool name or description') },
        required: ['connector'],
        readOnly: true,
        run: (a) =>
          sync(() => {
            const c = connectorView(a.connector, true) as any
            const q = String(a.query ?? '').toLowerCase()
            return { connector: c.id, status: c.status, error: c.error, tools: q ? c.tools.filter((t: ToolInfo) => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q)) : c.tools }
          }),
      },
      {
        name: 'connector_call',
        description: 'Call a tool on a connector and return exactly what UI code would receive from call(). Use it to learn the shape of the data before rendering it.',
        props: { connector: str('Connector id'), tool: str('Tool name'), arguments: obj('Tool arguments', true) },
        required: ['connector', 'tool'],
        run: (a, caller) => connectors.call(a.connector, a.tool, a.arguments ?? {}, caller).pipe(Effect.map((result) => ({ result }))),
      },
      {
        name: 'connector_add',
        description:
          'Add a connector. An MCP server, remote (give url) or local (give command and args); or, for a service with no MCP server, its HTTP API (give url as the base URL, and api: how it takes its key, from its documentation). If it needs the user to sign in or supply a key, a connect card appears for them in the conversation: tell them to use it, and never ask for secrets in chat. Leave sign_in and credentials unset.',
        props: {
          name: str('Short name, e.g. "posthog-eu". Becomes the id.'),
          url: str('Streamable HTTP or SSE MCP URL; for an API connector, the base URL of the API, e.g. "https://api.example.com/v1"'),
          command: str('Executable for a local stdio server'),
          args: { type: 'array', items: { type: 'string' } },
          env: obj('Environment for a local server'),
          headers: obj('Static HTTP headers, e.g. Authorization'),
          oauth: { type: 'boolean', description: 'false when the remote server takes no authentication at all: it is then never offered a browser sign-in. Leave unset otherwise.' },
          api: API,
          credentials: CREDENTIALS,
          sign_in: { type: 'boolean', description: 'Open the browser for OAuth right away. Only UIs set this, on a user click.' },
        },
        required: ['name'],
        run: (a) => connectors.add({ name: a.name, url: a.url, command: a.command, args: a.args, env: a.env, headers: a.headers, oauth: a.oauth, api: a.api, credentials: a.credentials }, !!a.sign_in).pipe(Effect.map((c) => withNext(c.id))),
      },
      {
        name: 'connector_update',
        description: "Change a connector: its name, URL, static headers (credentials), or an API connector's settings. Reconnects afterwards.",
        props: { connector: str('Connector id'), name: str('Display name'), url: str('MCP URL, or an API connector\'s base URL'), headers: obj('Static HTTP headers; replaces the stored ones. An empty value keeps the stored value of that header.'), oauth: { type: 'boolean', description: 'false when the remote server takes no authentication at all: it is then never offered a browser sign-in. Leave unset otherwise.' }, api: { ...API, description: "An API connector's settings. Fields left out keep their value; changing auth_type drops the stored key." }, credentials: CREDENTIALS, sign_in: { type: 'boolean', description: 'Open the browser for OAuth. Only UIs set this, on a user click.' } },
        required: ['connector'],
        run: (a) => connectors.update(a.connector, { name: a.name, url: a.url, headers: a.headers, oauth: a.oauth, api: a.api, credentials: a.credentials }, !!a.sign_in).pipe(Effect.map((c) => withNext(c.id))),
      },
      {
        name: 'connector_reconnect',
        description: 'Reconnect a connector and refresh its tool list.',
        props: { connector: str('Connector id'), sign_in: { type: 'boolean', description: 'Open the browser for OAuth. Only UIs set this, on a user click.' } },
        required: ['connector'],
        run: (a) => connectors.connect(a.connector, !!a.sign_in).pipe(Effect.map((c) => withNext(c.id))),
      },
      { name: 'connector_remove', description: 'Remove a connector. Workspaces bound to it stop working until rebound.', props: { connector: str('Connector id') }, required: ['connector'], run: (a) => connectors.remove(a.connector).pipe(Effect.map((removed) => ({ removed }))) },

      // ── workspaces
      { name: 'workspace_list', description: 'List workspaces with their folders, connector bindings and build status.', props: {}, readOnly: true, run: () => sync(() => ({ workspaces: workspaces.list().map((w) => workspaceView(w.id)) })) },
      {
        name: 'workspace_get',
        description: 'Read one workspace: config, build status, last runtime error, and its source files.',
        props: { workspace: str('Workspace id') },
        required: ['workspace'],
        readOnly: true,
        run: (a) => workspaces.files(a.workspace).pipe(Effect.map((files) => ({ ...workspaceView(a.workspace), files }))),
      },
      { name: 'workspace_files', description: 'Every file in a workspace folder, as text, for reading. A file that is binary or over 2 MB comes without text.', props: { workspace: str('Workspace id') }, required: ['workspace'], readOnly: true, run: (a) => workspaces.source(a.workspace) },
      {
        name: 'workspace_create',
        description: 'Create a workspace. Its name must not be one another workspace (archived ones included) already has. files is { "App.jsx": "<source>" , ... }; App.jsx must default-export a React component. connectors binds aliases used in UI code to connector ids. uses is the manifest of every tool the UI calls; without it the workspace may use every tool of its bound connectors and nothing else. Read kit_guide first.',
        props: { name: str('Display name'), icon: str('A Lucide icon name, e.g. chart-line, git-pull-request, inbox'), color: str('Icon colour: red, orange, yellow, green, teal, blue, purple, pink or brown'), description: str('One line'), connectors: obj('alias -> connector id'), uses: USES, files: obj('path -> file contents') },
        required: ['name'],
        run: (a, caller) => workspaces.create({ name: a.name, icon: a.icon, color: a.color, description: a.description, connectors: a.connectors, uses: a.uses, files: a.files }).pipe(Effect.tap(announce(caller)), Effect.map((w) => workspaceView(w.id))),
      },
      {
        name: 'workspace_update',
        description: 'Rename a workspace, archive it (archived: true puts it away, out of the list of workspaces, and keeps everything; false brings it back), or change its icon, description, connector bindings or manifest. To change the UI, edit a draft of it (workspace_draft) and publish it (workspace_publish). The manifest ("uses") can also be edited directly in workspace.json.',
        props: { workspace: str('Workspace id'), name: str('Display name'), icon: str('A Lucide icon name, e.g. chart-line, git-pull-request, inbox'), color: str('Icon colour: red, orange, yellow, green, teal, blue, purple, pink or brown'), description: str('One line'), connectors: obj('alias -> connector id (replaces all bindings)'), uses: USES, archived: { type: 'boolean', description: 'Put the workspace away, or bring it back' } },
        required: ['workspace'],
        run: (a) => workspaces.update(a.workspace, { name: a.name, icon: a.icon, color: a.color, description: a.description, connectors: a.connectors, uses: a.uses, archived: typeof a.archived === 'boolean' ? a.archived : undefined }).pipe(Effect.map((w) => workspaceView(w.id))),
      },
      {
        name: 'workspace_draft',
        description: 'Start (or pick up) your own draft of a workspace: a folder that is a git worktree of it on branch draft/<name>, made from what is on screen. Make code changes there, never in the workspace folder itself; nothing in a draft reaches the screen until workspace_publish. Returns its folder, and how far it is ahead of and behind what is published.',
        props: { workspace: str('Workspace id'), draft: str('Draft name: letters, digits and dashes. Use the one your instructions give you.') },
        required: ['workspace', 'draft'],
        run: (a) => drafts.open(a.workspace, a.draft),
      },
      {
        name: 'workspace_build',
        description: 'Build workspace code and return the result: status ok or error with compiler messages. With draft, builds that draft (call it after editing a draft). Without, waits for the workspace on screen to finish building and also returns the last runtime error the running UI reported. While the user is typing in the workspace, a newly published version waits off screen until they stop (held: its version, with a note); the runtime error is then the older version\'s. That is not a failure: do not publish again or report a problem for it.',
        props: { workspace: str('Workspace id'), draft: str('Draft name, to build a draft') },
        required: ['workspace'],
        readOnly: true,
        run: (a) =>
          a.draft
            ? drafts.build(a.workspace, a.draft)
            : workspaces.settled(a.workspace).pipe(Effect.map((s) => (s.held === undefined ? s : { ...s, note: `Version ${s.held} is built and published but not on screen yet: the user is typing in the workspace, so it waits until they stop or click Update now. The runtime error, if any, is from the version on screen. Nothing to fix or publish again.` }))),
      },
      {
        name: 'workspace_publish',
        description: 'Put a draft on screen: its edits are committed and become one change in the workspace history, with message as its description. Refused, with nothing changed, when the draft does not build (fix it) or when someone else published since the draft began (reason "behind": the response lists their changes; run `git rebase main` in the draft folder, keep both changes, build, publish again). The draft stays, caught up, for further changes.',
        props: { workspace: str('Workspace id'), draft: str('Draft name'), message: str('One line saying what changed, for the history') },
        required: ['workspace', 'draft', 'message'],
        run: (a) => drafts.publish(a.workspace, a.draft, String(a.message ?? '')),
      },
      {
        name: 'workspace_draft_discard',
        description: 'Throw a draft away: its folder and anything in it not yet published.',
        props: { workspace: str('Workspace id'), draft: str('Draft name') },
        required: ['workspace', 'draft'],
        run: (a) => drafts.discard(a.workspace, a.draft).pipe(Effect.map((discarded) => ({ discarded }))),
      },
      {
        name: 'workspace_history',
        description: 'The changes published to a workspace, newest first (commit, who, when, message, files), and the drafts in progress.',
        props: { workspace: str('Workspace id'), limit: { type: 'number', description: 'At most this many changes (50 by default)' } },
        required: ['workspace'],
        readOnly: true,
        run: (a) => drafts.history(a.workspace, a.limit),
      },
      {
        name: 'workspace_revert',
        description: 'Undo one published change, by publishing a change that reverses it. Refused when later changes touched the same lines.',
        props: { workspace: str('Workspace id'), commit: str('The change\'s commit, from workspace_history') },
        required: ['workspace', 'commit'],
        run: (a) => drafts.revert(a.workspace, String(a.commit ?? '')),
      },
      {
        name: 'workspace_edit_text',
        description: 'Change a piece of text the workspace UI shows, by rewriting it in the source. Applies only when the text is written in exactly one place in the code; otherwise returns applied: false with the reason and changes nothing.',
        props: { workspace: str('Workspace id'), before: str('The text as shown now'), after: str('The text it should become') },
        required: ['workspace', 'before', 'after'],
        run: (a) => workspaces.editText(a.workspace, a.before, a.after),
      },
      {
        name: 'workspace_reorder',
        description: 'Set the order workspaces are listed in. order is workspace ids, first to last; ones left out follow in the order they had.',
        props: { order: { type: 'array', items: { type: 'string' }, description: 'Workspace ids, first to last' } },
        required: ['order'],
        run: (a) => (Array.isArray(a.order) && a.order.every((id: unknown) => typeof id === 'string') ? workspaces.reorder(a.order).pipe(Effect.map((order) => ({ order }))) : Effect.fail(new Error('order must be a list of workspace ids'))),
      },
      { name: 'workspace_fork', description: 'Copy a workspace (code and bindings) into a new one. Workspace names are unique.', props: { workspace: str('Workspace id'), name: str('Name of the copy; left out, "<name> copy"') }, required: ['workspace'], run: (a, caller) => workspaces.fork(a.workspace, a.name).pipe(Effect.tap(announce(caller)), Effect.map((w) => workspaceView(w.id))) },
      { name: 'workspace_delete', description: 'Delete a workspace and its folder. The home workspace (home: true) cannot be deleted; archive it instead.', props: { workspace: str('Workspace id') }, required: ['workspace'], run: (a) => workspaces.remove(a.workspace).pipe(Effect.tap(() => Effect.sync(() => notifications.remove({ workspace: a.workspace }))), Effect.map((deleted) => ({ deleted }))) },
      {
        name: 'workspace_open',
        description: 'Bring a workspace on screen for the user: on its own, or beside the one on screen in two panes (beside "right" or "left"; with two already, it takes the pane on that side). path opens a page inside it, as its router writes it ("/prs/42").',
        props: { workspace: str('Workspace id'), beside: { type: 'string', enum: ['right', 'left'], description: 'Split the window: this workspace goes on that side of the one on screen' }, path: str('A page in the workspace, e.g. "/settings"') },
        required: ['workspace'],
        run: (a) =>
          sync(() => workspaceView(a.workspace)).pipe(
            Effect.tap(() => events.publish({ t: 'open-workspace', workspace: a.workspace, ...(a.beside === 'left' || a.beside === 'right' ? { beside: a.beside === 'left' ? 0 : 1 } : {}), ...(a.path ? { path: String(a.path) } : {}) })),
            Effect.map(() => ({ opened: a.workspace, ...(a.beside ? { beside: a.beside } : {}) })),
          ),
      },

      // ── the window: what is on screen, how it is laid out, and pointing at things in it
      {
        name: 'window_get',
        description: 'What the Lynx window shows right now: the page, the workspaces on screen (one, or two side by side with which has the focus) and the page each is on, and whether the agent panel is open.',
        props: {},
        readOnly: true,
        run: () => askWindow('screen', {}),
      },
      {
        name: 'window_layout',
        description: 'Change how the workspaces on screen are laid out. alone: keep only this workspace (closes the other pane). close: close this workspace\'s pane. swap: the two panes change sides. stack: one above the other. side_by_side: left and right. focus: give this pane the focus. To open a workspace beside another, use workspace_open with beside.',
        props: { action: { type: 'string', enum: ['alone', 'close', 'swap', 'stack', 'side_by_side', 'focus'] }, workspace: str(ON_SCREEN) },
        required: ['action'],
        run: (a) => askWindow('layout', a),
      },
      {
        name: 'ui_find',
        description: "Find elements on a workspace's running page, as the user sees it now. selector: a CSS selector; text: words they show; both: what the selector matches that holds the text. Text alone gives the smallest elements holding it. Neither gives an outline of the page: the outermost element of each component. Each comes with a ref for ui_highlight, its text, classes, components and whether it is in view. Read the code too to know the class names.",
        props: { workspace: str(ON_SCREEN), selector: str('A CSS selector, e.g. ".card"'), text: str('Words the element shows'), limit: { type: 'number', description: 'At most this many (default 60)' } },
        readOnly: true,
        run: (a) => askWindow('find', a),
      },
      {
        name: 'ui_highlight',
        description: 'Outline elements on a workspace\'s page for the user, with a short question on it, to check what they mean before changing it: "This card?". One element, or up to 9 numbered when it could be any of them ("Which one?"). By refs from ui_find, or by selector and text (the first match). It stays until ui_clear or the next highlight. Ask the same question in your reply and end your turn; their answer is the next message.',
        props: { workspace: str(ON_SCREEN), refs: { type: 'array', items: { type: 'string' }, description: 'Refs from ui_find' }, selector: str('A CSS selector'), text: str('Words the element shows'), label: str('The question on it, a few words: "This card?"') },
        run: (a) => askWindow('highlight', a),
      },
      {
        name: 'ui_clear',
        description: 'Take away what ui_highlight outlined.',
        props: { workspace: str(ON_SCREEN) },
        run: (a) => askWindow('clear', a),
      },
      {
        name: 'window_reply',
        description: 'The window answering a request of the app connector.',
        props: { id: str('Request id'), ok: { type: 'boolean' }, data: { type: 'object' }, error: str('What went wrong') },
        required: ['id'],
        hidden: true,
        run: (a) =>
          sync(() => {
            const w = asked.get(String(a.id))
            if (!w) return { late: true }
            asked.delete(String(a.id))
            clearTimeout(w.timer)
            if (a.ok === false) w.reject(new Error(String(a.error ?? 'The window could not do it')))
            else w.resolve(a.data ?? {})
            return { delivered: true }
          }),
      },

      // ── marketplace
      {
        name: 'marketplace_list',
        description: 'List UIs that can be forked into a workspace, with the connector URLs each one needs. source is where each comes from: local (your own shelf) or remote (the public marketplace, including official templates); creator is official, community or you; verified means checked by the Lynx team. Filter with query (words), tags, connector (a host such as github.com, or agents / app) and creator.',
        props: { query: str('Words in the name, description or tags'), tags: { type: 'array', items: { type: 'string' }, description: 'Every one of these tags' }, connector: str('A connector the template uses: its host (linear.app) or agents / app'), creator: { type: 'string', enum: ['official', 'community', 'you'] } },
        readOnly: true,
        run: (a) => sync(() => ({ items: marketplace.list().filter((i) => matches(i, { q: a.query, tags: a.tags, connector: a.connector, creator: a.creator })), marketplace: { api: marketplace.remote().api, status: marketplace.remote().status, error: marketplace.remote().error ?? null } })),
      },
      { name: 'marketplace_refresh', description: 'Ask the public marketplace for its list of templates again.', props: {}, readOnly: true, run: () => marketplace.refresh() },
      {
        name: 'marketplace_fork',
        description: 'Create a workspace from a template. Community templates require a successful host-started security review of the current version first. Each required alias is bound to the connector whose URL matches; pass connectors when several match, or for a requirement without a URL. Optional ones may stay unbound. Custom tools the item ships are installed if you have none by that name, with their schedules.',
        props: { item: str('Marketplace item id'), source: { type: 'string', enum: ['local', 'remote'], description: 'Which shelf, when the id is on more than one' }, name: str('Workspace name, not one another workspace has; left out, the item\'s name (numbered if taken)'), connectors: obj('alias -> connector id') },
        required: ['item'],
        run: (a, caller) => marketplace.fork({ item: a.item, source: a.source, name: a.name, connectors: a.connectors }).pipe(Effect.tap(announce(caller)), Effect.map((w) => workspaceView(w.id))),
      },
      { name: 'marketplace_review_start', description: 'Request the mandatory security review of a community template. Lynx starts a separate read-only reviewer with no connectors and fixed security instructions. Returns its session ID; use marketplace_review_status to check the result. You cannot supply an assessment or bypass the review.', props: { item: str('Template ID'), source: str('Template source'), harness: str('Agent harness'), model: str('Model'), effort: str('Effort'), conversation: str('Conversation tab') }, required: ['item', 'source', 'harness'], run: (a) => marketplace.startReview({ item: a.item, source: a.source, harness: a.harness, model: a.model, effort: a.effort, conversation: a.conversation }) },
      { name: 'marketplace_review_status', description: 'Whether this exact template version has completed its mandatory security review.', props: { item: str('Template ID'), source: str('Template source') }, required: ['item', 'source'], readOnly: true, run: (a) => marketplace.reviewStatus(a.source, a.item) },
      { name: 'marketplace_files', description: 'Every file of a marketplace item, as text: its code, manifest, custom tools and preview data. A file that is binary or over 2 MB comes without text.', props: { item: str('Marketplace item id'), source: str('local or remote (default remote)') }, required: ['item'], readOnly: true, run: (a) => marketplace.files(a.source ?? 'remote', a.item) },
      { name: 'marketplace_restore', description: 'Replace a forked workspace\'s code with the current marketplace version of the item it came from. Its own edits are lost; connector bindings are kept.', props: { workspace: str('Workspace id') }, required: ['workspace'], run: (a) => marketplace.restore(a.workspace).pipe(Effect.map((w) => workspaceView(w.id))) },
      { name: 'marketplace_publish', description: "Put a workspace on the user's own shelf (on this machine only, private) so it can be forked again. To publish to the public marketplace, use marketplace_stage.", props: { workspace: str('Workspace id'), name: str('Item name'), description: str('One line') }, required: ['workspace'], run: (a) => marketplace.publish({ workspace: a.workspace, name: a.name, description: a.description }) },
      {
        name: 'marketplace_stage',
        description: 'Start publishing a workspace to the public marketplace: copies its code, the custom tools it calls and a manifest.json into a folder of its own (the stage), which you review and clean up before handing it to the user with marketplace_submit. The workspace itself is not changed. Returns the stage id and folder.',
        props: { workspace: str('Workspace id'), template: str('Existing remote template ID to update; must belong to the signed-in publisher. Owned workspace origins are detected automatically.') },
        required: ['workspace'],
        run: (a) => marketplace.stage(a.workspace, a.template),
      },
      {
        name: 'marketplace_submit',
        description: 'As your final action after a short explanation, hand a stage to the user to publish: checks that it builds and that its manifest has a name and description, then shows the user the template and your report and asks them whether to publish it. You cannot publish it yourself. Refused, with the reason, when something needs fixing; fix it and submit again.',
        props: { stage: str('Stage id, from marketplace_stage'), report: str('For the user, in plain words: what you removed or changed and why, and anything they should know before it goes public. Markdown bullets are fine.') },
        required: ['stage', 'report'],
        run: (a) => marketplace.submit({ stage: a.stage, report: a.report }),
      },
      { name: 'marketplace_discard', description: 'Throw a stage away, unpublished.', props: { stage: str('Stage id') }, required: ['stage'], run: (a) => marketplace.discard(a.stage).pipe(Effect.map(() => ({ discarded: a.stage }))) },
      { name: 'marketplace_account', description: 'Show a secure marketplace sign-in/signup and unique handle card in the Lynx agent conversation. No credentials belong in chat. Explain the next step first, call this as your final action, then end your turn when waiting for the user; their Continue action resumes it. Returns current account readiness, never a token. Also use this to check publishing status.', props: {}, readOnly: true, run: () => sync(() => {
        const remote = marketplace.remote()
        return { configured: !!remote.api, ready: !!remote.account?.handle, handle: remote.account?.handle ?? null, publishing: remote.publishing.map((s) => ({ id: s.id, status: s.status })) }
      }) },
      { name: 'marketplace_upload', description: 'Publish a ready stage to the public marketplace, as the signed-in account.', props: { stage: str('Stage id') }, required: ['stage'], userOnly: true, run: (a) => marketplace.upload(a.stage) },
      { name: 'marketplace_login_start', description: 'Mail a one-time marketplace sign-in/signup code to an email address.', props: { email: str('Email') }, required: ['email'], userOnly: true, run: (a) => marketplace.startLogin(a.email) },
      { name: 'marketplace_login', description: 'Sign in to the public marketplace with the code mailed by marketplace_login_start, to publish.', props: { email: str('Email'), code: str('The one-time code from the email') }, required: ['email', 'code'], userOnly: true, run: (a) => marketplace.login({ email: a.email, code: a.code }) },
      { name: 'marketplace_claim_handle', description: 'Claim a unique public marketplace handle for the signed-in account.', props: { handle: str('3–30 letters, numbers or underscores, starting with a letter') }, required: ['handle'], userOnly: true, run: (a) => marketplace.claimHandle(a.handle) },
      { name: 'marketplace_logout', description: 'Sign out of the public marketplace.', props: {}, userOnly: true, run: () => marketplace.logout().pipe(Effect.map(() => ({ signedOut: true }))) },

      // ── the store: records. One store for the whole app, shared by every workspace, tool and agent.
      {
        name: 'db_get',
        description: 'Read one record from the store. The store is global: every workspace, custom tool and agent shares it, so collections are named for what they hold ("pr-reviews/seen"), not for who wrote them. Returns { value }, null when there is none. With at, the value as it was then.',
        props: { collection: str('Collection name'), key: str('Record key'), at: WHEN },
        required: ['collection', 'key'],
        readOnly: true,
        run: (a) => sync(() => ({ value: data.get(a.collection, a.key, a.at) })),
      },
      {
        name: 'db_put',
        description: 'Create or replace a record (any JSON value up to 1 MB). With if_absent, an existing record is left alone and returned with created: false: use that to claim something exactly once, e.g. a PR about to be reviewed.',
        props: { collection: str('Collection name'), key: str('Record key'), value: { description: 'Any JSON value except null' }, if_absent: { type: 'boolean', description: 'Only write when the key does not exist yet' } },
        required: ['collection', 'key', 'value'],
        run: (a, caller) => sync(() => data.put(a.collection, a.key, a.value, { ifAbsent: !!a.if_absent, by: caller.by })),
      },
      { name: 'db_delete', description: 'Delete a record.', props: { collection: str('Collection name'), key: str('Record key') }, required: ['collection', 'key'], run: (a, caller) => sync(() => ({ deleted: data.remove(a.collection, a.key, caller.by) })) },
      {
        name: 'db_query',
        description: 'List records of a collection as { items: [{ key, value, created_at, updated_at }], more }. Filter on fields of the value with where, on keys with prefix. Sorted by key unless order_by says otherwise.',
        props: {
          collection: str('Collection name'),
          where: { type: 'array', description: 'All must hold. field is a name or dotted path into the value ("author.login").', items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string', enum: ['=', '!=', '<', '<=', '>', '>=', 'in'], description: 'Default =' }, value: { description: 'What to compare with; a list for "in"' } }, required: ['field', 'value'] } },
          prefix: str('Only keys starting with this'),
          order_by: str('key (default), updated_at, created_at, or a field of the value'),
          desc: { type: 'boolean' },
          limit: { type: 'number', description: 'Default 100, at most 1000' },
          offset: { type: 'number' },
          updated_since: str('Only records written at or after this date and time'),
        },
        required: ['collection'],
        readOnly: true,
        run: (a) => sync(() => data.query(a as any)),
      },
      { name: 'db_collections', description: 'List the collections in the store with how many records each holds.', props: {}, readOnly: true, run: () => sync(() => ({ collections: data.collections() })) },
      {
        name: 'db_history',
        description: `Every version of one record, newest first, with when it was written and by whom (a workspace, a tool, a schedule, an agent). History is kept for ${RETENTION_DAYS} days.`,
        props: { collection: str('Collection name'), key: str('Record key'), limit: { type: 'number', description: 'Default 50' } },
        required: ['collection', 'key'],
        readOnly: true,
        run: (a) => sync(() => ({ versions: data.history(a.collection, a.key, a.limit) })),
      },
      {
        name: 'db_restore',
        description: `Put records back as they were at a past moment (within the last ${RETENTION_DAYS} days): one record, one collection, or with neither the whole store. Records created since then are removed. The restore is itself recorded, so it can be undone by restoring to a moment just before it. It does not undo what tools did outside the store.`,
        props: { at: WHEN, collection: str('Limit to this collection'), key: str('Limit to this record (needs collection)') },
        required: ['at'],
        run: (a, caller) =>
          sync(() => {
            if (a.key !== undefined && a.collection === undefined) throw new Error('key needs collection')
            return data.restore({ at: a.at, collection: a.collection, key: a.key, by: `restore by ${caller.by}` })
          }),
      },

      // ── the store: files
      {
        name: 'files_put',
        description: 'Save a file in the store (global, like records; name it like a path, "reports/2026-10/summary.md"). Give text, or base64 for anything binary. Up to 25 MB.',
        props: { name: str('File name, may contain /'), text: str('Text content'), base64: str('Binary content, base64'), content_type: str('MIME type; guessed as text/plain for text') },
        required: ['name'],
        run: (a, caller) =>
          sync(() => {
            if ((a.text === undefined) === (a.base64 === undefined)) throw new Error('Give exactly one of text or base64')
            return data.filePut(a.name, a.text !== undefined ? Buffer.from(String(a.text), 'utf8') : Buffer.from(String(a.base64), 'base64'), a.content_type ?? (a.text !== undefined ? 'text/plain' : undefined), caller.by)
          }),
      },
      {
        name: 'files_get',
        description: 'Read a file from the store: { name, size, content_type, updated_at } with text for textual content and base64 for anything else. With at, the file as it was then.',
        props: { name: str('File name'), encoding: { type: 'string', enum: ['text', 'base64'], description: 'Force one form' }, at: WHEN },
        required: ['name'],
        readOnly: true,
        run: (a) =>
          sync(() => {
            const f = data.fileGet(a.name, a.at)
            if (!f) throw new Error(`No file named ${a.name}`)
            const { data: bytes, ...meta } = f
            return (a.encoding ?? (isTextual(meta.content_type) ? 'text' : 'base64')) === 'text' ? { ...meta, text: bytes.toString('utf8') } : { ...meta, base64: bytes.toString('base64') }
          }),
      },
      { name: 'files_list', description: 'List files in the store, optionally only names starting with prefix.', props: { prefix: str('Name prefix, e.g. "reports/"') }, readOnly: true, run: (a) => sync(() => ({ files: data.fileList(a.prefix) })) },
      { name: 'files_delete', description: 'Delete a file from the store.', props: { name: str('File name') }, required: ['name'], run: (a, caller) => sync(() => ({ deleted: data.fileRemove(a.name, caller.by) })) },
      { name: 'files_history', description: `Every version of one file, newest first, with when and by whom. Kept for ${RETENTION_DAYS} days; read an old version with files_get and at.`, props: { name: str('File name'), limit: { type: 'number' } }, required: ['name'], readOnly: true, run: (a) => sync(() => ({ versions: data.fileHistory(a.name, a.limit) })) },
      { name: 'files_restore', description: 'Put files back as they were at a past moment: one file, or with no name all of them.', props: { at: WHEN, name: str('Limit to this file') }, required: ['at'], run: (a, caller) => sync(() => data.fileRestore({ at: a.at, name: a.name, by: `restore by ${caller.by}` })) },

      // ── custom tools: JavaScript that calls other tools, and schedules that run it
      { name: 'tool_guide', description: 'The reference for writing custom tools: the file format, what code can call, limits, schedules, how to test. Read it before tool_save.', props: {}, readOnly: true, run: () => sync(() => ({ guide: readFileSync(join(cfg.appRoot, 'resources', 'TOOLS.md'), 'utf8'), dir: custom.dir })) },
      { name: 'tool_list', description: 'List custom tools with their descriptions, input schemas, schedules, and any load error. They are called on the "tools" connector.', props: {}, readOnly: true, run: () => sync(() => ({ dir: custom.dir, tools: custom.list().map((t) => toolView(t.name)) })) },
      { name: 'tool_get', description: 'Read one custom tool: its source, description, input schema and schedules.', props: { name: str('Tool name') }, required: ['name'], readOnly: true, run: (a) => sync(() => ({ ...toolView(a.name), source: custom.source(a.name) })) },
      {
        name: 'tool_save',
        description: 'Create or replace a custom tool. source is an ES module that default-exports an async function taking the input object, and may export description and input (a JSON Schema). Nothing is saved when the code does not load; the error says why. Then run it once through the tools connector to test it. Read tool_guide first.',
        props: { name: str('Lower-case letters, digits and underscores, e.g. check_new_prs'), source: str('The JavaScript') },
        required: ['name', 'source'],
        run: (a) => custom.save(a.name, a.source),
      },
      { name: 'tool_delete', description: 'Delete a custom tool. Its schedules stay and fail until removed or the tool is saved again.', props: { name: str('Tool name') }, required: ['name'], run: (a) => custom.remove(a.name).pipe(Effect.map((deleted) => ({ deleted }))) },
      {
        name: 'tool_runs',
        description: 'Recent runs of custom tools, newest first: who started each (a workspace, an agent, a schedule, another tool), how long it took, the result or error, console output, and every call it made. Look here when a tool or schedule misbehaves.',
        props: { tool: str('Only this tool'), limit: { type: 'number', description: 'Default 20, at most 200' } },
        readOnly: true,
        run: (a) => sync(() => ({ runs: custom.runs({ tool: a.tool, limit: a.limit }) })),
      },
      { name: 'schedule_list', description: 'List the schedules that run custom tools, with when each runs next and how its last run went. (Schedules that start agents directly are on the agents connector.)', props: {}, readOnly: true, run: () => sync(() => ({ schedules: custom.schedules() })) },
      {
        name: 'schedule_save',
        description: 'Run a custom tool on a schedule, or change one (same id). cron has five fields in local time: minute hour day-of-month month day-of-week, e.g. "*/10 * * * *" every ten minutes, "0 9 * * 1-5" weekdays at nine. For more often than once a minute, put a seconds field first (six fields): "*/5 * * * * *" every five seconds, "* * * * * *" every second. Runs happen while Lynx is open; one missed while it was closed runs once at the next launch. A schedule never overlaps itself.',
        props: { id: str('Name of the schedule; defaults to the tool name'), tool: str('Custom tool to run'), cron: str('Cron expression: five fields, or six with seconds first'), args: obj('Arguments passed to the tool on every run', true), enabled: { type: 'boolean', description: 'false pauses it' } },
        required: ['tool', 'cron'],
        run: (a) =>
          sync(() => {
            toolView(a.tool)
            return custom.saveSchedule({ id: a.id, tool: a.tool, cron: a.cron, args: a.args, enabled: a.enabled })
          }),
      },
      { name: 'schedule_delete', description: 'Remove a schedule.', props: { id: str('Schedule id') }, required: ['id'], run: (a) => sync(() => ({ deleted: custom.removeSchedule(a.id) })) },

      // ── notifications: what happened while the user was looking elsewhere
      // (Workspace code that names no workspace means its own: see `mine` below. It never reaches every workspace's by leaving the argument out.)
      {
        name: 'notification_send',
        description: `Tell the user something happened that concerns a workspace: a review finished, a check failed, new items arrived. It raises the unread count on the bell and beside that workspace in the list of workspaces, and is listed in the notifications drawer until read. text is one or two plain sentences (at most ${MAX_TEXT} characters). link is where clicking it goes: a page of the workspace as its routes define them ("/prs/42"), or an http(s) address. For a passing remark that need not be kept, use notify.`,
        props: { workspace: str('Workspace id the notification is about'), text: str('What happened, in a sentence or two'), link: str('Optional: a page of the workspace ("/prs/42") or an http(s) address') },
        required: ['workspace', 'text'],
        run: (a, caller) =>
          sync(() => {
            const w = workspaceView(a.workspace)
            return { notification: notifications.send({ workspace: w.id, text: a.text, link: a.link, by: caller.by }), unread: notifications.list({ workspace: w.id, unread: true, limit: 500 }).length, name: w.name }
          }).pipe(
            // Said once in passing as well, for whoever is at the window right now.
            Effect.tap((r) => events.publish({ t: 'toast', tone: 'info', text: `${r.name}: ${r.notification.text.length > 140 ? `${r.notification.text.slice(0, 140)}…` : r.notification.text}` })),
            Effect.map(({ name: _name, ...r }) => r),
          ),
      },
      {
        name: 'notification_list',
        description: 'List notifications, newest first: { id, workspace, text, link, by, at, read }. Of one workspace, or all of them. Called from a workspace UI without a workspace, it means that workspace.',
        props: { workspace: str('Only this workspace'), unread: { type: 'boolean', description: 'Only unread ones' }, limit: { type: 'number', description: 'Default 100, at most 500' } },
        readOnly: true,
        run: (a, caller) => sync(() => ({ notifications: notifications.list({ workspace: mine(a.workspace, caller), unread: !!a.unread, limit: a.limit }) })),
      },
      {
        name: 'notification_read',
        description: 'Mark notifications as read: one by id, all of a workspace, or with neither every one. Called from a workspace UI without a workspace, it only reaches that workspace\'s own.',
        props: { id: { type: 'number', description: 'One notification' }, workspace: str('Every notification of this workspace') },
        run: (a, caller) => sync(() => ({ read: notifications.markRead({ id: a.id, workspace: mine(a.workspace, caller) }) })),
      },
      {
        name: 'notification_delete',
        description: 'Remove notifications: one by id, all of a workspace, or with neither every one. Called from a workspace UI without a workspace, it only reaches that workspace\'s own.',
        props: { id: { type: 'number', description: 'One notification' }, workspace: str('Every notification of this workspace') },
        run: (a, caller) => sync(() => ({ deleted: notifications.remove({ id: a.id, workspace: mine(a.workspace, caller) }) })),
      },

      // ── settings
      {
        name: 'design_system_get',
        description: "The user's design system: markdown describing how every workspace should look (colour, type, spacing, components, tone of the words). Read it before writing or restyling any workspace UI and follow it; where it is silent, use the kit's defaults. markdown is empty when the user has not written one.",
        props: {},
        readOnly: true,
        run: () =>
          sync(() => {
            const markdown = settings.get().designSystem
            return { markdown, updated_at: settings.designUpdatedAt(), file: settings.designFile, ...(markdown ? {} : { note: "No design system is set. Use the kit's components and --sb-* variables as they are." }) }
          }),
      },
      {
        name: 'design_system_set',
        description: 'Replace the design system (markdown) that every workspace should follow. It is the user\'s: change it only when they ask, and send the whole document. An empty string removes it.',
        props: { markdown: str('The whole design system, as markdown') },
        run: (a) => sync(() => ({ markdown: settings.setDesignSystem(a.markdown ?? '').designSystem, updated_at: settings.designUpdatedAt() })),
      },
      {
        name: 'theme_set',
        description: `Choose the app's theme: how Lynx's own pages look (the window, the agent panel, settings). Workspaces, Home included, keep their own look, so the two are easy to tell apart; to restyle those, use the design system. It is the user's choice: change it only when they ask. ${THEMES.map((t) => `${t.id}: ${t.about}`).join(' ')}`,
        props: { theme: { type: 'string', enum: THEMES.map((t) => t.id) } },
        required: ['theme'],
        run: (a) => sync(() => ({ theme: settings.setTheme(a.theme).theme })),
      },
      {
        name: 'mode_set',
        description: "Light or dark for the whole window: the app's own pages and every workspace in it. system follows the computer's setting. It is the user's choice: change it only when they ask.",
        props: { mode: { type: 'string', enum: MODES.map((m) => m.id) } },
        required: ['mode'],
        run: (a) => sync(() => ({ mode: settings.setMode(a.mode).mode })),
      },
      {
        name: 'layout_set',
        description: `Where things sit in Lynx's window. workspaces: where the list of workspaces is (${WORKSPACE_PLACES.map((p) => `${p.id}: ${p.about}`).join(' ')}). agent: where the agent is (${AGENT_PLACES.map((p) => `${p.id}: ${p.about}`).join(' ')}). It is the user's choice: change it only when they ask.`,
        props: { workspaces: { type: 'string', enum: WORKSPACE_PLACES.map((p) => p.id) }, agent: { type: 'string', enum: AGENT_PLACES.map((p) => p.id) } },
        run: (a) => sync(() => ({ layout: settings.setLayout({ workspaces: a.workspaces, agent: a.agent }).layout })),
      },
      {
        name: 'background_set',
        description: "What Lynx's background service does when the window is not open. keep_running: quitting Lynx leaves agents, schedules and connectors running (off: quitting stops them). start_at_login: the service starts when the user logs in, so schedules run without opening Lynx. They are the user's choice: change them only when they ask.",
        props: { keep_running: { type: 'boolean' }, start_at_login: { type: 'boolean' } },
        run: (a) => sync(() => ({ background: settings.setBackground({ keepRunning: a.keep_running, startAtLogin: a.start_at_login }).background })),
      },
      {
        name: 'execution_set',
        description: 'Set the local agents connector\'s simultaneous agent runs and shell commands. Applies immediately; lowering a limit lets running work finish. Dev servers count as shell commands. Saved choices override AGENTD_CONCURRENCY and AGENTD_SHELL_CONCURRENCY. These are the user\'s choices: change them only when asked.',
        props: { agents: { type: 'integer', minimum: 1, maximum: MAX_EXECUTION.agents }, shell: { type: 'integer', minimum: 1, maximum: MAX_EXECUTION.shell } },
        run: (a) => sync(() => ({ execution: settings.setExecution({ agents: a.agents, shell: a.shell }).execution })),
      },

      // ── small things UIs need
      { name: 'request_access', description: 'For workspace UIs: ask the user to let this workspace see and control every agent conversation on this computer, not only the ones it started. Resolves once they agree.', props: { scope: { type: 'string', enum: ['all-sessions'] } }, required: ['scope'], run: () => sync(() => ({ granted: true })) },
      { name: 'notify', description: 'Show a short message in the app window for a few seconds. It is not kept; for something the user should find later, use notification_send.', props: { text: str('Message'), tone: { type: 'string', enum: ['info', 'good', 'bad'] } }, required: ['text'], run: (a) => events.publish({ t: 'toast', tone: a.tone ?? 'info', text: String(a.text) }).pipe(Effect.map(() => ({ shown: true }))) },
      { name: 'kit_guide', description: "The reference for writing workspace UI code: the lynx module, hooks, components, conventions. Also returns design_system, the user's own rules for how workspaces look (null when none); follow it.", props: {}, readOnly: true, run: () => sync(() => ({ guide: readFileSync(join(cfg.appRoot, 'resources', 'KIT.md'), 'utf8'), design_system: settings.get().designSystem || null })) },
    ]

    const info: ToolInfo[] = tools.filter((t) => !t.userOnly && !t.hidden).map((t) => ({ name: t.name, description: t.description, readOnly: !!t.readOnly, inputSchema: { type: 'object', properties: t.props, required: t.required ?? [], additionalProperties: false } }))
    connectors.registerInternal(NATIVE_APP, 'Lynx', {
      tools: () => info,
      call: (name, args, caller) => {
        const tool = tools.find((t) => t.name === name)
        // The window's own calls come as the user; agents, tools and workspace code never do.
        if (!tool || (tool.userOnly && caller.by !== 'user')) return Promise.reject(new Error(`The app connector has no tool named ${name}`))
        const missing = (tool.required ?? []).filter((k) => args[k] === undefined || args[k] === '')
        if (missing.length) return Promise.reject(new Error(`${name} is missing: ${missing.join(', ')}`))
        return Effect.runPromise(tool.run(args, caller))
      },
    })
    return AppConnector.of({ tools: info })
  }),
)
