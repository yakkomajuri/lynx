# Writing a Lynx workspace

A workspace is this folder. `App.jsx` default-exports a React component and that component is the
whole screen. Agents change it in a draft (a copy of this folder from `workspace_draft` on the `app`
connector) and put it on screen with `workspace_publish`; a file saved in this folder itself rebuilds
and reloads at once. Split code into as many files as you like (`.jsx`, `.tsx`, `.css`, images);
import them relatively.

You may write any React and any CSS. `react`, `recharts`, and `react-markdown` can be imported
directly. Everything below comes from the `lynx` module and is optional convenience, except
`call`, which is the only way to reach data.

```jsx
import { useTool, Page, Card, Table, Query } from 'lynx'

export default function App() {
  const prs = useTool('github', 'list_pull_requests', { owner: 'acme', repo: 'web', state: 'open' })
  return (
    <Page title="Open pull requests">
      <Card pad={false}>
        <Query q={prs}>{(rows) => <Table rows={rows} columns={[{ key: 'number' }, { key: 'title' }]} />}</Query>
      </Card>
    </Page>
  )
}
```

## Connectors

All data and every side effect goes through a connector: an MCP server. `workspace.json` binds
aliases to the user's connectors (`"connectors": { "github": "github-work" }`); UI code uses the
alias, so the same code works against another account by changing the binding.

Three connectors always exist:

- `app`: Lynx itself (workspaces, connectors, marketplace, the store, custom tools,
  notifications, the design system).
- `agents`: headless-cloud-agents on this machine (sessions, runs, shell, files, schedules).
- `tools`: the user's custom tools, JavaScript that calls other tools. See "Custom tools" below.

An HTTP API with no MCP server can be a connector too (an API connector, `transport: "api"`). It
has one tool, `request`: `call('typefully', 'request', { method: 'POST', path: '/v1/drafts', query,
headers, body })` resolves to `{ status, ok, headers, body }`, the body parsed when it is JSON. The
key is added by the app; a status of 400 or more is an answer (`ok: false`), not a thrown error.

### The manifest

`workspace.json` lists every tool the UI calls, under `uses`. It is how anyone can see at a glance
what a workspace touches, and it is enforced: a call that is not listed fails with a message
naming the line to add. Keep it in step with the code; adding to it is normal.

```json
"connectors": { "github": "github-work" },
"uses": {
  "github": ["search_pull_requests", "pull_request_read"],
  "tools": ["check_new_prs"],
  "app": ["db_get", "db_put", "db_delete", "db_query"],
  "agents": ["session_start", "session_send", "session_history"]
}
```

Keys are the connector names the code uses (an alias, or `app`, `agents`, `tools`); a value is a
list of tool names or `"*"` for every tool. Edit the file directly, or use `workspace_update`.
The kit's helpers make calls too, so list what you use:

- `useStored` → `app`: `db_get`, `db_put`, `db_delete`.
- `notifyUser`, `useNotifications` → `app`: `notification_send`, `notification_list`,
  `notification_read`.
- `agents.start` → `agents`: `session_start`; `agents.send` → `session_send`; `agents.info`,
  `useSessionInfo` → `session_get`; `agents.setConnectors` → `session_connections_set` (`agents.grant`
  adds `session_get`); `agents.cancel` → `run_cancel`; `agents.archive` → `session_archive`;
  `agents.respond` → `input_respond`; `agents.list`, `useSessions` → `session_list`; `useSession` →
  `session_history`; `useProviders` → `server_status`; `agents.requestAll` → `app`: `request_access`.
- `<Transcript>` → `agents`: `event_payload`, `input_respond`, `session_send`, `session_get`,
  `session_connections_set`; and `app`: `connector_reconnect`, `connector_update` (as `<ConnectCard>`).
- List exactly the tools the code calls. `"*"` works in your own workspace, but a template published
  to the marketplace must list each tool.
- `connector_list` on `app` (behind `useConnectors`) is always allowed.

**Never guess what a tool returns.** Before writing code against a connector, use the `app`
connector from your own tools: `connector_tools` for names and input schemas, then `connector_call`
to see a real response. `connector_call` returns exactly what `call()` gives UI code.

### `call(connector, tool, args?) → Promise<data>`

Calls a tool. Resolves with structured content if the server sent any, else the text parsed as
JSON, else the raw text. Rejects with an `Error` when the tool reports one. Many servers return
prose or markdown rather than JSON: check with `connector_call`, and parse or render accordingly.

### `useTool(connector, tool, args?, { refresh?, enabled?, staleMs? })`

Reads and caches. Returns `{ data, error, loading, fetching, reload }`. Cached by connector, tool
and args, shared across components, shown instantly on remount. `staleMs` defaults to 2000.
For external MCP tools declared read-only and HTTP API GET/HEAD requests, the service also shares
answers and in-flight reads across frames and rebuilds, honoring `staleMs` up to ten minutes.
`reload()` and `refresh: 15000` polling request fresh data. `enabled: false` waits (for example
until an id is known).

Workspace errors, connector status and other app metadata changes do not refetch external data.
Declared writes through `call()` invalidate and refresh that connector's queries; reconnecting
retries only failed queries. Upstream rate limits apply a shared cooldown: show the returned error
and offer Retry instead of starting an immediate retry loop. Use `useAction` and `call()` for writes.

Queries on the native `tools` connector refresh when custom-tool definitions are saved, edited on
disk or removed. Connector recovery also retries failed custom-tool queries. Tool-run bookkeeping
does not refresh them, so a query cannot retrigger itself just by completing a run.

### `useAction(fn)` → `{ run, running, error }`

For things that change the world: `const merge = useAction((n) => call('github', 'merge_pull_request', { … }))`.

### Other

- `useStored(key, initial, { collection? })` → `[value, set]`: state that survives reloads, kept in
  the store under `ui/<workspace id>` unless you name a collection.
- `useConnectors()` → `{ connectors }` with `id, name, status, url, tool_count`.
- `useConnector(alias)` → `{ connector }`: show a "connect X" hint when `status !== 'connected'`.
- `workspace()` → `{ id, name, dir, connectors }`.
- `askAgent(prompt)`: open the sidebar with a draft for the user to review and send. Only for meta help: onboarding, building/configuring a workspace, or repairing its UI. Workspace messages cannot send sidebar prompts automatically.
- Always use agents-in-UI for operational tasks: run sessions through `agents` and show their progress, transcript, approvals, stop control and follow-ups in the workspace. `<AgentTask task="stable-operation-key" prompt="Context and error" />` provides an embedded conversation with an editable initial prompt, provider choice, Ask first permissions, and a saved session that reopens with the same task key. Scope keys to the affected record. Declare its tools: `app`: `connector_reconnect`, `connector_update`; `agents`: `server_status`, `session_list`, `session_start`, `session_history`, `session_send`, `input_respond`, `run_cancel`, `event_payload`, `session_get`, `session_connections_set`.
  Every error the user sees should offer "Ask the agent to fix it" through this (see Rules of thumb).
- `openWorkspace(id, path?)`, `openExternal(url)`, `toast(text, tone)`, `openConnectorDialog(preset?)`.
- `togglePoint()` (⌘E), `toggleAgent()` (⌘D, or ⌘T in installs from before ⌘D), `showConnectors()`, `showTemplates()`, `showSchedules()`, `openCommandBar()` (⌘K): the app's own controls, for guides and empty states.
- `useBusy(on)`: while `on`, a newly published version of this workspace waits off screen (the user
  gets an "Update now" banner) instead of reloading the page. Text the user is typing into a field
  already counts; use this for unsaved work the page cannot see: an editor's buffer, a draft kept
  only in React state, a drag under way. `useBusy(text !== saved)`.

## The store

One store for the whole app, on the `app` connector: JSON records in named collections
(`db_get`, `db_put`, `db_delete`, `db_query`, `db_collections`) and files (`files_put`,
`files_get`, `files_list`, `files_delete`). It is global: every workspace, custom tool and agent
reads and writes the same data. That is the point (a tool records, a workspace shows), so name
collections for what they hold (`pr-reviews/seen`), not for who wrote them.

```jsx
const seen = useTool('app', 'db_query', { collection: 'pr-reviews/seen', order_by: 'updated_at', desc: true })
// seen.data.items → [{ key, value, created_at, updated_at }]
```

Every write is kept for 30 days with who made it: `db_history` for one record, `db_restore` to put
a record, a collection or everything back as it was at a moment (`files_history`, `files_restore`
for files).

## Custom tools

When several calls belong together, or something should run on a schedule, write a custom tool:
one JavaScript file that calls other tools, saved with `tool_save` on the `app` connector and then
callable by any workspace as `call('tools', '<name>', args)`. **Read `tool_guide` on the `app`
connector before writing one.** Schedules (`schedule_save`) run a tool on a cron expression;
`tool_runs` shows what each run did.

## Pages and navigation

A workspace has an address, like a URL. Use it for anything with a list and a detail view.

```jsx
import { Routes, Link, useRoute, navigate } from 'lynx'

export default function App() {
  return <Routes routes={{ '/': Users, '/users/:id': User }} />
}
function Users() {
  return <Link to="/users/42">Ada</Link>          // or navigate('/users/42')
}
function User({ id, query }) { … }                 // path params arrive as props, plus `query`
```

- `useRoute()` → `{ path, query, navigate, back, setQuery }`. `setQuery({ tab: 'events' })` keeps
  filters and tabs in the address.
- `matchPath('/users/:id', path)` → params or `null`.
- `useTitle('Ada Lovelace')` names the current page. Call it on every page that is not the first.
- The window's title bar shows breadcrumbs: the workspace, then each page above the current one,
  then the current page, named by `useTitle`. A page counts as "above" when its address is a
  prefix of the current one and matches a route, so nest addresses the way the pages nest
  (`/users`, `/users/:id`, `/users/:id/orders/:order`). The address is restored after a
  rebuild or restart. Keep view state there (selected item, tab, filters), not in `useState`.

## Agents

Start and follow agents from UI code. These are plain calls on the `agents` connector.

```jsx
import { agents, useSession, useSessions, Transcript, Composer } from 'lynx'

const { session } = await agents.start({
  prompt: 'Review PR #42 in acme/web and summarise the risk',
  permission: 'allow',           // 'allow' | 'ask' | 'deny': these govern the agent's own tools only.
                                 // Connectors work in all three and can change things.
  harness: 'claude',             // or 'codex'
  cwd: '/abs/path',              // optional working directory
  labels: { kind: 'pr-review', pr: '42' },   // find it again with useSessions(labels)
})
```

- `useSessions(labels)` → `{ sessions, reload }`, newest first, each with `status` and `labels`.
- `useSession(id)` → `{ events, streaming, status, busy, pending, send, cancel, respond }`, live.
  `streaming` is the text of the answer being written right now; it empties when the whole
  message lands in `events`.
- `<Transcript sessionId session />` renders a conversation: streamed text, tool steps, approvals,
  and a connect card whenever the agent adds or needs a connector. When the user finishes connecting
  from that card, the conversation carries on by itself once the agent's turn is over (unless the
  user has written since, or stopped it). `<Composer onSend onStop busy>`
  is the message box; its children sit in the bar next to Send.
- Files: `const files = useAttachments()`, then `<Composer attachments={files} onSend={(text, attached) => …}>`
  takes pasted files and has a paperclip to pick them; spread `{...files.dropProps}` on the area that
  takes drops and add the class `sb-drop-over` while `files.over`. Pass `attached` on as
  `attachments` to `agents.start` or `send` (up to 20; send some text with them). The agent reads
  copies under `.agent-attachments/` in its working directory. `stageFile(file)` does the same for
  a `File` from anywhere else.
- `agents.send(id, prompt, { model, effort, attachments })`, `agents.cancel(runId)`, `agents.archive(id)`.
- Models: `useProviders()` → `{ providers }`, each `{ name, models }`; a model is
  `{ id, name, description, default, efforts, default_effort }`, where `efforts` are the effort
  levels it takes (`low` … `max`; how hard it thinks) and differ by model. Pass `model` and `effort`
  to `agents.start`, or to `send` to switch a running conversation from that message on.
  `chooseModel(provider, picked, info?.session)` → `{ model, effort, models, efforts }` settles
  what to run: the pick if the agent still offers it, else what the conversation uses, else the
  agent's defaults; use it so both are always set. `effortName('xhigh')` → "Extra high".
  `useSessionInfo(id)` → `{ info }` with `info.session.model`, `.effort`, `.harness` and `info.connection_ids`.
- Every agent can use every connector, always; there is nothing to grant.
- `<ConnectCard connector="id" sessionId? onConnected? />`: a connector with the button or token field needed to
  finish connecting it. `onConnected()` runs when the user connects it from the card. Use it wherever a UI depends on a connector that may not be signed in.

Typical pattern: a button on a row starts an agent with labels identifying the row; the row shows a
live badge from `useSessions(labels)` and links to a `/runs/:id` page with a `<Transcript>`.

## Components

Layout: `Page {title, subtitle, actions, wide}`, `Card {title, actions, pad}`, `Row`, `Stack`,
`Grid {min}`, `Tabs {value, onChange, options}`, `Modal`, `Details {summary}`.
Data: `Table {rows, columns: [{key, title, render, align, width}], onRow}`, `Stat {label, value, hint, tone}`,
`Badge {tone: neutral|good|bad|warn|live|accent}`, `Query {q, empty}` (loading/error/empty for a `useTool` result),
`Markdown` (fenced code is syntax-coloured), `Code {language, numbered}` (colours a string of js, ts,
json, python, bash, sql, css, html, yaml, diff, go, rust, java, ruby or markdown), `Time {value}` (relative), `rel(date)`, `fmt(number)`.
Charts: `LineChart {series: [{name, values}], labels}`, `BarChart {data: [{label, value}]}`, `Sparkline {values}`.
Forms: `Button {variant: default|primary|ghost|danger, size: 'sm', busy}`, `Input`, `Textarea`, `Select`, `Field {label, hint}`.
State: `Spinner`, `Empty {title, action}`, `ErrorNote {error, retry, fix}` (has "Ask the agent to fix it";
`fix` is extra context for the agent, or `false` to hide it).
Icons: `<Icon name size />` with `arrow-up, arrow-left, stop, plus, check, copy, chevron-down,
chevron-right, search, compose, sidebar, plug, archive, x, dots, spark, wrench, link`. `CopyButton {text}`.

CSS variables for your own styles: `--sb-bg`, `--sb-surface`, `--sb-surface-2`, `--sb-line`,
`--sb-rail`, `--sb-bubble`, `--sb-text`, `--sb-muted`, `--sb-faint`, `--sb-accent`, `--sb-good`, `--sb-bad`, `--sb-warn`,
`--sb-blue`, `--sb-radius`, `--sb-font`, `--sb-mono`. They follow light and dark mode; use them
instead of hard-coded colours.

The default look is a quiet canvas: the page is a grey floor (`--sb-bg`) and content sits on it in
white blocks (`--sb-surface`, `--sb-radius`) with no border or shadow; lines (`--sb-line`) only
divide rows inside a block. Headline figures are large and light (weight 400–450, tight letter
spacing), tabs are underlined, and the type is Geist (`--sb-font`). Workspace CSS should keep to
this so a workspace looks like the others and not like Lynx's own screens.

## The design system

The user may have written a design system in Settings: markdown saying how every workspace should
look (colour, type, spacing, components, wording). **Read it before writing or restyling UI**:
`design_system_get` on the `app` connector returns `{ markdown }`, and `kit_guide` returns it as
`design_system`. Follow it over the defaults described here; where it is silent, use the kit as it
is. Express its colours and sizes in the workspace's own CSS (overriding `--sb-*` variables on
`:root` restyles the kit's components too). Do not copy it into the workspace or change it unless
the user asks (`design_system_set`).

## Notifications

For things the user should hear about when they are looking elsewhere: a review finished, a check
failed, something new arrived. A notification belongs to a workspace; the list of workspaces shows the unread
count beside it, and the notifications drawer lists them. `link` is the page it is about, as a path
of this workspace's routes; clicking the notification opens the workspace there.

```jsx
await notifyUser('Review of PR #42 is ready', { link: '/prs/42' })   // this workspace
const { notifications, unread, markRead } = useNotifications()        // this workspace's own
```

From an agent or a custom tool it is `notification_send` on `app`: `{ workspace, text, link }`
(`notify(workspace, text, link)` inside a custom tool). Keep the text to a sentence or two (500
characters at most), and send one per thing worth opening, not one per event in a burst. `toast(text)`
is the passing kind: shown for a few seconds and not kept.

## UI that comes from a connector (MCP-UI)

Some tools return a ready-made interactive view (an embedded `ui://` resource). Render one with
`<McpUI connector="alias" tool="show_chart" args={{…}} />`, or pass a resource you already hold:
`<McpUI connector="alias" resource={resource} />`. It runs sandboxed; when it asks to call a tool,
the call goes to that same connector.

## Point mode

The user can switch on Point (⌘E) and click any element to hand it to you, with or without a note.
What they point at is not always something to change: it can be
a chart they want explained or looked into. Each element reaches you with its tag, classes, visible
text, selector and the React components around it, so give components real names and elements
meaningful class names.

## Rules of thumb

- Every read needs loading, empty and error states. `Query` gives you all three.
- Handle every error where it happens. For operational failures, show `AgentTask` or a dedicated
  embedded agent conversation with the error and task context. Use `ErrorNote` with `fix={false}`
  alongside it to avoid a second sidebar helper. Reserve `askAgent` and the default ErrorNote
  sidebar helper for meta workspace repair. Skip agent help for invalid user input.
- Do not fetch in loops per row when one tool call can return the list.
- Long lists: paginate or cap, and say that you did.
- After editing, check the build: `workspace_build` on the `app` connector (with your draft) reports
  compile errors; without a draft it reports the workspace on screen, with the last runtime error
  from the running UI. `held` there means your published version waits off screen while the user
  types; it is not a failure.
